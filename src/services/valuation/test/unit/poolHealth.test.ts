import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  monitorPool,
  PoolHealth,
  reportPoolFindings,
  type PoolFindings,
  type PoolHealthLogger,
} from '../../src/db/poolHealth.js';

/**
 * The connection-leak detector, which nothing had ever checked.
 *
 * It is the only thing on this service that can answer "why is the pool
 * exhausted" with a file and a line number, and it was at 0% — so every
 * property in its header comment was a claim rather than a fact. That matters
 * more here than the coverage does: a leak detector is code that only runs
 * when something has already gone wrong, so a bug in it is discovered during
 * the incident it was written for.
 *
 * The clock is injected, so none of this waits.
 */

/** A pool stub: three counters and nothing else, which is all `sample()` reads. */
function fakePool(counts: { total: number; idle: number; waiting: number }) {
  return {
    get totalCount() {
      return counts.total;
    },
    get idleCount() {
      return counts.idle;
    },
    get waitingCount() {
      return counts.waiting;
    },
  } as unknown as pg.Pool;
}

function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('PoolHealth — checkout tracking', () => {
  it('counts what is out and how old the oldest is', () => {
    const c = clock();
    const health = new PoolHealth(fakePool({ total: 4, idle: 2, waiting: 0 }), {
      max: 10,
      now: c.now,
    });

    const a = health.acquired();
    c.advance(3_000);
    health.acquired();

    const snap = health.peek();
    expect(snap.checkedOut).toBe(2);
    expect(snap.oldestCheckoutMs).toBe(3_000);

    health.released(a);
    expect(health.peek().checkedOut).toBe(1);
    // The younger checkout is now the oldest, so the age drops rather than
    // sticking at the high-water mark.
    expect(health.peek().oldestCheckoutMs).toBe(0);
  });

  it('tolerates a double release and a release of nothing', () => {
    const health = new PoolHealth(fakePool({ total: 1, idle: 0, waiting: 0 }), { max: 5 });
    const id = health.acquired();
    health.released(id);
    health.released(id);
    health.released(null);
    expect(health.peek().checkedOut).toBe(0);
  });

  it('stops tracking rather than growing past its ceiling', () => {
    // The tracker must never become the leak it is looking for.
    const health = new PoolHealth(fakePool({ total: 1, idle: 0, waiting: 0 }), {
      max: 5,
      maxTracked: 3,
    });
    expect([health.acquired(), health.acquired(), health.acquired()].every((id) => id !== null)).toBe(true);
    expect(health.acquired()).toBeNull();
    expect(health.peek().checkedOut).toBe(3);
  });

  it('captures the acquisition stack by default, and drops it when told to', () => {
    // Both are sampled past the threshold, so what differs between them is the
    // stack and not whether a leak was found at all.
    const leakOf = (captureStacks: boolean) => {
      const c = clock();
      const health = new PoolHealth(fakePool({ total: 1, idle: 0, waiting: 0 }), {
        max: 5,
        leakAfterMs: 100,
        captureStacks,
        now: c.now,
      });
      health.acquired();
      c.advance(1_000);
      return health.sample().leaks[0]!;
    };

    expect(leakOf(true).stack).toContain('pool checkout');
    // The escape hatch for a service that cannot afford an Error per checkout.
    // It costs the only field that turns "the pool is exhausted" into a line
    // number, which is why it is not the default.
    expect(leakOf(false).stack).toBeNull();
  });
});

describe('PoolHealth — leak detection', () => {
  const pool = () => fakePool({ total: 2, idle: 1, waiting: 0 });

  it('says nothing about a checkout that is merely slow', () => {
    // The property the header calls out: a long-but-legitimate transaction is
    // not a leak, and a detector that cries wolf gets turned off.
    const c = clock();
    const health = new PoolHealth(pool(), { max: 10, leakAfterMs: 60_000, now: c.now });
    health.acquired();
    c.advance(59_999);
    expect(health.sample().leaks).toEqual([]);
    expect(health.peek().suspectedLeaks).toBe(0);
  });

  it('reports one past the threshold, with the stack that took it', () => {
    const c = clock();
    const health = new PoolHealth(pool(), { max: 10, leakAfterMs: 60_000, now: c.now });
    const id = health.acquired();
    c.advance(60_001);

    const { leaks } = health.sample();
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.id).toBe(id);
    expect(leaks[0]!.heldMs).toBe(60_001);
    expect(leaks[0]!.stack).toContain('pool checkout');
  });

  it('reports each leak once, not on every sample', () => {
    // A log line per sample for as long as the condition lasts buries the
    // onset, and the onset is the part with diagnostic value.
    const c = clock();
    const health = new PoolHealth(pool(), { max: 10, leakAfterMs: 1_000, now: c.now });
    health.acquired();
    c.advance(2_000);

    expect(health.sample().leaks).toHaveLength(1);
    c.advance(60_000);
    expect(health.sample().leaks).toEqual([]);
    // Still counted, though — it has not gone away just because it was said.
    expect(health.peek().suspectedLeaks).toBe(1);
    expect(health.peek().leaksDetected).toBe(1);
  });

  it('counts leaks cumulatively, even after the client is finally released', () => {
    const c = clock();
    const health = new PoolHealth(pool(), { max: 10, leakAfterMs: 1_000, now: c.now });
    const id = health.acquired();
    c.advance(2_000);
    health.sample();
    health.released(id);

    const snap = health.peek();
    expect(snap.checkedOut).toBe(0);
    expect(snap.suspectedLeaks).toBe(0);
    // The tally is the record that it happened at all — a process that leaked
    // once an hour and recovered would otherwise read as never having leaked.
    expect(snap.leaksDetected).toBe(1);
  });

  it('does not report a leak through peek — gauges must not have side effects', () => {
    const c = clock();
    const health = new PoolHealth(pool(), { max: 10, leakAfterMs: 1_000, now: c.now });
    health.acquired();
    c.advance(2_000);

    expect(health.peek().suspectedLeaks).toBe(1);
    // `peek` counts by age; `sample` is what marks a checkout reported. If
    // peek had marked it, this sample would find nothing and the alert would
    // depend on whether a dashboard happened to be open.
    expect(health.sample().leaks).toHaveLength(1);
  });
});

describe('PoolHealth — exhaustion', () => {
  it('needs all three conditions, not any one of them', () => {
    const c = clock();
    // At `max` but with idle clients: a pool that grew and is now quiet.
    const quiet = new PoolHealth(fakePool({ total: 10, idle: 4, waiting: 0 }), {
      max: 10,
      exhaustedAfterMs: 0,
      now: c.now,
    });
    expect(quiet.sample().exhausted).toBe(false);

    // Busy, nothing idle, nobody queued: fully used is not exhausted.
    const busy = new PoolHealth(fakePool({ total: 10, idle: 0, waiting: 0 }), {
      max: 10,
      exhaustedAfterMs: 0,
      now: c.now,
    });
    expect(busy.sample().exhausted).toBe(false);

    // Callers queued but the pool has not reached its ceiling: it can still grow.
    const growing = new PoolHealth(fakePool({ total: 6, idle: 0, waiting: 3 }), {
      max: 10,
      exhaustedAfterMs: 0,
      now: c.now,
    });
    expect(growing.sample().exhausted).toBe(false);
  });

  it('waits out the dwell time before calling it exhausted', () => {
    // At any instant a healthy service under load has callers waiting.
    // Alerting on the instant alerts constantly.
    const c = clock();
    const health = new PoolHealth(fakePool({ total: 10, idle: 0, waiting: 2 }), {
      max: 10,
      exhaustedAfterMs: 5_000,
      now: c.now,
    });

    expect(health.sample().exhausted).toBe(false);
    c.advance(4_999);
    expect(health.sample().exhausted).toBe(false);
    c.advance(2);
    const findings = health.sample();
    expect(findings.exhausted).toBe(true);
    expect(findings.snapshot.exhaustedForMs).toBe(5_001);
  });

  it('reports an episode once, and arms again after it clears', () => {
    const c = clock();
    const counts = { total: 10, idle: 0, waiting: 2 };
    const health = new PoolHealth(fakePool(counts), {
      max: 10,
      exhaustedAfterMs: 1_000,
      now: c.now,
    });

    health.sample();
    c.advance(2_000);
    expect(health.sample().exhausted).toBe(true);
    c.advance(2_000);
    expect(health.sample().exhausted).toBe(false);

    // Recovery, then a second episode. Without the reset a service that
    // recovered and failed again would be silent the second time — which is
    // the time somebody needs to hear about it.
    counts.idle = 3;
    counts.waiting = 0;
    expect(health.sample().snapshot.exhaustedForMs).toBe(0);

    counts.idle = 0;
    counts.waiting = 4;
    health.sample();
    c.advance(2_000);
    expect(health.sample().exhausted).toBe(true);
  });

  it('caps saturation at 1 when the pool has grown past its stated max', () => {
    const health = new PoolHealth(fakePool({ total: 14, idle: 0, waiting: 0 }), { max: 10 });
    expect(health.sample().snapshot.saturation).toBe(1);
    expect(health.peek().saturation).toBe(1);
  });

  it('treats a max of zero as one rather than dividing by it', () => {
    const health = new PoolHealth(fakePool({ total: 0, idle: 0, waiting: 0 }), { max: 0 });
    expect(Number.isFinite(health.peek().saturation)).toBe(true);
    expect(health.peek().max).toBe(1);
  });
});

describe('monitorPool', () => {
  /** A pool stub whose `connect` hands out clients with a real `release`. */
  function connectablePool(opts: { releaseThrows?: boolean } = {}) {
    const released: number[] = [];
    let n = 0;
    const pool = {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
      connect(cb?: unknown) {
        const id = ++n;
        const client = {
          id,
          release() {
            released.push(id);
            // pg throws exactly this on a client released twice, which is the
            // case the wrapper's ordering exists for.
            if (opts.releaseThrows)
              throw new Error('Release called on a client which has already been released');
          },
        } as unknown as pg.PoolClient;
        if (typeof cb === 'function') {
          (cb as (e: undefined, c: pg.PoolClient, d: unknown) => void)(undefined, client, undefined);
          return undefined;
        }
        return Promise.resolve(client);
      },
    } as unknown as pg.Pool;
    return { pool, released };
  }

  it('tracks a promise-form checkout and clears it on release', async () => {
    const { pool, released } = connectablePool();
    const health = monitorPool(pool, { max: 5 });

    const client = await pool.connect();
    expect(health.peek().checkedOut).toBe(1);
    client.release();
    expect(health.peek().checkedOut).toBe(0);
    // The original release still ran — the wrapper must not swallow it.
    expect(released).toEqual([1]);
  });

  it('tracks the callback form too', () => {
    const { pool } = connectablePool();
    const health = monitorPool(pool, { max: 5 });

    let got: pg.PoolClient | undefined;
    (pool.connect as unknown as (cb: (e: undefined, c: pg.PoolClient) => void) => void)((_e, c) => {
      got = c;
    });
    // Leaving the callback form untracked would make the tracker silently
    // partial the moment anything reached for it.
    expect(health.peek().checkedOut).toBe(1);
    got!.release();
    expect(health.peek().checkedOut).toBe(0);
  });

  it('re-wraps release on every checkout, because pg replaces it each time', async () => {
    const { pool } = connectablePool();
    const health = monitorPool(pool, { max: 5 });

    const first = await pool.connect();
    const second = await pool.connect();
    expect(health.peek().checkedOut).toBe(2);
    second.release();
    first.release();
    // Wrapping once per physical client would leave every checkout after the
    // first untracked, and the count would stick at 1.
    expect(health.peek().checkedOut).toBe(0);
  });

  it('deregisters before the underlying release runs, so a throwing release leaves no phantom', async () => {
    const { pool, released } = connectablePool({ releaseThrows: true });
    const health = monitorPool(pool, { max: 5 });
    const client = await pool.connect();
    expect(health.peek().checkedOut).toBe(1);

    expect(() => client.release()).toThrow(/already been released/);
    // It threw, and the checkout is still accounted for. Deregistering after
    // the call would leave a record nothing can ever clear, which reads as a
    // leak forever — a leak detector inventing its own leak.
    expect(health.peek().checkedOut).toBe(0);
    expect(released).toEqual([1]);
  });

  it('does not instrument the same pool twice', async () => {
    const { pool } = connectablePool();
    const first = monitorPool(pool, { max: 5 });
    const second = monitorPool(pool, { max: 5 });

    await pool.connect();
    // Double-wrapping would record the checkout twice — once per layer — and
    // the second tracker never sees a release for it.
    expect(first.peek().checkedOut).toBe(1);
    expect(second.peek().checkedOut).toBe(0);
  });

  it('passes a synchronous non-promise return through untouched', () => {
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      connect: () => 'not a promise',
    } as unknown as pg.Pool;
    monitorPool(pool, { max: 5 });
    expect(pool.connect() as unknown).toBe('not a promise');
  });
});

describe('reportPoolFindings', () => {
  const logger = (): PoolHealthLogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } =>
    ({ warn: vi.fn(), error: vi.fn() }) as never;

  const findings = (over: Partial<PoolFindings> = {}): PoolFindings => ({
    snapshot: {
      total: 10,
      idle: 0,
      waiting: 3,
      max: 10,
      checkedOut: 10,
      saturation: 1,
      suspectedLeaks: 0,
      exhaustedForMs: 0,
      oldestCheckoutMs: 0,
      leaksDetected: 0,
    },
    leaks: [],
    exhausted: false,
    ...over,
  });

  it('logs the acquisition stack, which is the whole point of the report', () => {
    const log = logger();
    reportPoolFindings(
      findings({ leaks: [{ id: 7, heldMs: 90_000, stack: 'Error: pool checkout\n  at repo.ts:12' }] }),
      log,
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = log.error.mock.calls[0]!;
    expect(obj.acquiredAt).toContain('repo.ts:12');
    expect(obj.alert).toBe(true);
    expect(msg).toMatch(/suspected leak/i);
  });

  it('logs exhaustion separately from leaks, and both when both', () => {
    const log = logger();
    reportPoolFindings(findings({ leaks: [{ id: 1, heldMs: 1, stack: null }], exhausted: true }), log);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(String(log.error.mock.calls[1]![1])).toMatch(/pool exhausted/i);
  });

  it('says nothing at all when there is nothing wrong — the vacuity guard', () => {
    const log = logger();
    reportPoolFindings(findings(), log);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
