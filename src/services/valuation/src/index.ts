import {
  startTelemetry,
  createHttpMetrics,
  registerGauge,
  installCrashHandlers,
  installShutdownHandlers,
  listenHost,
  nonOverlapping,
} from '@n409/shared';

// OTel first so http/pg get instrumented before anything imports them (issue #4).
const telemetry = startTelemetry('valuation');

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { buildApp, buildEmailTransports } = await import('./app.js');
const { runDueAutoEmails } = await import('./hooks/autoEmails.js');
const { retryFailedEmails } = await import('./hooks/emailRetry.js');
const { retryDueDeliveries } = await import('./hooks/partnerWebhooks.js');
const { reapStalePipelineRuns } = await import('./repos/pipelineRuns.js');
const { runDueCapTableSyncs } = await import('./routes/capTableSync.js');
const { runRetentionSweep } = await import('./routes/retention.js');
const { runDueHrisSyncs } = await import('./routes/hris.js');
const { autoPipelineConcurrency } = await import('./pipeline/autoPipeline.js');

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ config, pool });

// A stray rejection in any of the background timers below (auto-emails, the
// pipeline reaper, the cap-table/HRIS scans, retention) would otherwise kill the
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

await migrate(pool, { log: (msg) => app.log.info({ migration: msg }, 'migration applied') });
await app.listen({ port: config.PORT, host: listenHost() });
app.log.info({ port: config.PORT }, 'valuation service listening');

const emailTransports = buildEmailTransports(config, app.log);

// Drip campaign scan (§15.6). `nonOverlapping` keeps a slow scan from stacking
// ticks on this instance; overlap with the ops-triggered run and with other
// instances is the advisory lock's job, inside runDueAutoEmails. A failed scan
// logs and waits for the next tick.
let autoEmailTimer: NodeJS.Timeout | undefined;
if (config.AUTO_EMAIL_SCAN_MINUTES > 0) {
  const scan = nonOverlapping(
    async () => {
      const r = await runDueAutoEmails({
        pool,
        ...emailTransports,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        log: app.log,
      });
      if (r.queued > 0 || r.skipped > 0) app.log.info(r, 'auto email scan');
    },
    (err) => app.log.error({ err }, 'auto email scan failed'),
  );
  autoEmailTimer = setInterval(() => scan.run(), config.AUTO_EMAIL_SCAN_MINUTES * 60_000);
}

// Failed-outbox retry sweep: transient SMTP failures otherwise sit as
// 'failed' forever with nothing else revisiting them (see hooks/emailRetry.ts).
let emailRetryTimer: NodeJS.Timeout | undefined;
if (config.EMAIL_RETRY_SCAN_MINUTES > 0) {
  const sweep = nonOverlapping(
    async () => {
      const r = await retryFailedEmails({
        pool,
        ...emailTransports,
        log: app.log,
        maxAttempts: config.EMAIL_RETRY_MAX_ATTEMPTS,
      });
      if (r.attempted > 0) app.log.info(r, 'email retry sweep');
    },
    (err) => app.log.error({ err }, 'email retry sweep failed'),
  );
  emailRetryTimer = setInterval(() => sweep.run(), config.EMAIL_RETRY_SCAN_MINUTES * 60_000);
}

// Partner webhook retry sweep (0103): a delivery whose receiver was down keeps
// 'pending' with a backoff stamped on it; this is what comes back for it.
let webhookRetryTimer: NodeJS.Timeout | undefined;
if (config.WEBHOOK_RETRY_SCAN_MINUTES > 0) {
  const sweep = nonOverlapping(
    async () => {
      const r = await retryDueDeliveries({ pool, log: app.log });
      if (r.attempted > 0) app.log.info(r, 'webhook retry sweep');
    },
    (err) => app.log.error({ err }, 'webhook retry sweep failed'),
  );
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
  const sweep = nonOverlapping(
    async () => {
      const reaped = await reapStalePipelineRuns(pool, { olderThanMs, actor: reaperActor });
      if (reaped.length > 0) {
        app.log.warn({ count: reaped.length, runIds: reaped.map((r) => r.id) }, 'reaped stale pipeline runs');
      }
    },
    (err) => app.log.error({ err }, 'pipeline reaper failed'),
  );
  sweep.run();
  reaperTimer = setInterval(() => sweep.run(), Math.min(olderThanMs, 5 * 60_000));
}

// Cap-table sync scheduler (feature 4): pull connections whose daily/weekly
// cadence is due. A non-overlapping tick every 15 minutes; per-connection
// errors are recorded on the row and don't stop the scan.
let capTableSyncTimer: NodeJS.Timeout | undefined;
{
  const tick = nonOverlapping(
    async () => {
      const n = await runDueCapTableSyncs({ pool, log: app.log });
      if (n > 0) app.log.info({ processed: n }, 'cap-table sync scan');
    },
    (err) => app.log.error({ err }, 'cap-table sync scan failed'),
  );
  capTableSyncTimer = setInterval(() => tick.run(), 15 * 60_000);
}

// HRIS/payroll sync scheduler (feature 11): pull due roster/grant connections.
let hrisSyncTimer: NodeJS.Timeout | undefined;
{
  const tick = nonOverlapping(
    async () => {
      const n = await runDueHrisSyncs({ pool, log: app.log });
      if (n > 0) app.log.info({ processed: n }, 'HRIS sync scan');
    },
    (err) => app.log.error({ err }, 'HRIS sync scan failed'),
  );
  hrisSyncTimer = setInterval(() => tick.run(), 15 * 60_000);
}

// Retention archival sweep (feature 10): archive records past their policy age
// unless a legal hold freezes them. Runs at boot, then every 6 hours.
let retentionTimer: NodeJS.Timeout | undefined;
{
  const sweep = nonOverlapping(
    async () => {
      const r = await runRetentionSweep(pool);
      if (r.archived > 0 || r.skipped_hold > 0) app.log.info(r, 'retention sweep');
    },
    (err) => app.log.error({ err }, 'retention sweep failed'),
  );
  sweep.run();
  retentionTimer = setInterval(() => sweep.run(), 6 * 60 * 60_000);
}

// This is the service `deploy.sh` restarts and then waits for, and the one with
// the most that can stall: seven background timers, a Fastify server draining
// in-flight requests, and a pg pool that will not end until every checked-out
// connection comes back. Unbounded, one stuck query held the whole deploy until
// systemd's 90s timeout and a SIGKILL — which is what the graceful path was
// there to avoid.
installShutdownHandlers(app.log, {
  service: 'valuation',
  onShutdown: async () => {
    // Timers first: stop starting new work before waiting for existing work.
    if (autoEmailTimer) clearInterval(autoEmailTimer);
    if (emailRetryTimer) clearInterval(emailRetryTimer);
    if (webhookRetryTimer) clearInterval(webhookRetryTimer);
    if (reaperTimer) clearInterval(reaperTimer);
    if (capTableSyncTimer) clearInterval(capTableSyncTimer);
    if (hrisSyncTimer) clearInterval(hrisSyncTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    await app.close();
    await pool.end();
    await telemetry.shutdown();
  },
});
