import { startTelemetry, createHttpMetrics, registerGauge } from '@n409/shared';

// OTel first so http/pg get instrumented before anything imports them (issue #4).
const telemetry = startTelemetry('valuation');

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { buildApp, buildEmailTransports } = await import('./app.js');
const { runDueAutoEmails } = await import('./hooks/autoEmails.js');
const { reapStalePipelineRuns } = await import('./repos/pipelineRuns.js');
const { runDueCapTableSyncs } = await import('./routes/capTableSync.js');
const { autoPipelineConcurrency } = await import('./pipeline/autoPipeline.js');

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ config, pool });

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
await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ port: config.PORT }, 'valuation service listening');

// Drip campaign scan (§15.6) — overlapping runs are prevented by the flag;
// a failed scan logs and waits for the next tick.
let autoEmailTimer: NodeJS.Timeout | undefined;
if (config.AUTO_EMAIL_SCAN_MINUTES > 0) {
  const transports = buildEmailTransports(config, app.log);
  let scanning = false;
  autoEmailTimer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    runDueAutoEmails({ pool, ...transports, log: app.log })
      .then((r) => {
        if (r.queued > 0 || r.skipped > 0) app.log.info(r, 'auto email scan');
      })
      .catch((err) => app.log.error({ err }, 'auto email scan failed'))
      .finally(() => {
        scanning = false;
      });
  }, config.AUTO_EMAIL_SCAN_MINUTES * 60_000);
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, 'shutting down');
      if (autoEmailTimer) clearInterval(autoEmailTimer);
      if (reaperTimer) clearInterval(reaperTimer);
      if (capTableSyncTimer) clearInterval(capTableSyncTimer);
      await app.close();
      await pool.end();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
