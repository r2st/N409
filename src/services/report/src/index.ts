import { startTelemetry } from '@n409/shared';

const telemetry = startTelemetry('report');
const { buildApp } = await import('./app.js');

const app = buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3004), host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => telemetry.shutdown())
      .then(() => process.exit(0));
  });
}
