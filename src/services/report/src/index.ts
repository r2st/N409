import {
  installCrashHandlers,
  installShutdownHandlers,
  listenHost,
  listenPort,
  startTelemetry,
} from '@n409/shared';

// Refused before the renderer's font assets are verified or a socket exists —
// see listen.ts for what an empty PORT otherwise binds.
const port = listenPort(3004);

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

await app.listen({ port, host: listenHost() });
app.log.info({ port }, 'report service listening');

// The drain runs inside `app.close()`, at `preClose`; the deadline below is the
// outer bound on it and on everything after.
installShutdownHandlers(app.log, {
  service: 'report',
  onShutdown: async () => {
    await app.close();
    await telemetry.shutdown();
  },
});
