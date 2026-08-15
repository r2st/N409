/**
 * Process-level crash handlers.
 *
 * Without these, an `uncaughtException` prints a raw stack to stderr and exits
 * with no structured log line, and — worse — an `unhandledRejection` on Node 22
 * also terminates the process, so a single forgotten `.catch()` in a background
 * timer took a service down leaving nothing in the JSON logs to explain it. Both
 * now log through pino (so the failure is searchable alongside every other line
 * the service emitted) and then exit non-zero so systemd's Restart= brings the
 * service back.
 *
 * Exiting rather than limping on is deliberate: after an uncaught throw the
 * process is in an unknown state, and a restarted service is more trustworthy
 * than one that swallowed the error.
 */

import { scrubError } from './problem.js';

export interface CrashHandlerLogger {
  fatal: (obj: Record<string, unknown>, msg: string) => void;
}

export interface CrashHandlerOptions {
  /** Service name, attached to the log line. */
  service: string;
  /**
   * Best-effort shutdown (close the server, flush telemetry) before exiting.
   * Bounded by `flushMs` — a wedged process must still die.
   */
  onShutdown?: () => Promise<void>;
  /** Cap on shutdown before exiting anyway. Default 2s. */
  flushMs?: number;
  /** Exit code. Default 1. */
  exitCode?: number;
  /** Injected for tests; defaults to the real process. */
  target?: Pick<NodeJS.Process, 'on' | 'exit'>;
}

/** Resolves once `promise` settles or `ms` elapses, whichever comes first. */
async function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        // Don't hold the loop open on account of the deadline itself.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Installs `uncaughtException` and `unhandledRejection` handlers that log and
 * exit. Returns a function that removes them again (used by tests).
 */
export function installCrashHandlers(log: CrashHandlerLogger, opts: CrashHandlerOptions): void {
  const target = opts.target ?? process;
  const flushMs = opts.flushMs ?? 2000;
  const exitCode = opts.exitCode ?? 1;
  // An exception thrown *during* shutdown must not restart the whole dance.
  let crashing = false;

  const die = (event: string, err: unknown) => {
    if (crashing) return;
    crashing = true;
    // Scrubbed for the reason the 5xx handler scrubs (see problem.ts): pino's
    // `redact` paths only mask structured fields, so anything interpolated into
    // an Error's message or stack reaches the log verbatim. That is not a
    // hypothetical here — the failure most likely to arrive as an
    // `uncaughtException` on this platform is the pg pool's own error event,
    // and a connection failure names the DSN, password included. This is the
    // line a service writes on its way out, so it is the one most certain to be
    // read, copied into a ticket and pasted into a chat.
    log.fatal(
      { err: scrubError(err), event, service: opts.service },
      `${event} — exiting so the supervisor restarts the service`,
    );
    void (async () => {
      if (opts.onShutdown) await withDeadline(opts.onShutdown(), flushMs);
      target.exit(exitCode);
    })();
  };

  target.on('uncaughtException', (err: unknown) => die('uncaughtException', err));
  // The reason is whatever was rejected — frequently an Error, but not always,
  // so it is logged as-is rather than assumed to have a stack.
  target.on('unhandledRejection', (reason: unknown) => die('unhandledRejection', reason));
}
