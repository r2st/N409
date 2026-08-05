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
 */

export interface Scheduler {
  /** Run one tick now, unless one is already in flight. */
  run(): void;
  /** True while a tick is in flight. */
  readonly running: boolean;
  /** Ticks dropped because one was already in flight — for tests and gauges. */
  readonly skipped: number;
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
  return {
    get running() {
      return running;
    },
    get skipped() {
      return skipped;
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
        running = false;
        onError(err);
        return;
      }
      void settled
        .catch(onError)
        .finally(() => {
          running = false;
        })
        // `onError` is caller-supplied (a logger); if it throws, the rejection
        // would be unhandled and the process would exit. The flag is already
        // reset by then, so the schedule survives.
        .catch(() => {});
    },
  };
}
