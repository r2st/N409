/**
 * Non-overlapping background ticks.
 *
 * Every service here schedules periodic work with `setInterval`, and the naive
 * form is wrong in the same way each time: `setInterval` fires on a wall clock,
 * not on completion, so a tick that runs longer than the interval gets a second
 * one started on top of it. Each of those holds whatever the tick holds — for
 * these schedulers, a pool connection inside an open transaction — so the
 * pile-up arrives exactly when the database is already slow, and turns a
 * slowdown into connection starvation for the request handlers sharing the
 * pool.
 *
 * The guard is three lines and was written out by hand at five of the six call
 * sites in the valuation service, with `.finally()` resetting the flag so a
 * failed tick does not wedge the schedule permanently. The sixth — the
 * auto-pipeline reaper — carried a comment claiming it followed "every sibling
 * scheduler below" and did not have it, which is the argument for a named,
 * tested helper rather than a sixth copy: the reaper's tick is the longest of
 * them (a transaction that locks up to 100 stale runs and writes an audit event
 * for each), and it is slowest precisely when runs are wedged, which is the one
 * time it matters.
 *
 * `skipped` is counted rather than silently dropped. A scheduler that is
 * routinely skipping ticks is one whose interval is too short for its work, and
 * that is not otherwise visible from the outside.
 *
 * ## Why a scheduler has to be waitable
 *
 * `clearInterval` stops the *next* tick. It does nothing to the one already
 * running, and the shutdown sequence in every service treated the two as the
 * same thing:
 *
 * ```ts
 * if (emailRetryTimer) clearInterval(emailRetryTimer);   // ...and ten siblings
 * await app.close();
 * await pool.end();
 * ```
 *
 * `pool.end()` is not the backstop that reads like. Measured against a real
 * Postgres, with a three-query sweep paused between its first and second query
 * when `end()` was called:
 *
 * ```
 * pool.end() resolved after 1 ms
 * sweep error: Cannot use a pool after calling end on the pool
 * ```
 *
 * `end()` waits for *checked-out clients*, and a sweep sitting between two
 * queries holds none — `pool.query()` returns its client before it resolves. So
 * `end()` finds an empty pool, resolves immediately, and every subsequent query
 * the sweep makes rejects (pg-pool/index.js: `connect()` throws once `ending`).
 * The process then exits, mid-sweep.
 *
 * What that costs depends on the sweep, and the email retry sweep is the one
 * that shows why it is not merely untidy. It claims a batch of outbox rows,
 * then walks them: `transport.send(email)` and then `settleClaimedEmail(...)`.
 * Interrupted between those two calls, the message has *been sent by SMTP* and
 * nothing recorded it — the row stays claimed until its lease expires, and the
 * next sweep sends it again. A deploy that lands mid-sweep is a duplicate
 * delivery to a client, and `deploy.sh` restarts this unit every time.
 *
 * So a scheduler exposes {@link Scheduler.whenIdle}, and {@link quiesce} waits
 * for a set of them. Bounded, for the reason drain.ts gives at length: a wedged
 * tick must not hold the process past its deadline. Overrunning is reported and
 * not fatal — the exit code stays with the shutdown handler that owns it.
 */
import { logFailure, type FailureLogger } from './failure.js';
import { newUlid } from './ids.js';
import { runWithSweep } from './requestContext.js';

export interface Scheduler {
  /** Run one tick now, unless one is already in flight. */
  run(): void;
  /** True while a tick is in flight. */
  readonly running: boolean;
  /** Ticks dropped because one was already in flight — for tests and gauges. */
  readonly skipped: number;
  /**
   * Resolves once no tick is in flight.
   *
   * Resolves immediately when idle, which is the normal case at shutdown. A
   * tick that is running is awaited to *completion*, success or failure alike:
   * `onError` has already run by then, so a failed tick is finished business
   * and there is nothing left for the caller to wait on.
   *
   * Deliberately not a cancellation. There is no way to interrupt a tick
   * half-way that leaves less mess than letting it finish, which is the whole
   * argument of the note above.
   */
  whenIdle(): Promise<void>;
}

/**
 * Wraps an async tick so at most one runs at a time.
 *
 * `tick` rejecting is not exceptional — a scan against a database that is down
 * fails every time — so `onError` handles it and the schedule continues. What
 * must not happen is the rejection escaping: these are called from
 * `setInterval`, where an unhandled rejection takes the process down.
 */
export function nonOverlapping(tick: () => Promise<unknown>, onError: (err: unknown) => void): Scheduler {
  let running = false;
  let skipped = 0;
  // Woken when the in-flight tick finishes. A set rather than one callback:
  // `whenIdle` may be called more than once for the same tick — the shutdown
  // path calls it on every scheduler at once, and a test may hold two waiters.
  const idleWaiters = new Set<() => void>();

  const finish = (): void => {
    running = false;
    // Copied before iterating: a waiter removes itself as it resolves, and
    // mutating during the walk would skip its neighbour (same reason as
    // InFlightRequests.enter in drain.ts).
    for (const wake of [...idleWaiters]) wake();
  };

  return {
    get running() {
      return running;
    },
    get skipped() {
      return skipped;
    },
    whenIdle(): Promise<void> {
      if (!running) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wake = () => {
          idleWaiters.delete(wake);
          resolve();
        };
        idleWaiters.add(wake);
      });
    },
    run(): void {
      if (running) {
        skipped += 1;
        return;
      }
      running = true;
      // Guarded because `tick` may throw synchronously before returning a
      // promise — a `.finally()` chain would never be reached, and the flag
      // would stay set, silently stopping the schedule for the process's life.
      let settled: Promise<unknown>;
      try {
        settled = Promise.resolve(tick());
      } catch (err) {
        finish();
        onError(err);
        return;
      }
      void settled
        .catch(onError)
        .finally(finish)
        // `onError` is caller-supplied (a logger); if it throws, the rejection
        // would be unhandled and the process would exit. The flag is already
        // reset by then, so the schedule survives.
        .catch(() => {});
    },
  };
}

/**
 * `onError` for a named background sweep.
 *
 * Every scheduled sweep in the estate had its own hand-written handler, and all
 * of them were the same line: `log.error({ err }, '<name> sweep failed')`. Three
 * things were wrong with that shape, and none of them are visible from any one
 * call site.
 *
 * **Nothing could group them.** The sweep's name lived only in the message
 * string, so "which sweep is failing" was a substring match rather than a
 * field — while the saturation gauges beside these same schedulers had been
 * labelling by `sweep` all along. This emits the same key, so the log and the
 * metrics answer with one vocabulary.
 *
 * **Nothing could alert on them.** {@link logFailure} exists precisely to stamp
 * `alert: true` on a failure that no retry is coming for, and it is the only
 * alerting contract this codebase declares. It had no production callers at
 * all: the six places carrying `alert: true` had each written the field out by
 * hand, and the whole background tier — ten sweeps covering email, webhooks,
 * the pipeline reaper, both syncs, retention and housekeeping — carried none.
 *
 * **Everything was `error`.** A sweep whose tick lost the database during a
 * deploy logged identically to one whose tick has a bug in it, so the level
 * carried no information and the only sustainable response was to stop reading
 * it. Classifying drops the first case to `warn` — the next tick is the retry,
 * which is what a schedule *is* — and leaves `error` meaning a person is
 * needed. Note the direction that matters: the classifier's default is
 * `permanent`, so an unrecognised failure alerts rather than being quietly
 * downgraded.
 */
export function sweepFailed(log: FailureLogger, name: string): (err: unknown) => void {
  return (err) => {
    logFailure(log, err, { sweep: name }, `${name} sweep failed`);
  };
}

/**
 * A tracked background sweep: non-overlapping, classified on failure, and
 * correlated for every line its tick writes.
 *
 * The correlation is why this exists rather than the two-call composition it
 * replaces. `sweepFailed` puts `sweep` on the *failure* line and the saturation
 * gauges label by the same name, so the outside of a tick was well described
 * and the inside of it was anonymous — twelve sweeps share one process and one
 * logger, and the lines they write interleave with no field to separate them.
 * Worse, three of the tick bodies (`runDueAutoEmails`, `retryFailedEmails`,
 * `retryDueDeliveries`) are also reachable from an ops route, so a warning
 * about a delivery could not be attributed to the schedule or to a person.
 *
 * Binding here rather than at each call site is the point: a sweep registered
 * any other way would silently lose the correlation, and there is no way to
 * notice a *missing* log field. `sweepCensus.test.ts` holds the valuation
 * service's twelve to this door.
 *
 * The run id is per tick. Two ticks of the same sweep must not share one, or
 * grouping by it groups the wrong thing.
 */
export function trackedSweep(log: FailureLogger, name: string, tick: () => Promise<unknown>): Scheduler {
  return nonOverlapping(() => runWithSweep({ name, runId: newUlid() }, tick), sweepFailed(log, name));
}

/** A scheduler and the name it is reported under when it will not settle. */
export interface NamedScheduler {
  name: string;
  scheduler: Pick<Scheduler, 'running' | 'whenIdle'>;
}

/** How the wait ended. `running` names what the exit will now cut short. */
export interface QuiesceResult {
  /** True when every tick finished before the deadline. */
  idle: boolean;
  /** Schedulers still running when the wait ended. Empty iff `idle`. */
  running: string[];
  waitedMs: number;
}

/** Default cap on the wait, sized to sit inside the 10s shutdown deadline
 *  alongside the request drain rather than after it — see the note in
 *  {@link quiesce}. */
export const DEFAULT_QUIESCE_TIMEOUT_MS = 5_000;

/**
 * Waits for a set of schedulers to finish whatever they are in the middle of.
 *
 * Call it *after* the intervals are cleared and *before* the pool is ended —
 * clearing first is what makes the set being waited on able only to shrink,
 * exactly as `preClose` does for the request drain.
 *
 * Meant to run concurrently with `app.close()` rather than after it. The two
 * wait on disjoint things (background ticks; in-flight HTTP requests) and each
 * carries its own 5s bound, so in series a service could spend the entire 10s
 * shutdown grace and be SIGKILLed by the supervisor with both having behaved
 * correctly. In parallel the pair costs the slower of the two.
 *
 * Never rejects. A tick that will not finish is a fact to report, not an error
 * to raise: the caller is a shutdown handler that must exit either way.
 */
export async function quiesce(
  schedulers: readonly NamedScheduler[],
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<QuiesceResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const busy = schedulers.filter((s) => s.scheduler.running);
  if (busy.length === 0) return { idle: true, running: [], waitedMs: 0 };

  let timer: NodeJS.Timeout | undefined;
  // Deliberately not unref'd, for the reason drain.ts gives: a tick waiting on
  // a socket that has already gone away leaves nothing else holding the loop
  // open, and the deadline is the one thing that must still fire.
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.all(busy.map((s) => s.scheduler.whenIdle())), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Re-read `running` rather than tracking which promise won: a tick that
  // settled during the race is finished whether or not its wake-up had been
  // delivered by the time the deadline fired.
  const stillRunning = busy.filter((s) => s.scheduler.running).map((s) => s.name);
  return { idle: stillRunning.length === 0, running: stillRunning, waitedMs: now() - startedAt };
}

export interface QuiesceLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** {@link quiesce}, with the outcome reported the way the drain reports its own. */
export async function quiesceAndLog(
  schedulers: readonly NamedScheduler[],
  log: QuiesceLogger,
  opts: { timeoutMs?: number } = {},
): Promise<QuiesceResult> {
  const result = await quiesce(schedulers, opts);
  if (result.idle) {
    if (result.waitedMs > 0) {
      log.info({ waitedMs: result.waitedMs }, 'background sweeps finished');
    }
  } else {
    log.warn(
      { running: result.running, timeoutMs: opts.timeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS },
      'quiesce deadline reached — exiting with background sweeps still running',
    );
  }
  return result;
}
