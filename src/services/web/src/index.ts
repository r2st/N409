import {
  installCrashHandlers,
  installShutdownHandlers,
  listenHost,
  listenPort,
  startTelemetry,
} from '@n409/shared';

// Before anything is constructed or connected: a bad PORT is a bad deploy, and
// the cheapest place to say so is the first line. Throwing here exits non-zero
// with the message on stderr, which is where systemd is already looking.
const port = listenPort(3000);

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

await app.listen({ port, host: listenHost() });
app.log.info({ port }, 'web service listening');

installShutdownHandlers(app.log, {
  service: 'web',
  onShutdown: async () => {
    await app.close();
    await telemetry.shutdown();
  },
});
