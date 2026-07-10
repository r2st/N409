import { startTelemetry } from '@n409/shared';

// OTel first so http/pg get instrumented before anything imports them (issue #4).
const telemetry = startTelemetry('valuation');

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { buildApp, buildEmailTransports } = await import('./app.js');
const { runDueAutoEmails } = await import('./hooks/autoEmails.js');

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ config, pool });

await migrate(pool, { log: (msg) => app.log.info({ migration: msg }, 'migration applied') });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ port: config.PORT }, 'valuation service listening');

// Drip campaign scan (§15.6) — overlapping runs are prevented by the flag;
// a failed scan logs and waits for the next tick.
let autoEmailTimer: NodeJS.Timeout | undefined;
if (config.AUTO_EMAIL_SCAN_MINUTES > 0) {
  const transports = buildEmailTransports(config, app.log);
  let scanning = false;
  autoEmailTimer = setInterval(
    () => {
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
    },
    config.AUTO_EMAIL_SCAN_MINUTES * 60_000,
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, 'shutting down');
      if (autoEmailTimer) clearInterval(autoEmailTimer);
      await app.close();
      await pool.end();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
