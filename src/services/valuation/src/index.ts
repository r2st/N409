import { startTelemetry } from '@n409/shared';

// OTel first so http/pg get instrumented before anything imports them (issue #4).
const telemetry = startTelemetry('valuation');

const { loadConfig } = await import('./config.js');
const { createPool } = await import('./db/pool.js');
const { migrate } = await import('./db/migrate.js');
const { buildApp } = await import('./app.js');

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ config, pool });

await migrate(pool, { log: (msg) => app.log.info({ migration: msg }, 'migration applied') });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info({ port: config.PORT }, 'valuation service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, 'shutting down');
      await app.close();
      await pool.end();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
