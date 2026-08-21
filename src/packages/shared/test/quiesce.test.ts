import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUIESCE_TIMEOUT_MS,
  nonOverlapping,
  quiesce,
  quiesceAndLog,
  type NamedScheduler,
} from '../src/scheduler.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A scheduler held open by `gate`, under the name quiesce will report. */
function held(name: string) {
  const gate = deferred();
  const scheduler = nonOverlapping(
    () => gate.promise,
    () => {},
  );
  scheduler.run();
  return { named: { name, scheduler } satisfies NamedScheduler, gate };
}

describe('quiesce', () => {
  it('costs nothing when every scheduler is already idle', async () => {
    const a = nonOverlapping(
      async () => {},
      () => {},
    );
    const b = nonOverlapping(
      async () => {},
      () => {},
    );
    const result = await quiesce([
      { name: 'a', scheduler: a },
      { name: 'b', scheduler: b },
    ]);
    expect(result).toEqual({ idle: true, running: [], waitedMs: 0 });
  });

  it('is idle with nothing to wait on', async () => {
    expect(await quiesce([])).toEqual({ idle: true, running: [], waitedMs: 0 });
  });

  it('waits for every in-flight tick before reporting idle', async () => {
    const one = held('email-retry');
    const two = held('retention');
    const idleOnly = nonOverlapping(
      async () => {},
      () => {},
    );

    let done: Awaited<ReturnType<typeof quiesce>> | undefined;
    void quiesce([one.named, two.named, { name: 'housekeeping', scheduler: idleOnly }], {
      timeoutMs: 10_000,
    }).then((r) => {
      done = r;
    });

    await flush();
    expect(done).toBeUndefined();

    one.gate.resolve();
    await flush();
    // Still one sweep outstanding — the wait covers the whole set, not the first.
    expect(done).toBeUndefined();

    two.gate.resolve();
    await flush();
    expect(done?.idle).toBe(true);
    expect(done?.running).toEqual([]);
  });

  it('names what is still running when the deadline is reached', async () => {
    const stuck = held('cap-table-sync');
    const finishes = held('webhook-retry');
    finishes.gate.resolve();
    await flush();

    const result = await quiesce([stuck.named, finishes.named], { timeoutMs: 20 });
    expect(result.idle).toBe(false);
    expect(result.running).toEqual(['cap-table-sync']);
    // Reported so a shutdown that routinely overran is visible in the log.
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);

    stuck.gate.resolve();
  });

  // The exit code belongs to the shutdown handler; a sweep that rejected during
  // the wait is finished, not a reason for quiesce itself to reject.
  it('does not reject when a tick fails during the wait', async () => {
    const gate = deferred();
    const onError = vi.fn();
    const scheduler = nonOverlapping(() => gate.promise, onError);
    scheduler.run();

    const pending = quiesce([{ name: 'job-alerts', scheduler }], { timeoutMs: 10_000 });
    gate.reject(new Error('database is gone'));
    const result = await pending;

    expect(result.idle).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // A tick that settles inside the race but whose wake-up had not yet been
  // delivered when the deadline fired must not be reported as still running.
  it('re-reads running rather than trusting which promise won the race', async () => {
    const scheduler = { running: true, whenIdle: () => new Promise<void>(() => {}) };
    const named: NamedScheduler = { name: 'reaper', scheduler };
    const pending = quiesce([named], { timeoutMs: 10 });
    setTimeout(() => {
      scheduler.running = false;
    }, 1);
    expect((await pending).idle).toBe(true);
  });

  it('measures the wait with the injected clock', async () => {
    const stuck = held('retention');
    let t = 1_000;
    const result = await quiesce([stuck.named], {
      timeoutMs: 5,
      now: () => {
        const at = t;
        t += 250;
        return at;
      },
    });
    expect(result.waitedMs).toBe(250);
    stuck.gate.resolve();
  });
});

describe('quiesceAndLog', () => {
  it('says nothing when there was nothing to wait for', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    await quiesceAndLog([], log);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports the wait when a sweep finished during it', async () => {
    const one = held('email-retry');
    const log = { info: vi.fn(), warn: vi.fn() };
    const pending = quiesceAndLog([one.named], log, { timeoutMs: 10_000 });
    setTimeout(() => one.gate.resolve(), 5);
    const result = await pending;

    expect(result.idle).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ waitedMs: expect.any(Number) }),
      'background sweeps finished',
    );
  });

  it('warns with the names and the bound when the deadline is reached', async () => {
    const stuck = held('housekeeping');
    const log = { info: vi.fn(), warn: vi.fn() };
    await quiesceAndLog([stuck.named], log, { timeoutMs: 15 });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { running: ['housekeeping'], timeoutMs: 15 },
      'quiesce deadline reached — exiting with background sweeps still running',
    );
    stuck.gate.resolve();
  });

  it('falls back to the default bound in the warning', async () => {
    const stuck = held('reaper');
    const log = { info: vi.fn(), warn: vi.fn() };
    // Forced past the deadline without waiting five seconds for it: `running`
    // is what quiesce re-reads, and a scheduler reporting itself busy with an
    // immediately-resolving whenIdle exercises the default-bound branch.
    await quiesceAndLog([{ name: 'reaper', scheduler: { running: true, whenIdle: async () => {} } }], log);
    expect(log.warn).toHaveBeenCalledWith(
      { running: ['reaper'], timeoutMs: DEFAULT_QUIESCE_TIMEOUT_MS },
      'quiesce deadline reached — exiting with background sweeps still running',
    );
    stuck.gate.resolve();
  });
});
