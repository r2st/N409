import { describe, expect, it, vi } from 'vitest';
import { nonOverlapping, sweepFailed, trackedSweep } from '../src/scheduler.js';
import { currentRequestId, currentSweep, runWithRequestId } from '../src/requestContext.js';

/** A promise plus the handles to settle it, so a tick can be held open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (the .catch/.finally chain) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('nonOverlapping', () => {
  it('runs the tick and reports itself idle once it settles', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const s = nonOverlapping(tick, () => {});
    expect(s.running).toBe(false);

    s.run();
    expect(s.running).toBe(true);
    await flush();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(s.running).toBe(false);
    expect(s.skipped).toBe(0);
  });

  it('drops a tick fired while one is still in flight, and counts it', async () => {
    const gate = deferred();
    const tick = vi.fn().mockReturnValue(gate.promise);
    const s = nonOverlapping(tick, () => {});

    s.run();
    s.run();
    s.run();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(s.skipped).toBe(2);

    gate.resolve();
    await flush();
    expect(s.running).toBe(false);

    // Once the slow tick has settled the schedule resumes as normal.
    s.run();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(s.skipped).toBe(2);
  });

  it('reports a rejected tick and keeps the schedule running', async () => {
    const boom = new Error('database is down');
    const onError = vi.fn();
    const tick = vi.fn().mockRejectedValue(boom);
    const s = nonOverlapping(tick, onError);

    s.run();
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(s.running).toBe(false);

    // The flag must not stay set — a scan against a database that is down fails
    // every time, and wedging after the first would stop the sweep forever.
    s.run();
    await flush();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('survives a tick that throws before it returns a promise', async () => {
    const boom = new Error('synchronous');
    const onError = vi.fn();
    const tick = vi.fn().mockImplementation(() => {
      throw boom;
    });
    const s = nonOverlapping(tick, onError);

    expect(() => s.run()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    // No `.finally()` chain is ever reached on a synchronous throw, so this is
    // the case that would have left `running` set for the process's life.
    expect(s.running).toBe(false);

    s.run();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does not let a throwing error handler become an unhandled rejection', async () => {
    const s = nonOverlapping(
      () => Promise.reject(new Error('tick failed')),
      () => {
        throw new Error('the logger failed too');
      },
    );

    s.run();
    await flush();
    // Unhandled here means the process exits — installCrashHandlers treats an
    // unhandledRejection as fatal.
    expect(s.running).toBe(false);
    s.run();
    await flush();
    expect(s.running).toBe(false);
  });

  it('never overlaps across a burst of interleaved ticks', async () => {
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    const s = nonOverlapping(
      () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.push(() => {
          active -= 1;
          gate.resolve();
        });
        return gate.promise;
      },
      () => {},
    );

    for (let i = 0; i < 10; i++) {
      s.run();
      if (i % 3 === 0) {
        gates.shift()?.();
        await flush();
      }
    }
    gates.forEach((g) => g());
    await flush();

    expect(maxActive).toBe(1);
    expect(s.running).toBe(false);
  });
});

describe('Scheduler.whenIdle', () => {
  it('resolves immediately when no tick is in flight', async () => {
    const s = nonOverlapping(
      async () => {},
      () => {},
    );
    let settled = false;
    void s.whenIdle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(true);
  });

  it('waits for the in-flight tick and resolves only once it finishes', async () => {
    const gate = deferred();
    const s = nonOverlapping(
      () => gate.promise,
      () => {},
    );
    s.run();

    let settled = false;
    void s.whenIdle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(s.running).toBe(true);

    gate.resolve();
    await flush();
    expect(settled).toBe(true);
    expect(s.running).toBe(false);
  });

  // A failed tick is finished business: onError has already run by the time the
  // waiter wakes, so a shutdown must not hang on it.
  it('resolves when the in-flight tick rejects', async () => {
    const gate = deferred();
    const onError = vi.fn();
    const s = nonOverlapping(() => gate.promise, onError);
    s.run();

    const idle = s.whenIdle();
    gate.reject(new Error('scan failed'));
    await idle;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.running).toBe(false);
  });

  // The synchronous-throw path resets the flag on its own line rather than
  // through the `.finally()` chain, and used to do it without waking anybody.
  it('resolves when the tick throws synchronously', async () => {
    const onError = vi.fn();
    const s = nonOverlapping(() => {
      throw new Error('sync');
    }, onError);

    s.run();
    let settled = false;
    void s.whenIdle().then(() => {
      settled = true;
    });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.running).toBe(false);
    expect(settled).toBe(true);
  });

  it('wakes every waiter registered against one tick', async () => {
    const gate = deferred();
    const s = nonOverlapping(
      () => gate.promise,
      () => {},
    );
    s.run();
    const settled: number[] = [];
    void s.whenIdle().then(() => settled.push(1));
    void s.whenIdle().then(() => settled.push(2));
    void s.whenIdle().then(() => settled.push(3));

    gate.resolve();
    await flush();
    expect(settled.sort()).toEqual([1, 2, 3]);
  });
});

describe('sweepFailed', () => {
  function recorder() {
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    return {
      warns,
      errors,
      log: {
        warn: (obj: Record<string, unknown>, msg: string) => void warns.push({ obj, msg }),
        error: (obj: Record<string, unknown>, msg: string) => void errors.push({ obj, msg }),
      },
    };
  }

  /** A transport failure, in the shape the classifier reads it from. */
  function syscallError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  it('names the sweep in a field, not only in the message', () => {
    // The saturation gauges beside these schedulers label by `sweep`; the
    // failure line has to answer with the same key or "which sweep is failing"
    // stays a substring match against prose.
    const { log, errors } = recorder();
    sweepFailed(log, 'hris-sync')(new TypeError('x is not a function'));
    expect(errors[0]!.obj).toMatchObject({ sweep: 'hris-sync' });
  });

  it('flags a permanent failure for alerting', () => {
    const { log, errors, warns } = recorder();
    sweepFailed(log, 'retention')(new TypeError('cannot read properties of undefined'));
    expect(warns).toHaveLength(0);
    expect(errors[0]!.obj).toMatchObject({ sweep: 'retention', failure_kind: 'permanent', alert: true });
  });

  it('does not alert on a transient failure — the next tick is the retry', () => {
    // A sweep that lost the database during a deploy used to log identically to
    // one with a bug in it, which is how a level stops carrying information.
    const { log, errors, warns } = recorder();
    sweepFailed(log, 'email-retry')(syscallError('ECONNREFUSED'));
    expect(errors).toHaveLength(0);
    expect(warns[0]!.obj).toMatchObject({ sweep: 'email-retry', failure_kind: 'transient' });
    expect(warns[0]!.obj.alert).toBeUndefined();
  });

  it('alerts on an unrecognised failure rather than quietly downgrading it', () => {
    const { log, errors } = recorder();
    sweepFailed(log, 'housekeeping')('a bare string nobody classified');
    expect(errors[0]!.obj).toMatchObject({ failure_reason: 'unclassified', alert: true });
  });

  it('is what nonOverlapping calls, so a rejected tick is reported and the schedule survives', async () => {
    const { log, errors } = recorder();
    const s = nonOverlapping(() => Promise.reject(new TypeError('boom')), sweepFailed(log, 'job-alerts'));
    s.run();
    await flush();
    expect(errors[0]!.obj).toMatchObject({ sweep: 'job-alerts', alert: true });
    expect(s.running).toBe(false);
  });
});

/**
 * A sweep's tick is correlated the way a request is.
 *
 * `sweepFailed` described the outside of a tick and the gauges labelled it; the
 * inside was anonymous. These hold the binding to the door every sweep goes
 * through, because a *missing* log field is the one defect nothing else notices.
 */
describe('trackedSweep', () => {
  it('binds the sweep name for the whole tick, including after an await', async () => {
    const seen: Array<{ name: string; runId: string } | undefined> = [];
    const s = trackedSweep({ warn: () => {}, error: () => {} }, 'email-retry', async () => {
      seen.push(currentSweep());
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentSweep());
    });

    s.run();
    await s.whenIdle();

    expect(seen).toHaveLength(2);
    expect(seen[0]?.name).toBe('email-retry');
    expect(seen[1]).toEqual(seen[0]);
  });

  it('gives each tick its own run id, which is what grouping needs', async () => {
    const runIds: string[] = [];
    const s = trackedSweep({ warn: () => {}, error: () => {} }, 'retention', async () => {
      runIds.push(currentSweep()!.runId);
    });

    s.run();
    await s.whenIdle();
    s.run();
    await s.whenIdle();

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
  });

  it('leaves nothing bound once the tick has settled', async () => {
    const s = trackedSweep({ warn: () => {}, error: () => {} }, 'housekeeping', async () => {});
    s.run();
    await s.whenIdle();
    expect(currentSweep()).toBeUndefined();
  });

  it('keeps a request id the caller already had', async () => {
    // The ops-triggered run. Dropping the id here would lose the correlation
    // the request half of this module exists for.
    let seen: string | undefined;
    const s = trackedSweep({ warn: () => {}, error: () => {} }, 'auto-email', async () => {
      seen = currentRequestId();
    });

    runWithRequestId('REQ-1', () => s.run());
    await s.whenIdle();

    expect(seen).toBe('REQ-1');
  });

  it('still classifies and reports a failing tick', async () => {
    // The alerting contract `sweepFailed` carries must survive the wrapping.
    const error = vi.fn();
    const s = trackedSweep({ warn: vi.fn(), error }, 'webhook-retry', async () => {
      throw new Error('boom');
    });

    s.run();
    await s.whenIdle();
    await flush();

    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toMatchObject({ sweep: 'webhook-retry' });
  });

  it('still refuses to overlap', async () => {
    const gate = deferred();
    const s = trackedSweep({ warn: () => {}, error: () => {} }, 'hris-sync', () => gate.promise);

    s.run();
    s.run();
    expect(s.skipped).toBe(1);
    gate.resolve();
    await s.whenIdle();
  });
});
