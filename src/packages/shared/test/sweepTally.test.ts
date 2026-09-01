import { describe, expect, it } from 'vitest';
import { sweepTally } from '../src/scheduler.js';

/**
 * The extraction that turns a sweep's own tally into counter series.
 *
 * The point of the extraction, rather than a registration per sweep, is that
 * the counter arrives by construction: a tick returns the tally it already had
 * and the field names become the `outcome` labels. That only holds if the
 * extraction is conservative about what a "count" is — a tally field that is a
 * duration, an id, a list or a nested map must not silently become a
 * monotonically increasing series that a rule can then be written against.
 */
describe('sweepTally', () => {
  it('reads every finite non-negative number off the tally', () => {
    expect(sweepTally({ attempted: 4, sent: 3, failed: 1, retired: 0 })).toEqual([
      { outcome: 'attempted', value: 4 },
      { outcome: 'sent', value: 3 },
      { outcome: 'failed', value: 1 },
      { outcome: 'retired', value: 0 },
    ]);
  });

  it('keeps a zero, because a tick that did nothing is a reading', () => {
    // Not merely tidiness: `rate()` over a series that only appears when it is
    // non-zero cannot tell "no failures" from "this sweep stopped reporting",
    // which is the same confusion the whole instrument exists to remove.
    expect(sweepTally({ failed: 0 })).toEqual([{ outcome: 'failed', value: 0 }]);
  });

  it('drops the fields of a tally that are not counts', () => {
    // `HousekeepingResult` is the live example: `removed` is a per-table map and
    // `capped` a list of table names, and only `total` is a number to count.
    expect(sweepTally({ removed: { users: 3 }, capped: ['users'], total: 3 })).toEqual([
      { outcome: 'total', value: 3 },
    ]);
  });

  it('refuses a negative or non-finite reading', () => {
    // A counter that goes backwards makes `rate()` nonsense for the rest of the
    // process's life, and the caller is a wrapper that cannot check.
    expect(sweepTally({ drift: -1, ratio: Number.NaN, unbounded: Number.POSITIVE_INFINITY, ok: 2 })).toEqual([
      { outcome: 'ok', value: 2 },
    ]);
  });

  it('has nothing to say about a tick that returned no tally', () => {
    // Every shape a tick has actually returned over this codebase's life: a
    // bare `undefined` from a sweep whose body ends in an `if`, and the arrays
    // the two reapers used to hand back before they counted their own length.
    expect(sweepTally(undefined)).toEqual([]);
    expect(sweepTally(null)).toEqual([]);
    expect(sweepTally([{ id: 'a' }, { id: 'b' }])).toEqual([]);
    expect(sweepTally(7)).toEqual([]);
    expect(sweepTally('done')).toEqual([]);
  });
});
