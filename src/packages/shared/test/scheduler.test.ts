import { describe, expect, it, vi } from 'vitest';
import { nonOverlapping } from '../src/scheduler.js';

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
