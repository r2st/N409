import { installCrashHandlers, listenHost, startTelemetry } from '@n409/shared';

const telemetry = startTelemetry('web');
const { buildApp } = await import('./app.js');

const app = buildApp();

// Log-then-exit on an uncaught throw or a stray rejection, so systemd restarts a
// process whose state we can no longer vouch for — and so the failure leaves a
// structured line behind instead of a bare stack on stderr.
installCrashHandlers(app.log, {
  service: 'web',
  onShutdown: async () => {
    await app.close();
    await telemetry.shutdown();
  },
});

await app.listen({ port: Number(process.env.PORT ?? 3000), host: listenHost() });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => telemetry.shutdown())
      .then(() => process.exit(0));
  });
}
