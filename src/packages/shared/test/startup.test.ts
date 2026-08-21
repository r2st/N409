import { describe, expect, it, vi } from 'vitest';
import { awaitDependencies, StartupGate } from '../src/startup.js';
import { markFailure } from '../src/failure.js';

/**
 * `awaitDependencies` is the boot's gate, so every one of these drives it with
 * an injected clock and sleep: the point of the retry ladder is what it decides,
 * not how long it takes, and a test that waits for real backoff would be
 * measuring `setTimeout`.
 */

function fakeLog() {
  const info: { obj: Record<string, unknown>; msg: string }[] = [];
  const warn: { obj: Record<string, unknown>; msg: string }[] = [];
  const error: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    log: {
      info: (obj: Record<string, unknown>, msg: string) => void info.push({ obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => void warn.push({ obj, msg }),
      error: (obj: Record<string, unknown>, msg: string) => void error.push({ obj, msg }),
    },
    info,
    warn,
    error,
  };
}

/**
 * A clock that only moves when a sleep is awaited, so elapsed time is exactly
 * the sum of the ladder and the deadline arithmetic is deterministic.
 */
function fakeClock(startAt = 1_000) {
  let t = startAt;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
}

/** A transient error: ECONNREFUSED is the cold-start case this exists for. */
function connRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
}

/** A probe that fails `failures` times and then succeeds. */
function flaky(failures: number, err: () => Error = connRefused) {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls <= failures) throw err();
  });
}

describe('awaitDependencies', () => {
  it('reports ok on the first attempt when everything answers', async () => {
    const probe = vi.fn(async () => {});
    const clock = fakeClock();
    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.degraded).toEqual([]);
    expect(result.outcomes).toEqual([
      { name: 'postgres', required: true, ok: true, attempts: 1, error: null },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
  });

  it('treats a check with no `required` flag as required', async () => {
    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe: async () => {} }],
      ...fakeClock(),
    });
    expect(result.outcomes[0]?.required).toBe(true);
  });

  it('retries a transient failure and reports the attempt it came up on', async () => {
    const probe = flaky(2);
    const clock = fakeClock();
    const { log, info } = fakeLog();

    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      sleep: clock.sleep,
      now: clock.now,
      log,
      random: () => 1,
      baseDelayMs: 250,
    });

    expect(result.ok).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ ok: true, attempts: 3, error: null });
    // Full jitter with random()===1 is the bare exponential: 250, 500.
    expect(clock.slept).toEqual([250, 500]);
    expect(info.map((e) => e.msg)).toEqual(['dependency became available']);
    expect(info[0]?.obj).toMatchObject({ dependency: 'postgres', attempts: 3 });
  });

  it('caps a single delay at maxDelayMs', async () => {
    const probe = flaky(4);
    const clock = fakeClock();
    await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      sleep: clock.sleep,
      now: clock.now,
      random: () => 1,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      timeoutMs: 10 * 60_000,
    });
    expect(clock.slept).toEqual([1_000, 2_000, 2_000, 2_000]);
  });

  it('gives an optional dependency exactly one attempt and starts degraded', async () => {
    const probe = flaky(10);
    const clock = fakeClock();
    const { log, warn } = fakeLog();

    const result = await awaitDependencies({
      checks: [{ name: 'ai', probe, required: false }],
      sleep: clock.sleep,
      now: clock.now,
      log,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
    // Optional failure is not a boot failure — `ok` stays true.
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.degraded).toEqual(['ai']);
    expect(result.outcomes[0]).toMatchObject({
      required: false,
      ok: false,
      attempts: 1,
      error: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
    expect(warn.map((e) => e.msg)).toEqual([
      'optional dependency is unavailable — starting in degraded mode',
    ]);
    expect(warn[0]?.obj).toMatchObject({ dependency: 'ai', failure_reason: 'syscall.ECONNREFUSED' });
  });

  it('does not retry a permanent failure, and alerts on it', async () => {
    // A wrong password is not a cold start; waiting out the budget only delays
    // the useful outcome by exactly `timeoutMs`.
    const probe = vi.fn(async () => {
      throw markFailure(new Error('password authentication failed for user "n409"'), 'permanent');
    });
    const clock = fakeClock();
    const { log, error } = fakeLog();

    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      sleep: clock.sleep,
      now: clock.now,
      log,
      timeoutMs: 60_000,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['postgres']);
    expect(result.outcomes[0]).toMatchObject({
      ok: false,
      attempts: 1,
      error: 'password authentication failed for user "n409"',
    });
    expect(error.map((e) => e.msg)).toEqual(['required dependency failed permanently — not retrying']);
    expect(error[0]?.obj).toMatchObject({ alert: true, failure_reason: 'marked' });
  });

  it('gives up when the next delay would land past the deadline', async () => {
    const probe = flaky(100);
    const clock = fakeClock();
    const { log, error, warn } = fakeLog();

    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      sleep: clock.sleep,
      now: clock.now,
      log,
      random: () => 1,
      baseDelayMs: 250,
      timeoutMs: 1_000,
    });

    // 250 + 500 puts the clock at 750; the next delay of 1000 would land at
    // 1750, past the 1000ms budget, so the third failure is the last.
    expect(clock.slept).toEqual([250, 500]);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['postgres']);
    expect(result.outcomes[0]).toMatchObject({ ok: false, attempts: 3 });
    expect(warn.map((e) => e.msg)).toEqual([
      'dependency not ready yet — retrying',
      'dependency not ready yet — retrying',
    ]);
    expect(warn[0]?.obj).toMatchObject({ dependency: 'postgres', attempts: 1, delayMs: 250 });
    expect(error.map((e) => e.msg)).toEqual([
      'required dependency did not become available within the startup budget',
    ]);
    expect(error[0]?.obj).toMatchObject({ alert: true, attempts: 3 });
  });

  it('defaults the ladder to 250ms base and a 5s ceiling', async () => {
    // The services pass neither, so the defaults are what production runs.
    const probe = flaky(100);
    const clock = fakeClock();
    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      sleep: clock.sleep,
      now: clock.now,
      random: () => 1,
      timeoutMs: 100,
    });
    // The first delay is the un-overridden base, and it already overshoots the
    // 100ms budget, so the boot gives up rather than sleeping past its deadline.
    expect(clock.slept).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.missing).toEqual(['postgres']);
  });

  it('never throws — a dependency that is down is a result, not an exception', async () => {
    // Including one that rejects with a non-Error, which the message extraction
    // has to stringify rather than read `.message` off.
    const clock = fakeClock();
    const result = await awaitDependencies({
      checks: [{ name: 'ai', required: false, probe: async () => Promise.reject('gateway said no') }],
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.degraded).toEqual(['ai']);
    expect(result.outcomes[0]?.error).toBe('gateway said no');
  });

  it('probes every dependency concurrently and separates missing from degraded', async () => {
    const clock = fakeClock();
    const result = await awaitDependencies({
      checks: [
        { name: 'postgres', probe: async () => {}, required: true },
        {
          name: 'redis',
          probe: async () => {
            throw markFailure(new Error('nope'), 'permanent');
          },
          required: true,
        },
        {
          name: 'ai',
          probe: async () => {
            throw new Error('502');
          },
          required: false,
        },
      ],
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['redis']);
    expect(result.degraded).toEqual(['ai']);
    expect(result.outcomes.map((o) => o.name)).toEqual(['postgres', 'redis', 'ai']);
  });

  it('reports elapsed time from the injected clock', async () => {
    const clock = fakeClock();
    const result = await awaitDependencies({
      checks: [
        {
          name: 'postgres',
          probe: async () => {
            clock.advance(1_234);
          },
        },
      ],
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.elapsedMs).toBe(1_234);
  });

  it('accepts an empty check list', async () => {
    const result = await awaitDependencies({ checks: [], ...fakeClock() });
    expect(result).toMatchObject({ ok: true, outcomes: [], missing: [], degraded: [] });
  });

  it('works with no logger and no injected clock', async () => {
    // The production call site passes a logger; the defaults still have to hold,
    // and `defaultSleep` is the one line only a real retry reaches.
    const probe = flaky(1);
    const result = await awaitDependencies({
      checks: [{ name: 'postgres', probe }],
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('StartupGate', () => {
  it('is not ready before the boot says so', async () => {
    const gate = new StartupGate('valuation');
    expect(gate.ready).toBe(false);
    await expect(gate.check()).rejects.toThrow(
      'valuation is still starting up — dependencies have not been verified yet',
    );
  });

  it('goes green once markReady is called', async () => {
    const gate = new StartupGate('valuation');
    gate.markReady();
    expect(gate.ready).toBe(true);
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it('reports the reason a failed boot gave', async () => {
    const gate = new StartupGate('valuation');
    gate.markFailed('migrations failed: 0161 checksum mismatch');
    expect(gate.ready).toBe(false);
    await expect(gate.check()).rejects.toThrow('migrations failed: 0161 checksum mismatch');
  });

  it('clears a previous failure when the boot later succeeds', async () => {
    const gate = new StartupGate('valuation');
    gate.markFailed('postgres unreachable');
    gate.markReady();
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it('goes red again when a later boot step fails', async () => {
    const gate = new StartupGate('report');
    gate.markReady();
    gate.markFailed('template store unreadable');
    expect(gate.ready).toBe(false);
    await expect(gate.check()).rejects.toThrow('template store unreadable');
  });

  it('keeps `check` bound, so it can be handed off as a ReadinessCheck', async () => {
    const gate = new StartupGate('web');
    const { check } = gate;
    await expect(check()).rejects.toThrow(/web is still starting up/);
    gate.markReady();
    await expect(check()).resolves.toBeUndefined();
  });
});
