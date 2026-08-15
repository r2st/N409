/**
 * Letting in-flight requests finish before the server closes.
 *
 * `installShutdownHandlers` is written around a premise this module exists to
 * make true: that `app.close()` "waits for in-flight requests". Under Fastify 5
 * it does not, and the way it does not is easy to miss because the option that
 * governs it reads as if it were off. Resolving the default (lib/server.js):
 *
 * ```js
 * forceCloseConnections = serverHasCloseIdleConnections ? 'idle' : false
 * ```
 *
 * so on any modern Node the default is the string `'idle'`. Spending it
 * (fastify.js, inside the `onClose` hook) then goes:
 *
 * ```js
 * if (forceCloseConnections === 'idle' && options.serverFactory) {
 *   instance.server.closeIdleConnections()
 * } else if (serverHasCloseAllConnections && forceCloseConnections) {
 *   instance.server.closeAllConnections()
 * }
 * ```
 *
 * The first branch — the one that reaps only *idle* sockets, which is what
 * `'idle'` promises — is gated on `serverFactory`, which none of these services
 * pass. So the second branch takes it, `'idle'` being a non-empty string and
 * therefore truthy, and every socket is destroyed: including the ones with a
 * request still being served.
 *
 * Measured rather than reasoned: a handler sleeping 1.2s, SIGTERM at 150ms, and
 * the client gets `fetch failed` while `app.close()` resolves in one
 * millisecond. Not slow — dropped.
 *
 * What that costs is paid on a schedule. `deploy.sh` restarts all five units on
 * every deploy, so every deploy resets whatever was in flight: an analyst's
 * save, a calculation, a PDF render. It surfaces as a connection reset with no
 * status code, so nothing retries it and no error rate records it — the request
 * simply never happened, and the only party who knows is the person who clicked.
 *
 * Setting `forceCloseConnections: false` is not the fix. It makes `close()` wait
 * for *every* connection, idle keep-alive sockets included, and those linger
 * until `keepAliveTimeout` (72s by default) — so shutdown reliably overruns its
 * deadline instead of reliably truncating requests. Confirmed the same way: with
 * `false`, close was still pending after six seconds with nothing left to serve.
 *
 * So the drain is done before `close()` is called at all, in the window Fastify
 * already provides for it. The `preClose` hook runs after `closing = true` — at
 * which point Fastify's own `return503OnClosing` sheds new requests without
 * running a handler, so the set being waited on can only shrink — and before any
 * connection is touched. Waiting there for the in-flight count to reach zero
 * turns the force-close from the thing that ends requests into what it should
 * have been all along: the backstop for whatever did not finish in time.
 *
 * Bounded, for the reason `shutdown.ts` gives at length: a wedged request must
 * not be able to hold the process past its deadline. Overrunning the drain is
 * not an error — it is the backstop doing its job — so it logs and proceeds, and
 * the exit code stays with the shutdown handler that owns it.
 */

import type { FastifyInstance } from 'fastify';

/** How the wait ended. `remaining` is what the force-close will now truncate. */
export interface DrainResult {
  /** True when the last request finished before the deadline. */
  drained: boolean;
  /** Requests still in flight when the wait ended. Zero iff `drained`. */
  remaining: number;
  waitedMs: number;
}

/** Default cap on the drain, comfortably inside the 10s shutdown deadline. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * A count of requests being served, and a way to wait for it to reach zero.
 *
 * Separate from the Fastify wiring below so the waiting logic can be tested
 * without a socket: everything interesting here is about what happens when a
 * request finishes during the wait, or does not finish at all.
 */
export class InFlightRequests {
  private count = 0;
  private readonly waiters = new Set<() => void>();

  /** Requests currently being served. */
  get inFlight(): number {
    return this.count;
  }

  /**
   * Registers a request and returns its completion callback.
   *
   * The callback is idempotent. It is wired to the response's `close` event,
   * which fires once per response — but the same tracker also has to survive a
   * caller that ends a hijacked response itself and then sees the event, and a
   * double decrement would make the count go negative and strand the drain.
   */
  enter(): () => void {
    this.count += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.count -= 1;
      if (this.count === 0) {
        // Copied before iterating: a waiter is removed from the set as it
        // resolves, and mutating during the walk would skip its neighbour.
        for (const wake of [...this.waiters]) wake();
      }
    };
  }

  /**
   * Waits for the in-flight count to reach zero, or for `timeoutMs` to pass.
   *
   * Resolves immediately when nothing is in flight, which is the normal case:
   * a restart on a quiet service should cost nothing at all.
   */
  async drain(opts: { timeoutMs: number; now?: () => number }): Promise<DrainResult> {
    const now = opts.now ?? (() => Date.now());
    const startedAt = now();
    if (this.count === 0) return { drained: true, remaining: 0, waitedMs: 0 };

    let timer: NodeJS.Timeout | undefined;
    let wake!: () => void;
    const idle = new Promise<void>((resolve) => {
      wake = resolve;
      this.waiters.add(wake);
    });
    // Deliberately not unref'd. This timer is the deadline, and a drain that is
    // waiting on a request whose socket has already gone away would otherwise
    // have nothing left holding the loop open to fire it.
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.timeoutMs);
    });

    try {
      await Promise.race([idle, deadline]);
    } finally {
      this.waiters.delete(wake);
      if (timer) clearTimeout(timer);
    }
    return { drained: this.count === 0, remaining: this.count, waitedMs: now() - startedAt };
  }
}

export interface DrainLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface DrainOptions {
  /** Cap on the wait. Default {@link DEFAULT_DRAIN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Where the outcome is reported. Defaults to the app's own logger. */
  log?: DrainLogger;
  /**
   * Run before the wait begins, to release connections that would otherwise
   * never finish on their own — an open SSE stream is a request in flight for
   * as long as the client holds it, so a service with one would spend the whole
   * deadline every time. Failures here are logged and the drain proceeds.
   */
  onDrainStart?: () => void | Promise<void>;
}

/**
 * Counts requests in flight and waits for them at `preClose`.
 *
 * Returns the tracker so a service can expose the count as a gauge, and so
 * tests can assert on it without reaching through Fastify.
 */
export function registerRequestDrain(app: FastifyInstance, opts: DrainOptions = {}): InFlightRequests {
  const tracker = new InFlightRequests();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  app.addHook('onRequest', (_req, reply, done) => {
    const leave = tracker.enter();
    // The response's `close`, not the `onResponse` hook. `onResponse` never runs
    // for a reply that was hijacked — the SSE stream is exactly that — so a
    // tracker built on it would count every stream ever opened and never
    // discount one, and the drain would time out on a service with no work
    // left to do. `close` fires on the raw response either way: when it is
    // finished, and when the socket dies under it.
    reply.raw.on('close', leave);
    done();
  });

  app.addHook('preClose', async () => {
    const log = opts.log ?? (app.log as unknown as DrainLogger);
    if (opts.onDrainStart) {
      try {
        await opts.onDrainStart();
      } catch (err) {
        log.warn({ err }, 'failed to release long-lived connections before draining');
      }
    }
    const result = await tracker.drain({ timeoutMs });
    if (result.drained) {
      if (result.waitedMs > 0) log.info({ waitedMs: result.waitedMs }, 'in-flight requests drained');
    } else {
      log.warn(
        { remaining: result.remaining, timeoutMs },
        'drain deadline reached — closing with requests still in flight',
      );
    }
  });

  return tracker;
}
