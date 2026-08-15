/**
 * Signal-driven graceful shutdown.
 *
 * Every service already handled SIGINT/SIGTERM, but each did it inline and none
 * of them bounded the result:
 *
 * ```ts
 * process.on(signal, () => {
 *   void app.close().then(() => telemetry.shutdown()).then(() => process.exit(0));
 * });
 * ```
 *
 * Three things go wrong with that under systemd, and all three are ordinary
 * rather than exotic:
 *
 * 1. **Nothing bounds it.** `app.close()` waits for in-flight requests — once
 *    `registerRequestDrain` is installed, that is; see drain.ts for why Fastify
 *    5 does not do it on its own — and `pool.end()` waits for checked-out
 *    connections. A slow PDF render, a wedged upstream, or one stuck query and
 *    the process simply never exits.
 *    systemd then waits out `TimeoutStopSec` — 90s by default — and SIGKILLs,
 *    which is the one outcome the graceful path existed to avoid: the kill
 *    lands mid-flush, so telemetry is lost and the DB sees an abandoned
 *    connection. `deploy.sh` restarts valuation and *waits* for it, so this is
 *    paid on every deploy, and it reads as a hung deploy rather than a slow
 *    shutdown.
 * 2. **A rejection skips the exit.** `.then(() => process.exit(0))` never runs
 *    if an earlier step rejects. The rejection reaches `installCrashHandlers`,
 *    which exits `1` and logs `unhandledRejection` — so a normal restart is
 *    recorded as a crash, which is exactly the wrong thing to find in the logs
 *    at 3am.
 * 3. **A second signal re-enters it.** Ctrl-C twice, or systemd escalating,
 *    starts a concurrent `app.close()` on a server that is already closing.
 *
 * This does what `installCrashHandlers` already does for the crash path: log
 * once, run the shutdown under a deadline, and exit either way. The deadline is
 * the contract — a wedged process must still die, and it should die on our
 * schedule rather than the supervisor's.
 */

export interface ShutdownLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ShutdownOptions {
  /** Service name, attached to the log line. */
  service: string;
  /** Close the server, drain pools, flush telemetry. Bounded by `graceMs`. */
  onShutdown: () => Promise<void>;
  /**
   * Cap on graceful shutdown before exiting anyway. Default 10s — comfortably
   * under systemd's 90s `TimeoutStopSec`, so we exit on our own terms and the
   * supervisor never has to SIGKILL us.
   */
  graceMs?: number;
  /** Signals to handle. Default SIGINT + SIGTERM. */
  signals?: readonly NodeJS.Signals[];
  /** Injected for tests; defaults to the real process. */
  target?: Pick<NodeJS.Process, 'on' | 'exit'>;
}

/** The exit code used when shutdown overran its deadline or threw. */
export const SHUTDOWN_FAILED_EXIT_CODE = 1;

interface Outcome {
  timedOut: boolean;
  error?: unknown;
}

/** Runs `shutdown` under a deadline, reporting which way it ended. */
async function runBounded(shutdown: () => Promise<void>, ms: number): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    // The deadline itself must not be the thing holding the loop open.
    timer.unref?.();
  });
  try {
    return await Promise.race([
      shutdown().then(
        (): Outcome => ({ timedOut: false }),
        (error: unknown): Outcome => ({ timedOut: false, error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Installs signal handlers that shut down gracefully, then exit — on a deadline,
 * once, whatever happens.
 *
 * Exits `0` on a clean shutdown and {@link SHUTDOWN_FAILED_EXIT_CODE} if the
 * shutdown threw or overran, so a restart that did not drain cleanly is
 * distinguishable in the supervisor's logs from one that did.
 */
export function installShutdownHandlers(log: ShutdownLogger, opts: ShutdownOptions): void {
  const target = opts.target ?? process;
  const graceMs = opts.graceMs ?? 10_000;
  const signals = opts.signals ?? (['SIGINT', 'SIGTERM'] as const);
  // A second signal must not start a second shutdown. It is also the operator
  // asking us to hurry up, so it is worth a line saying we heard them.
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log.info({ signal, service: opts.service }, 'already shutting down — ignoring repeat signal');
      return;
    }
    shuttingDown = true;
    log.info({ signal, service: opts.service, graceMs }, 'shutting down');
    void (async () => {
      const { timedOut, error } = await runBounded(opts.onShutdown, graceMs);
      if (timedOut) {
        log.error(
          { signal, service: opts.service, graceMs },
          'graceful shutdown exceeded its deadline — exiting anyway',
        );
      } else if (error !== undefined) {
        log.error({ err: error, signal, service: opts.service }, 'error during graceful shutdown');
      }
      target.exit(timedOut || error !== undefined ? SHUTDOWN_FAILED_EXIT_CODE : 0);
    })();
  };

  for (const signal of signals) target.on(signal, () => handle(signal));
}
