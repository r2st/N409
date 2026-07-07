import { startTelemetry } from '@n409/shared';

const telemetry = startTelemetry('engine-wrapper');
const { buildApp } = await import('./app.js');

const app = buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3003), host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => telemetry.shutdown())
      .then(() => process.exit(0));
  });
}
