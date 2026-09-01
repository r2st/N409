import { describe, expect, it, vi } from 'vitest';
import { sweepTally } from '@n409/shared';
import { HOUSEKEEPING_TARGETS } from '../../src/domain/housekeeping.js';
import { runHousekeepingSweep } from '../../src/hooks/housekeeping.js';

/**
 * A housekeeping pass that deleted nothing because it *could* not (R332, M5).
 *
 * The per-target containment is right and stays — five unrelated tables, and a
 * sweep that gives up on the first error is one that stops running entirely the
 * day a migration holds a lock on one of them. What it lacked was any way to
 * say so beyond an `error` line: the tick returns normally when all five
 * statements are refused, so `background_sweep_failures_total` never moves, and
 * the tally it returned was byte-for-byte what a healthy pass with nothing to
 * delete returns.
 *
 * `sweepTally` names the outcome after the tally's field, which is why the
 * fix is a field: `background_sweep_items_total{outcome="failed"}` is what
 * `SweepWorkFailing` reads, and every other containing sweep on this platform
 * already carried it.
 */
function poolThatRefuses(): { pool: never; calls: () => number } {
  let calls = 0;
  const pool = {
    query: vi.fn(async () => {
      calls += 1;
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    }),
  };
  return { pool: pool as never, calls: () => calls };
}

function poolThatDeletesNothing(): never {
  return { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) } as never;
}

describe('housekeeping failure accounting', () => {
  it('counts a refused target rather than reporting it as an empty one', async () => {
    const log = { error: vi.fn(), info: vi.fn() };
    const { pool, calls } = poolThatRefuses();

    const result = await runHousekeepingSweep({ pool, log: log as never });

    expect(calls()).toBe(HOUSEKEEPING_TARGETS.length);
    expect(result.failed).toBe(HOUSEKEEPING_TARGETS.length);
    expect(result.total).toBe(0);
    // The containment itself is unchanged: every target was still attempted and
    // every failure still reached the journal.
    expect(log.error).toHaveBeenCalledTimes(HOUSEKEEPING_TARGETS.length);
  });

  it('is distinguishable from a healthy pass with nothing to delete', async () => {
    const idle = await runHousekeepingSweep({ pool: poolThatDeletesNothing() });
    const { pool } = poolThatRefuses();
    const broken = await runHousekeepingSweep({ pool, log: { error: vi.fn() } as never });

    // The two used to be the same object. `total` still cannot tell them apart
    // — that is the point — so the field that can is the one that matters.
    expect(idle.total).toBe(broken.total);
    expect(idle.failed).toBe(0);
    expect(broken.failed).toBeGreaterThan(0);
  });

  it('reaches the scrape as the outcome SweepWorkFailing reads', async () => {
    const { pool } = poolThatRefuses();
    const result = await runHousekeepingSweep({ pool, log: { error: vi.fn() } as never });

    const failed = sweepTally(result).find((o) => o.outcome === 'failed');
    expect(failed).toEqual({ outcome: 'failed', value: HOUSEKEEPING_TARGETS.length });
  });

  it('leaves a healthy pass reporting no failures at all', async () => {
    const result = await runHousekeepingSweep({ pool: poolThatDeletesNothing() });
    expect(sweepTally(result).find((o) => o.outcome === 'failed')).toEqual({
      outcome: 'failed',
      value: 0,
    });
  });
});
