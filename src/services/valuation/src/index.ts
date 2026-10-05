import {
  startTelemetry,
  awaitDependencies,
  createHttpMetrics,
  registerGauge,
  installCrashHandlers,
  installShutdownHandlers,
  listenHost,
  logUnretried,
  quiesceAndLog,
  sweepTally,
  trackedSweep,
  type NamedScheduler,
  flagOverrides,
  flagSnapshot,
} from '@n409/shared';

// OTel first so http/pg get instrumented before anything imports them (issue #4).
const telemetry = startTelemetry('valuation');

const { loadConfig } = await import('./config.js');
const { createPool, attachPoolErrorHandler, resolvePoolTuning } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { instrumentPool, QueryStats } = await import('./db/queryStats.js');
const { buildApp, buildEmailTransports, capTableSyncCredentials, hrisCredentials } = await import('./app.js');
const { runDueAutoEmails } = await import('./hooks/autoEmails.js');
const { retryFailedEmails } = await import('./hooks/emailRetry.js');
const { retryDueDeliveries } = await import('./hooks/partnerWebhooks.js');
const { runJobAlertScan, openJobAlerts, jobAlertRuleStates, JOB_ALERT_RULE_STATES } =
  await import('./hooks/jobAlerts.js');
const { JOB_SOURCES } = await import('./domain/jobQueue.js');
const { JOB_ALERT_KINDS } = await import('./domain/jobAlerts.js');
const { retryFailedPipelineRuns } = await import('./hooks/pipelineRetry.js');
const { runHousekeepingSweep } = await import('./hooks/housekeeping.js');
const { monitorPool, reportPoolFindings } = await import('./db/poolHealth.js');
const { reapStalePipelineRuns } = await import('./repos/pipelineRuns.js');
const { reapStaleAiJobs } = await import('./repos/aiJobs.js');
const { runDueCapTableSyncs } = await import('./routes/capTableSync.js');
const { runRetentionSweep } = await import('./routes/retention.js');
const { runDueHrisSyncs } = await import('./routes/hris.js');
const { autoPipelineConcurrency, pipelineRunsAwaitingSlot } = await import('./pipeline/autoPipeline.js');
const { probeReady } = await import('./clients/internal.js');

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
// Statement timing (db/queryStats.ts). Constructed before buildApp so the ops
// route and the instrumentation share one table, and instrumented immediately
// after so the migrations below — the first queries this process runs — are
// already covered.
const queryStats = new QueryStats();
// Checkout tracking (db/poolHealth.ts). Attached before `buildApp` so the ops
// route and the sweep below read one tracker, and before the migrations so a
// leak in the very first statements this process runs is still covered.
const poolHealth = monitorPool(pool, {
  max: resolvePoolTuning(config.DATABASE_URL).max,
  leakAfterMs: config.DB_LEAK_AFTER_MS,
  exhaustedAfterMs: config.DB_EXHAUSTED_AFTER_MS,
});
// `gateStartup` holds /ready shut until the dependency probes and migrations
// below have finished — see the gate's construction in app.ts.
const app = buildApp({ config, pool, queryStats, poolHealth, gateStartup: true });
instrumentPool(pool, { slowMs: config.DB_SLOW_QUERY_MS, log: app.log, stats: queryStats });
// `createPool` already left a listener on `error` so the pool is never
// listener-less; now that there is a log, swap it for one that says so.
attachPoolErrorHandler(pool, app.log);

// A stray rejection in any of the background timers below (auto-emails, the
// pipeline reaper, the cap-table/HRIS scans, retention, job alerts) would otherwise kill the
// process with nothing but a bare stack on stderr. Log it through pino first,
// then exit so systemd restarts us.
installCrashHandlers(app.log, {
  service: 'valuation',
  onShutdown: async () => {
    await app.close();
    await pool.end();
    await telemetry.shutdown();
  },
});

// RED metrics (audit B-3 §metrics): request rate/latency/errors by route, plus
// DB-pool and auto-pipeline saturation gauges. No-ops without an OTLP endpoint.
const httpMetrics = createHttpMetrics('valuation');
app.addHook('onResponse', (req, reply, done) => {
  httpMetrics.record({
    method: req.method,
    route: req.routeOptions?.url ?? req.url,
    statusCode: reply.statusCode,
    durationMs: reply.elapsedTime,
  });
  done();
});
registerGauge(
  'valuation',
  'db.pool.connections.total',
  'pg pool clients (in use + idle)',
  () => pool.totalCount,
);
registerGauge('valuation', 'db.pool.connections.idle', 'idle pg pool clients', () => pool.idleCount);
registerGauge(
  'valuation',
  'db.pool.connections.waiting',
  'requests waiting for a pg client',
  () => pool.waitingCount,
);
// The three gauges above say a pool is in trouble without saying why. These
// two say which of the two reasons it is: a checkout that has been held far
// longer than any statement should take is a leak, and a leak never recovers
// on its own (db/poolHealth.ts).
registerGauge(
  'valuation',
  'db.pool.checkouts.leaked',
  'connections checked out and never returned, cumulative',
  () => poolHealth.peek().leaksDetected,
);
registerGauge(
  'valuation',
  'db.pool.checkout.oldest_ms',
  'age of the longest-held checked-out connection',
  () => poolHealth.peek().oldestCheckoutMs,
);
// Slow statements since boot. A counter would be better shaped, but the table
// is already the source of truth and a gauge over it needs no second tally that
// could disagree with the endpoint ops actually read.
registerGauge('valuation', 'db.query.slow.total', 'statements over the slow-query threshold', () =>
  queryStats.top(Number.MAX_SAFE_INTEGER).reduce((n, s) => n + s.slowCount, 0),
);
registerGauge(
  'valuation',
  'auto_pipeline.runs.active',
  'in-flight auto-pipeline orchestrations',
  () => autoPipelineConcurrency().active,
);
registerGauge(
  'valuation',
  'auto_pipeline.runs.pending',
  'queued auto-pipeline orchestrations',
  () => autoPipelineConcurrency().pending,
);
// Realtime streams are capped per-user/per-room/per-process (realtime/hub.ts);
// this is the number those ceilings are measured against.
registerGauge(
  'valuation',
  'realtime.streams.open',
  'open per-valuation SSE connections',
  () => app.realtimeHub.stats().total,
);

/**
 * The same pool and query facts, on the scrape endpoint (`GET /metrics`).
 *
 * Every `registerGauge` above records into the OpenTelemetry API, which without
 * `OTEL_EXPORTER_OTLP_ENDPOINT` — unset on the deployed box — is a no-op
 * provider. `app.metrics` is the registry `buildApp` decorates, and it is read
 * by a scraper with no collector in the way. These four are here rather than in
 * `buildApp` because they are the composition root's: it owns the pool object
 * and the tuning the saturation is measured against.
 */
app.metrics.gauge('db_pool_connections_total', 'pg pool clients (in use + idle)', () => pool.totalCount);
app.metrics.gauge('db_pool_connections_idle', 'Idle pg pool clients', () => pool.idleCount);
app.metrics.gauge(
  'db_pool_connections_waiting',
  'Callers queued for a pg client — nonzero means the pool is saturated',
  () => pool.waitingCount,
);
// A checkout held far longer than any statement should take is a leak, and a
// leak never recovers on its own (db/poolHealth.ts). `peek()` rather than
// `sample()`: a scrape must not consume the once-only report the interval below
// exists to log, or a Prometheus poll would silence an operator's alert.
app.metrics.gauge(
  'db_pool_checkouts_leaked',
  'Connections checked out and never returned, cumulative',
  () => poolHealth.peek().leaksDetected,
);
app.metrics.gauge(
  'db_pool_checkout_oldest_seconds',
  'Age of the longest-held checked-out connection',
  () => poolHealth.peek().oldestCheckoutMs / 1000,
);
app.metrics.gauge('db_slow_queries', 'Statements over the slow-query threshold since boot', () =>
  queryStats.top(Number.MAX_SAFE_INTEGER).reduce((n, st) => n + st.slowCount, 0),
);

/**
 * Prove the dependencies are there before binding the port.
 *
 * Postgres was already an implicit startup check — `migrate` is the next line
 * and it cannot run without it — but only in the sense that the process
 * crash-loops until the database appears, with a migration stack trace as the
 * explanation. On a host reboot, where systemd starts this unit and Postgres at
 * roughly the same moment, that is the ordinary path and not an exotic one, and
 * the restart budget is finite: enough loops and systemd gives up on the unit
 * entirely, so a database that was ten seconds late costs a service that is
 * down until somebody notices.
 *
 * So the wait is explicit and bounded, and the log line says which dependency
 * is missing rather than leaving it to be read out of a stack.
 *
 * The AI and engine services are deliberately *not* required. With either down
 * this service still lists valuations, renders reports, takes payments and
 * serves every page that never needed a model — refusing to boot would convert
 * a degraded feature into a total outage, which is the exact failure this
 * round is against. They are probed anyway, so the degraded set is stated at
 * boot rather than discovered by a user.
 */
const dependencies = await awaitDependencies({
  timeoutMs: config.STARTUP_DEPENDENCY_TIMEOUT_MS,
  log: app.log,
  checks: [
    {
      name: 'postgres',
      required: true,
      probe: async () => {
        await pool.query('SELECT 1');
      },
    },
    { name: 'ai', required: false, probe: () => probeReady('ai', config.AI_URL) },
    { name: 'engine', required: false, probe: () => probeReady('engine', config.ENGINE_URL) },
  ],
});

if (!dependencies.ok) {
  app.log.error(
    { missing: dependencies.missing, elapsedMs: dependencies.elapsedMs, alert: true },
    'required dependencies are unavailable — refusing to start',
  );
  // swallow: shutdown. Nothing is left that could act on the failure, and the
  // logger is going down with the process.
  await pool.end().catch(() => {});
  // swallow: shutdown, as above.
  await telemetry.shutdown().catch(() => {});
  // Non-zero so systemd restarts us rather than recording a clean exit — the
  // database being late is precisely the case a restart fixes.
  process.exit(1);
}
if (dependencies.degraded.length > 0) {
  app.log.warn(
    { degraded: dependencies.degraded },
    'starting with optional dependencies unavailable — the features that need them will report themselves unavailable',
  );
}

await migrate(pool, {
  // Progress, and only progress. Every line this channel carries used to go out
  // under the fixed message "migration applied", which made "waiting for the
  // migration lock" and "could not release the migration lock" both announce a
  // migration that had been applied (R337, methodology M11). The step is in
  // `migration`; the title says what kind of line this is and no more.
  log: (msg) => app.log.info({ migration: msg }, 'migration runner'),
  // `logUnretried` rather than a level chosen here: the run survived, nothing
  // revisits this, and the cost lands on a *later* deploy — a lock left on a
  // pooled connection of a healthy service, which every subsequent boot then
  // waits out and dies against. That is the definition this estate uses for the
  // `alert: true` flag, and picking `warn` because the cause was a busy pool
  // would promise a retry that does not exist.
  onIssue: (msg, err) => logUnretried(app.log, err, { migration: 'lock_release' }, msg),
});
// `/ready` has been answering 503 since the server object existed; this is what
// lets it go green. Everything above — the dependency probes and the migrations
// — happens while readiness is still red, so the load balancer cannot route a
// request into the middle of a schema change.
app.startupGate.markReady();
await app.listen({ port: config.PORT, host: listenHost() });
app.log.info({ port: config.PORT }, 'valuation service listening');

// Which flags this process actually booted with.
//
// "Are the breakers on?" is asked during an incident, and the honest answer
// otherwise requires reading a file on the host and knowing what unset means —
// two steps that are wrong more often than they are right at 3am. Emitting it
// once at boot puts the answer in the same log the incident is already being
// read in. Logged at warn when anything departs from its default, because a
// process running with a kill switch thrown is a fact worth surfacing above the
// routine boot chatter — a flag left off after an incident is exactly the kind
// of thing nobody notices for a month.
{
  const overrides = flagOverrides();
  const flags = flagSnapshot();
  if (overrides.length > 0) app.log.warn({ flags, overrides }, 'feature flags: not all defaults');
  else app.log.info({ flags }, 'feature flags');
}

/**
 * This process's own settings store, shared by the transports (`Reply-To`) and
 * the drip scan (`{{support_email}}`).
 *
 * Its own instance rather than a reach into `buildApp`: these are sweeps on the
 * same pool, and the store is a 5s cache over one row. Hoisted above the
 * transports because they read the support address off it on every send.
 */
const { SystemSettingsStore } = await import('./repos/systemSettings.js');
const sweepSettings = new SystemSettingsStore(pool, undefined, undefined, app.log);

const emailTransports = buildEmailTransports(config, app.log, sweepSettings);

/**
 * Every background sweep this process runs, so shutdown can wait for the one
 * that is mid-flight.
 *
 * `clearInterval` only stops the next tick; see the note in shared/scheduler.ts
 * for what the *current* one costs when the pool is ended out from under it —
 * measured, it is a claimed outbox row whose message has already left SMTP and
 * whose completion never landed, which the next sweep sends again.
 *
 * Registered at construction rather than collected at shutdown so a sweep added
 * later cannot be forgotten: the `track` call is on the same line as the
 * `setInterval` it belongs to.
 */
const sweeps: NamedScheduler[] = [];
const skipCounters: Array<{ name: string; skipped: () => number }> = [];
/** The health half of the same roster: ticks attempted, and ticks that failed. */
const runCounters: Array<{ name: string; started: () => number; failed: () => number }> = [];
const track = <
  T extends { running: boolean; whenIdle(): Promise<void>; skipped: number; started: number; failed: number },
>(
  name: string,
  scheduler: T,
): T => {
  sweeps.push({ name, scheduler });
  skipCounters.push({ name, skipped: () => scheduler.skipped });
  runCounters.push({ name, started: () => scheduler.started, failed: () => scheduler.failed });
  return scheduler;
};

/**
 * Every sweep this process knows how to run, whether or not this deployment
 * runs it.
 *
 * Six of the eleven are behind a `_MINUTES > 0` switch, and a sweep that is
 * switched off is not *registered* — so it is absent from `track`, absent from
 * the four gauges built off that roster, and therefore absent from the scrape
 * entirely. A missing series is not a series reading zero: `SweepStopped` was
 * written for exactly this case ("the timer was never scheduled, or the
 * interval is configured to zero") and could not express it, because
 * `rate(background_sweep_runs_total[1h]) == 0` matches nothing when there is no
 * `background_sweep_runs_total` for that sweep at all. The six behind the switch
 * are every retry ladder the platform has.
 *
 * So the roster is declared, and `background_sweep_enabled` carries a reading
 * for each name whether or not anything scheduled it. Being off is a supported
 * configuration ([[optional capabilities]]), which is why this is a gauge and a
 * boot line rather than an alert: what was missing is not a rule saying "this
 * must be on", it is any way at all to tell "off" from "gone".
 *
 * `scheduledSweepRoster.test.ts` holds this equal to the `scheduleSweep` calls
 * below, in both directions.
 */
const SWEEP_ROSTER = [
  'auto-email',
  'email-retry',
  'webhook-retry',
  'pipeline-reaper',
  'ai-job-reaper',
  'cap-table-sync',
  'hris-sync',
  'job-alerts',
  'retention',
  'pipeline-retry',
  'housekeeping',
] as const;

app.metrics.gauge(
  'background_sweep_enabled',
  '1 for a sweep this process scheduled, 0 for one its configuration turned off',
  () =>
    SWEEP_ROSTER.map((name) => ({
      value: sweeps.some((s) => s.name === name) ? 1 : 0,
      labels: { sweep: name },
    })),
  ['sweep'],
);

// What the ticks *did*, as opposed to whether they ran. Cumulative and keyed on
// the tally field name, so `rate(background_sweep_items_total{outcome="failed"})`
// against the same sweep's `attempted` is the question an outbox outage answers
// yes to and the three gauges around it cannot be asked at all.
const sweepItems = app.metrics.counter(
  'background_sweep_items_total',
  'Rows a background sweep put in each outcome, cumulative',
  ['sweep', 'outcome'],
);

// What the job monitor currently holds open, per queue.
//
// `auto_pipeline_runs_pending` above says the DB-backed backlogs — the outbox,
// the webhook deliveries, the job tables — are deliberately absent from this
// endpoint because a count query per scrape is the wrong shape and "the
// job-alert sweep already watches them on its own schedule". True, and the half
// that was missing is that the sweep reported its verdict to an in-app
// notification list, the admin trail and the journal: three channels, none of
// them the one an on-call rotation reads. A stalled outbox was decided on every
// five minutes and could not reach a rule.
//
// Read from the sweep's own snapshot, not from the database: a gauge's
// `collect` runs inside the scrape and must be cheap and synchronous. Empty
// until the first scan finishes, so "nothing has looked" cannot read as "no
// queue is in trouble" — that absence is `SweepStopped`'s question.
app.metrics.gauge(
  'job_queue_alert_open',
  'The job monitor is holding an alert open for this queue',
  () => {
    const open = openJobAlerts();
    const states = jobAlertRuleStates();
    if (open === null || states === null) return [];
    // Only for the queues the scan was in a position to say anything about. A
    // queue with no enabled rule produces no findings at all, so a 0 here would
    // be the same reading a healthy watched queue gives — see `ruleStates` in
    // hooks/jobAlerts.ts. The gauge below is what explains the absence, which
    // is what makes leaving it out honest rather than the missing series R321
    // argued against.
    return JOB_SOURCES.filter((source) => states[source] === 'enabled').flatMap((source) =>
      JOB_ALERT_KINDS.map((kind) => ({
        value: open.some((a) => a.source === source && a.kind === kind) ? 1 : 0,
        labels: { source, kind },
      })),
    );
  },
  ['source', 'kind'],
);

// And whether anything is watching that queue at all.
//
// The gauge above is the monitor's verdict; this is whether it reached one. A
// state-set rather than a 1/0, because the two ways a queue goes unwatched are
// different incidents: `disabled` is an operator's choice in the admin console
// and nothing alerts on it, the way nothing alerts on
// `background_sweep_enabled == 0`. `unconfigured` is a source in JOB_SOURCES
// with no row in `job_alert_rules` — nobody decided to stop watching it, a
// migration never seeded it, and it has been unwatched since it was added.
app.metrics.gauge(
  'job_queue_alert_rule',
  'Whether the job monitor has an enabled rule for this queue',
  () => {
    const states = jobAlertRuleStates();
    if (states === null) return [];
    return JOB_SOURCES.flatMap((source) =>
      JOB_ALERT_RULE_STATES.map((state) => ({
        value: states[source] === state ? 1 : 0,
        labels: { source, state },
      })),
    );
  },
  ['source', 'state'],
);

/**
 * A tracked, non-overlapping sweep whose failures are classified and alertable.
 *
 * The name is supplied once and reaches all three places that report on this
 * sweep — the two saturation gauges above and the failure line from
 * `sweepFailed` — so the `sweep` label in the metrics and the `sweep` field in
 * the log are the same string by construction. They were not before: the name
 * went to `track` as a value and into the failure handler as prose inside a
 * message ('HRIS sync scan failed' against a gauge labelled `hris-sync`), which
 * is two vocabularies for one thing and no way to notice they had drifted.
 *
 * Registering a sweep any other way is what this exists to prevent: every
 * background tick in this process now gets the alerting contract by
 * construction rather than by the next person remembering it — and, since
 * R206, the correlation too: `trackedSweep` binds `{ sweep, sweepRun }` for the
 * duration of the tick, so every line written *inside* it carries the same name
 * the gauges and the failure line use plus an id unique to this tick. Twelve
 * sweeps share this process and this logger; without that the interior lines
 * interleave with nothing to separate them.
 */
const scheduleSweep = (name: string, tick: () => Promise<unknown>) =>
  track(
    name,
    trackedSweep(app.log, name, async () => {
      const result = await tick();
      // The tally the tick already computed, counted rather than only logged.
      // See `sweepTally` for why the two gauges below cannot answer this: they
      // describe the *tick*, and every ladder here contains its per-row
      // failures on purpose, so a sweep whose every send, delivery or resume
      // failed returns normally and reads as an idle healthy one.
      for (const { outcome, value } of sweepTally(result)) sweepItems.inc({ sweep: name, outcome }, value);
      return result;
    }),
  );

// A scheduler that is routinely skipping ticks is one whose interval is too
// short for its work — `nonOverlapping` counts them precisely so that is
// visible from outside, and until now nothing read the count.
app.metrics.gauge(
  'background_sweep_skipped_total',
  'Background ticks dropped because the previous one was still running',
  () => skipCounters.map((s) => ({ value: s.skipped(), labels: { sweep: s.name } })),
  ['sweep'],
);
app.metrics.gauge(
  'background_sweep_running',
  'Background sweeps with a tick in flight right now',
  () => sweeps.map((s) => ({ value: s.scheduler.running ? 1 : 0, labels: { sweep: s.name } })),
  ['sweep'],
);
// The two above describe saturation, and until now they were the whole of what
// a scraper could see about this tier. A sweep failing on *every* tick reads
// through them as a healthy one: it fails and returns long before the next
// scrape, so `running` is 0, and nothing ever overlaps, so `skipped` is 0. The
// failure is classified and stamped `alert: true` in the log by `sweepFailed`,
// but the log is not what alerts here — this endpoint is — and this endpoint
// could not see it. Twelve sweeps, including every retry ladder the platform
// has, were in that blind spot.
//
// `started` is here for the denominator: without it, "failed twice since boot"
// and "has failed every tick for an hour" are the same number until you know
// the interval, which is configuration a dashboard does not have.
app.metrics.gauge(
  'background_sweep_runs_total',
  'Background ticks begun, cumulative — the denominator for the failure rate',
  () => runCounters.map((s) => ({ value: s.started(), labels: { sweep: s.name } })),
  ['sweep'],
);
app.metrics.gauge(
  'background_sweep_failures_total',
  'Background ticks that ended in a failure, cumulative',
  () => runCounters.map((s) => ({ value: s.failed(), labels: { sweep: s.name } })),
  ['sweep'],
);

// Drip campaign scan (§15.6). `nonOverlapping` keeps a slow scan from stacking
// ticks on this instance; overlap with the ops-triggered run and with other
// instances is the advisory lock's job, inside runDueAutoEmails. A failed scan
// logs and waits for the next tick.
let autoEmailTimer: NodeJS.Timeout | undefined;
if (config.AUTO_EMAIL_SCAN_MINUTES > 0) {
  const scan = scheduleSweep('auto-email', async () => {
    const r = await runDueAutoEmails({
      pool,
      ...emailTransports,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      settings: sweepSettings,
      log: app.log,
    });
    if (r.queued > 0 || r.skipped > 0) app.log.info(r, 'auto email scan');
    // `declined` flattened to a number so `sweepTally` can see it — the same
    // treatment, for the same reason, that the job-alert sweep's `skipped`
    // gets below: a pass that never ran reports the four zeros a healthy idle
    // pass reports, and this is the one field that separates them.
    return { ...r, declined: r.declined ? 1 : 0 };
  });
  autoEmailTimer = setInterval(() => scan.run(), config.AUTO_EMAIL_SCAN_MINUTES * 60_000);
}

// Failed-outbox retry sweep: transient SMTP failures otherwise sit as
// 'failed' forever with nothing else revisiting them (see hooks/emailRetry.ts).
let emailRetryTimer: NodeJS.Timeout | undefined;
if (config.EMAIL_RETRY_SCAN_MINUTES > 0) {
  const sweep = scheduleSweep('email-retry', async () => {
    const r = await retryFailedEmails({
      pool,
      ...emailTransports,
      log: app.log,
      maxAttempts: config.EMAIL_RETRY_MAX_ATTEMPTS,
    });
    if (r.attempted > 0) app.log.info(r, 'email retry sweep');
    return r;
  });
  emailRetryTimer = setInterval(() => sweep.run(), config.EMAIL_RETRY_SCAN_MINUTES * 60_000);
}

// Partner webhook retry sweep (0103): a delivery whose receiver was down keeps
// 'pending' with a backoff stamped on it; this is what comes back for it.
let webhookRetryTimer: NodeJS.Timeout | undefined;
if (config.WEBHOOK_RETRY_SCAN_MINUTES > 0) {
  const sweep = scheduleSweep('webhook-retry', async () => {
    const r = await retryDueDeliveries({ pool, log: app.log });
    // `reaped` and `withheld` too, not just `attempted`: a pass that settled
    // abandoned deliveries, or ended the ones a switched-off endpoint was
    // holding, and delivered nothing did the work this line reports on.
    if (r.attempted > 0 || r.reaped > 0 || r.withheld > 0) app.log.info(r, 'webhook retry sweep');
    return r;
  });
  webhookRetryTimer = setInterval(() => sweep.run(), config.WEBHOOK_RETRY_SCAN_MINUTES * 60_000);
}

// Auto-pipeline reaper (B-3 §auto-pipeline): sweep runs orphaned by a restart or
// wedged on a stuck upstream call. Run once at boot, then on an interval.
let reaperTimer: NodeJS.Timeout | undefined;
if (config.AUTO_PIPELINE_STALE_MINUTES > 0) {
  const olderThanMs = config.AUTO_PIPELINE_STALE_MINUTES * 60_000;
  const reaperActor = { actorType: 'system', actorId: 'reaper', source: 'auto-pipeline' } as const;
  // This is the longest tick of the six — a transaction that locks up to 100
  // stale runs and writes an audit event for each — and it is slowest exactly
  // when runs are wedged, which is the one time it runs at all. It used to be
  // the only scheduler here without the non-overlap guard, despite a comment
  // claiming it followed its siblings.
  const sweep = scheduleSweep('pipeline-reaper', async () => {
    const reaped = await reapStalePipelineRuns(pool, {
      olderThanMs,
      actor: reaperActor,
      // Runs this process has queued and not yet started are waiting, not
      // wedged, and their row cannot say so — see `pipelineRunsAwaitingSlot`.
      holding: pipelineRunsAwaitingSlot(),
    });
    if (reaped.length > 0) {
      app.log.warn({ count: reaped.length, runIds: reaped.map((r) => r.id) }, 'reaped stale pipeline runs');
    }
    return { reaped: reaped.length };
  });
  sweep.run();
  reaperTimer = setInterval(() => sweep.run(), Math.min(olderThanMs, 5 * 60_000));
}

// AI-job reaper (round 186): settle `ai_jobs` rows left at 'running' by a
// process that stopped existing mid-pipeline — which is every deploy that lands
// while an extraction is in flight. Unlike the pipeline reaper above this has no
// enable switch: the rows it settles are unsettleable by anything else, they
// hold this queue's stall alert open forever, and there is no deployment for
// which leaving them is the right answer. Runs at boot, because a restart is
// precisely what creates them, then every five minutes.
let aiJobReaperTimer: NodeJS.Timeout | undefined;
{
  const sweep = scheduleSweep('ai-job-reaper', async () => {
    const reaped = await reapStaleAiJobs(pool);
    if (reaped.length > 0) {
      app.log.warn({ count: reaped.length, jobIds: reaped.map((j) => j.id) }, 'reaped stale AI jobs');
    }
    return { reaped: reaped.length };
  });
  sweep.run();
  aiJobReaperTimer = setInterval(() => sweep.run(), 5 * 60_000);
}

// Cap-table sync scheduler (feature 4): pull connections whose daily/weekly
// cadence is due. A non-overlapping tick every 15 minutes; per-connection
// errors are recorded on the row and don't stop the scan.
let capTableSyncTimer: NodeJS.Timeout | undefined;
{
  const tick = scheduleSweep('cap-table-sync', async () => {
    const r = await runDueCapTableSyncs({ pool, credentials: capTableSyncCredentials(config), log: app.log });
    // Gated on `due`, not on the successes. A scan in which every provider
    // refused used to report the same number a scan with nothing due does —
    // zero — so it wrote no line and counted nothing, which is the blind spot
    // R321 built `background_sweep_items_total` to close. `failed` is what
    // `SweepWorkFailing` already reads; this sweep simply had no way to say it.
    if (r.due > 0) app.log.info(r, 'cap-table sync scan');
    return r;
  });
  capTableSyncTimer = setInterval(() => tick.run(), 15 * 60_000);
}

// HRIS/payroll sync scheduler (feature 11): pull due roster/grant connections.
let hrisSyncTimer: NodeJS.Timeout | undefined;
{
  const tick = scheduleSweep('hris-sync', async () => {
    const r = await runDueHrisSyncs({ pool, credentials: hrisCredentials(config), log: app.log });
    // See the cap-table scan above: gated on `due`, and carrying `failed`.
    if (r.due > 0) app.log.info(r, 'HRIS sync scan');
    return r;
  });
  hrisSyncTimer = setInterval(() => tick.run(), 15 * 60_000);
}

// Job-queue alert sweep (design §17.1 item 13): evaluate every queue's oldest
// outstanding job and failure count against its thresholds, and open/resolve
// alerts. Runs at boot — a queue that stopped while the service was down is
// exactly the case worth catching immediately — then every five minutes.
let jobAlertTimer: NodeJS.Timeout | undefined;
if (config.JOB_ALERT_SCAN_MINUTES > 0) {
  const sweep = scheduleSweep('job-alerts', async () => {
    const r = await runJobAlertScan({ pool, log: app.log });
    if (r.opened.length > 0 || r.resolved.length > 0) {
      app.log.info({ opened: r.opened.length, resolved: r.resolved.length }, 'job alert sweep');
    }
    // Flattened, because `sweepTally` is deliberately shallow and the number
    // that matters most in this sweep is a level down: `notified.failed` is
    // announcements still owed after the pass — an operator who has not been
    // told that a queue is stalled. This is the alerting subsystem reporting
    // its own failure, and it was reaching a scraper through nothing at all.
    return {
      opened: r.opened.length,
      resolved: r.resolved.length,
      announcements_failed: r.notified.failed,
      // A tick that declined because an ops-triggered scan was already running
      // reports zeros for everything above, and a zero tick is exactly what a
      // healthy platform looks like. This is the one field that separates them.
      skipped: r.skipped ? 1 : 0,
    };
  });
  sweep.run();
  jobAlertTimer = setInterval(() => sweep.run(), config.JOB_ALERT_SCAN_MINUTES * 60_000);
}

// Retention archival sweep (feature 10): archive records past their policy age
// unless a legal hold freezes them. Runs at boot, then every 6 hours.
let retentionTimer: NodeJS.Timeout | undefined;
{
  const sweep = scheduleSweep('retention', async () => {
    const r = await runRetentionSweep(pool, { log: app.log });
    if (r.archived > 0 || r.skipped_hold > 0 || r.purged > 0) app.log.info(r, 'retention sweep');
    return r;
  });
  sweep.run();
  retentionTimer = setInterval(() => sweep.run(), 6 * 60 * 60_000);
}

// Pool health sample (db/poolHealth.ts): report connections that were checked
// out and never returned, and the moment the pool goes fully saturated with
// callers queued. Deliberately frequent — this is an in-memory scan of a map
// whose size is bounded by the pool's `max`, and the two conditions it looks
// for are exactly the ones that get worse the longer they go unnoticed.
let poolHealthTimer: NodeJS.Timeout | undefined;
if (config.DB_POOL_SAMPLE_SECONDS > 0) {
  poolHealthTimer = setInterval(() => {
    // No `nonOverlapping`: `sample()` is synchronous and allocation-free, so
    // there is no tick to overlap with.
    reportPoolFindings(poolHealth.sample(), app.log);
  }, config.DB_POOL_SAMPLE_SECONDS * 1000);
}

// Auto-pipeline retry sweep (migration 0161): re-run orchestrations that failed
// against a dependency which has since recovered. Runs at boot — an outage that
// spanned a restart is exactly the case worth catching immediately — then on an
// interval. The claim is what keeps two instances from both re-running the
// backlog, and the auto-pipeline's own semaphore is what keeps a recovered AI
// service from being handed the whole outage at once.
let pipelineRetryTimer: NodeJS.Timeout | undefined;
if (config.PIPELINE_RETRY_SCAN_MINUTES > 0) {
  const autoPipelineDeps = {
    pool,
    aiUrl: config.AI_URL,
    engineUrl: config.ENGINE_URL,
    documentsDir: config.DOCUMENTS_DIR,
    enabled: config.AUTO_PIPELINE === 'on',
    log: app.log,
  };
  const sweep = scheduleSweep('pipeline-retry', async () => {
    const r = await retryFailedPipelineRuns({ pool, autoPipeline: autoPipelineDeps });
    if (r.claimed > 0) app.log.info(r, 'auto-pipeline retry sweep');
    return r;
  });
  sweep.run();
  pipelineRetryTimer = setInterval(() => sweep.run(), config.PIPELINE_RETRY_SCAN_MINUTES * 60_000);
}

// Housekeeping sweep (domain/housekeeping.ts): delete the single-use
// credentials, settled invitations and spent idempotency records that nothing
// has ever removed. Deliberately NOT run at boot — it is the one sweep with no
// urgency whatsoever (these rows have sat there for months; another hour costs
// nothing) and a deploy is when the database is least free to spend on it.
let housekeepingTimer: NodeJS.Timeout | undefined;
{
  const sweep = scheduleSweep('housekeeping', async () => {
    const r = await runHousekeepingSweep({ pool, log: app.log });
    // Gated on either, not on `total` alone — the same correction the
    // cap-table scan above got. A pass in which every one of the five deletes
    // was refused removes nothing, and "removed nothing" is what a healthy
    // pass with nothing to do also reports, so the line was written on exactly
    // the ticks that had nothing to say and skipped on the ones that did.
    if (r.total > 0 || r.failed > 0) app.log.info(r, 'housekeeping sweep');
    return r;
  });
  housekeepingTimer = setInterval(() => sweep.run(), 60 * 60_000);
}

// What this deployment actually started, said once, the way the feature-flag
// line above says the same thing about flags. The gauge makes a switched-off
// sweep legible to a scraper; this makes it legible to whoever is reading the
// journal after a deploy, which is where a `_MINUTES=0` typo is caught before
// anybody needs the ladder it turned off.
{
  const off = SWEEP_ROSTER.filter((name) => !sweeps.some((s) => s.name === name));
  if (off.length > 0) app.log.warn({ off, scheduled: sweeps.length }, 'background sweeps: not all scheduled');
  else app.log.info({ scheduled: sweeps.length }, 'background sweeps scheduled');
}

// This is the service `deploy.sh` restarts and then waits for, and the one with
// the most that can stall: twelve background timers, a Fastify server draining
// in-flight requests (drain.ts, at `preClose` inside the `app.close()` below),
// and a pg pool that will not end until every checked-out connection comes
// back. Unbounded, one stuck query held the whole deploy until systemd's 90s
// timeout and a SIGKILL — which is what the graceful path was there to avoid.
//
// Three waits, in the order the work depends on them:
//
//  1. Clear the intervals. This stops the *next* tick and nothing else.
//  2. Wait for the tick that is already running, and for the requests already
//     being served. Concurrently, because they are independent and each has
//     its own 5s bound — in series the pair could spend the whole 10s grace.
//  3. Only then end the pool. `pool.end()` is not a backstop for either: a
//     sweep sitting between two queries holds no client, so `end()` finds an
//     empty pool, resolves in a millisecond and makes every subsequent query
//     that sweep issues reject. See shared/scheduler.ts for what that costs
//     the email retry sweep specifically, which is a duplicate delivery.
installShutdownHandlers(app.log, {
  service: 'valuation',
  onShutdown: async () => {
    // Timers first: stop starting new work before waiting for existing work.
    if (autoEmailTimer) clearInterval(autoEmailTimer);
    if (emailRetryTimer) clearInterval(emailRetryTimer);
    if (webhookRetryTimer) clearInterval(webhookRetryTimer);
    if (reaperTimer) clearInterval(reaperTimer);
    if (aiJobReaperTimer) clearInterval(aiJobReaperTimer);
    if (capTableSyncTimer) clearInterval(capTableSyncTimer);
    if (hrisSyncTimer) clearInterval(hrisSyncTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    if (jobAlertTimer) clearInterval(jobAlertTimer);
    if (housekeepingTimer) clearInterval(housekeepingTimer);
    // No sweep to wait for: `reportPoolFindings` is a synchronous scan of an
    // in-memory map, so there is never a tick of it in flight.
    if (poolHealthTimer) clearInterval(poolHealthTimer);
    if (pipelineRetryTimer) clearInterval(pipelineRetryTimer);
    await Promise.all([app.close(), quiesceAndLog(sweeps, app.log)]);
    await pool.end();
    await telemetry.shutdown();
  },
});
