import {
  startTelemetry,
  createHttpMetrics,
  registerGauge,
  installCrashHandlers,
  installShutdownHandlers,
  listenHost,
} from '@n409/shared';

// OTel first so http/pg get instrumented before anything imports them (issue #4).
const telemetry = startTelemetry('valuation');

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { buildApp, buildEmailTransports } = await import('./app.js');
const { runDueAutoEmails } = await import('./hooks/autoEmails.js');
const { retryFailedEmails } = await import('./hooks/emailRetry.js');
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

await migrate(pool, { log: (msg) => app.log.info({ migration: msg }, 'migration applied') });
await app.listen({ port: config.PORT, host: listenHost() });
app.log.info({ port: config.PORT }, 'valuation service listening');

const emailTransports = buildEmailTransports(config, app.log);

// Drip campaign scan (§15.6). The flag keeps a slow scan from stacking ticks
// on this instance; overlap with the ops-triggered run and with other instances
// is the advisory lock's job, inside runDueAutoEmails. A failed scan logs and
// waits for the next tick.
let autoEmailTimer: NodeJS.Timeout | undefined;
if (config.AUTO_EMAIL_SCAN_MINUTES > 0) {
  let scanning = false;
  autoEmailTimer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    runDueAutoEmails({ pool, ...emailTransports, log: app.log })
      .then((r) => {
        if (r.queued > 0 || r.skipped > 0) app.log.info(r, 'auto email scan');
      })
      .catch((err) => app.log.error({ err }, 'auto email scan failed'))
      .finally(() => {
        scanning = false;
      });
  }, config.AUTO_EMAIL_SCAN_MINUTES * 60_000);
}

// Failed-outbox retry sweep: transient SMTP failures otherwise sit as
// 'failed' forever with nothing else revisiting them (see hooks/emailRetry.ts).
let emailRetryTimer: NodeJS.Timeout | undefined;
if (config.EMAIL_RETRY_SCAN_MINUTES > 0) {
  let retrying = false;
  emailRetryTimer = setInterval(() => {
    if (retrying) return;
    retrying = true;
    retryFailedEmails({
      pool,
      ...emailTransports,
      log: app.log,
      maxAttempts: config.EMAIL_RETRY_MAX_ATTEMPTS,
    })
      .then((r) => {
        if (r.attempted > 0) app.log.info(r, 'email retry sweep');
      })
      .catch((err) => app.log.error({ err }, 'email retry sweep failed'))
      .finally(() => {
        retrying = false;
      });
  }, config.EMAIL_RETRY_SCAN_MINUTES * 60_000);
}

// Auto-pipeline reaper (B-3 §auto-pipeline): sweep runs orphaned by a restart or
// wedged on a stuck upstream call. Run once at boot, then on an interval.
let reaperTimer: NodeJS.Timeout | undefined;
if (config.AUTO_PIPELINE_STALE_MINUTES > 0) {
  const olderThanMs = config.AUTO_PIPELINE_STALE_MINUTES * 60_000;
  const reaperActor = { actorType: 'system', actorId: 'reaper', source: 'auto-pipeline' } as const;
  const sweep = () =>
    reapStalePipelineRuns(pool, { olderThanMs, actor: reaperActor })
      .then((reaped) => {
        if (reaped.length > 0) {
          app.log.warn(
            { count: reaped.length, runIds: reaped.map((r) => r.id) },
            'reaped stale pipeline runs',
          );
        }
      })
      .catch((err) => app.log.error({ err }, 'pipeline reaper failed'));
  void sweep();
  reaperTimer = setInterval(sweep, Math.min(olderThanMs, 5 * 60_000));
}

// Cap-table sync scheduler (feature 4): pull connections whose daily/weekly
// cadence is due. A non-overlapping tick every 15 minutes; per-connection
// errors are recorded on the row and don't stop the scan.
let capTableSyncTimer: NodeJS.Timeout | undefined;
{
  let syncing = false;
  const tick = () => {
    if (syncing) return;
    syncing = true;
    runDueCapTableSyncs({ pool, log: app.log })
      .then((n) => {
        if (n > 0) app.log.info({ processed: n }, 'cap-table sync scan');
      })
      .catch((err) => app.log.error({ err }, 'cap-table sync scan failed'))
      .finally(() => {
        syncing = false;
      });
  };
  capTableSyncTimer = setInterval(tick, 15 * 60_000);
}

// HRIS/payroll sync scheduler (feature 11): pull due roster/grant connections.
let hrisSyncTimer: NodeJS.Timeout | undefined;
{
  let syncing = false;
  const tick = () => {
    if (syncing) return;
    syncing = true;
    runDueHrisSyncs({ pool, log: app.log })
      .then((n) => {
        if (n > 0) app.log.info({ processed: n }, 'HRIS sync scan');
      })
      .catch((err) => app.log.error({ err }, 'HRIS sync scan failed'))
      .finally(() => {
        syncing = false;
      });
  };
  hrisSyncTimer = setInterval(tick, 15 * 60_000);
}

// Retention archival sweep (feature 10): archive records past their policy age
// unless a legal hold freezes them. Runs at boot, then every 6 hours.
let retentionTimer: NodeJS.Timeout | undefined;
{
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    runRetentionSweep(pool)
      .then((r) => {
        if (r.archived > 0 || r.skipped_hold > 0) app.log.info(r, 'retention sweep');
      })
      .catch((err) => app.log.error({ err }, 'retention sweep failed'))
      .finally(() => {
        sweeping = false;
      });
  };
  void sweep();
  retentionTimer = setInterval(sweep, 6 * 60 * 60_000);
}

// This is the service `deploy.sh` restarts and then waits for, and the one with
// the most that can stall: six background timers, a Fastify server draining
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
    if (reaperTimer) clearInterval(reaperTimer);
    if (capTableSyncTimer) clearInterval(capTableSyncTimer);
    if (hrisSyncTimer) clearInterval(hrisSyncTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    await app.close();
    await pool.end();
    await telemetry.shutdown();
  },
});
