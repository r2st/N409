import { installCrashHandlers, installShutdownHandlers, listenHost, startTelemetry } from '@n409/shared';

const telemetry = startTelemetry('report');
const { buildApp } = await import('./app.js');

const app = buildApp();

// PDF rendering spawns and awaits external work; a rejection that escapes it
// would otherwise take the process down silently. Log through pino, then exit so
// systemd restarts us rather than leaving a half-dead renderer in the pool.
installCrashHandlers(app.log, {
  service: 'report',
  onShutdown: async () => {
    await app.close();
    await telemetry.shutdown();
  },
});

await app.listen({ port: Number(process.env.PORT ?? 3004), host: listenHost() });

// A PDF render in flight is the realistic reason this service is slow to
// close, so the deadline matters more here than anywhere else.
installShutdownHandlers(app.log, {
  service: 'report',
  onShutdown: async () => {
    await app.close();
    await telemetry.shutdown();
  },
});
