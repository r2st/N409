import { describe, expect, it } from 'vitest';
import {
  evaluateTriggers,
  overallStatus,
  reconcileBaselineShares,
  type MonitorSnapshot,
} from '../../src/domain/monitoring.js';

const baseline: MonitorSnapshot = {
  valuation_date: '2026-01-01',
  fmv_per_share: 1.5,
  annual_revenue: 1_000_000,
  fully_diluted_shares: 10_000_000,
  last_round_date: '2025-06-01',
};

// Same as baseline unless overridden.
const same: MonitorSnapshot = { ...baseline, valuation_date: null };

describe('monitoring', () => {
  it('fires nothing when nothing has changed and within the window', () => {
    const triggers = evaluateTriggers(baseline, same, new Date('2026-03-01T00:00:00Z'));
    expect(triggers).toHaveLength(0);
    expect(overallStatus(triggers)).toBe('green');
  });

  describe('expiry', () => {
    it('warns at 10 months', () => {
      const t = evaluateTriggers(baseline, same, new Date('2026-11-01T00:00:00Z'));
      const e = t.find((x) => x.type === 'expiry');
      expect(e?.level).toBe('yellow');
    });
    it('is red past 12 months', () => {
      const t = evaluateTriggers(baseline, same, new Date('2027-02-01T00:00:00Z'));
      const e = t.find((x) => x.type === 'expiry');
      expect(e?.level).toBe('red');
      expect(overallStatus(t)).toBe('red');
    });
  });

  describe('revenue change', () => {
    it('is red past the 25% materiality threshold', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, annual_revenue: 1_300_000 },
        new Date('2026-03-01T00:00:00Z'),
      );
      const r = t.find((x) => x.type === 'revenue_change');
      expect(r?.level).toBe('red');
    });
    it('is yellow between 15% and 25%', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, annual_revenue: 1_200_000 },
        new Date('2026-03-01T00:00:00Z'),
      );
      const r = t.find((x) => x.type === 'revenue_change');
      expect(r?.level).toBe('yellow');
    });
    it('ignores small moves', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, annual_revenue: 1_050_000 },
        new Date('2026-03-01T00:00:00Z'),
      );
      expect(t.find((x) => x.type === 'revenue_change')).toBeUndefined();
    });
  });

  describe('funding round', () => {
    it('fires red on a newer round date', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, last_round_date: '2026-02-15' },
        new Date('2026-03-01T00:00:00Z'),
      );
      const f = t.find((x) => x.type === 'funding_round');
      expect(f?.level).toBe('red');
    });
    it('does not fire on the same round', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, last_round_date: '2025-06-01' },
        new Date('2026-03-01T00:00:00Z'),
      );
      expect(t.find((x) => x.type === 'funding_round')).toBeUndefined();
    });
  });

  describe('cap table change', () => {
    it('is red on a large share change', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, fully_diluted_shares: 12_000_000 },
        new Date('2026-03-01T00:00:00Z'),
      );
      const c = t.find((x) => x.type === 'cap_table_change');
      expect(c?.level).toBe('red');
    });
    it('is yellow on a small share change', () => {
      const t = evaluateTriggers(
        baseline,
        { ...same, fully_diluted_shares: 10_200_000 },
        new Date('2026-03-01T00:00:00Z'),
      );
      const c = t.find((x) => x.type === 'cap_table_change');
      expect(c?.level).toBe('yellow');
    });
  });

  it('signatures are stable for dedupe', () => {
    const now = new Date('2027-02-01T00:00:00Z');
    const a = evaluateTriggers(baseline, same, now);
    const b = evaluateTriggers(baseline, same, now);
    expect(a.map((t) => t.signature)).toEqual(b.map((t) => t.signature));
  });
});

describe('monitoring — the arithmetic at the edges', () => {
  it('does not credit a month that has not completed', () => {
    // Started on the 15th, and it is the 14th eleven months later: that is ten
    // whole months, not eleven, so the expiry warning is not yet due.
    const start: MonitorSnapshot = { ...baseline, valuation_date: '2025-09-15' };
    expect(evaluateTriggers(start, same, new Date('2026-07-14T00:00:00Z'))).toHaveLength(0);
    // The 15th completes it.
    const due = evaluateTriggers(start, same, new Date('2026-07-15T00:00:00Z'));
    expect(due.map((t) => t.level)).toEqual(['yellow']);
    expect(due[0]!.detail).toMatchObject({ months: 10 });
  });

  it('fires nothing on a valuation date it cannot read, rather than a 0-month age', () => {
    // `monthsBetween` answers 0 for an unparseable date, which is the one answer
    // that cannot be mistaken for "expired" on a column that is free text on
    // some import paths.
    const bad: MonitorSnapshot = { ...baseline, valuation_date: 'not a date' };
    expect(evaluateTriggers(bad, same, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('reports a shrinking cap table with its sign', () => {
    const current: MonitorSnapshot = { ...same, fully_diluted_shares: 9_000_000 };
    const [trigger] = evaluateTriggers(baseline, current, new Date('2026-03-01T00:00:00Z'));
    expect(trigger!.type).toBe('cap_table_change');
    expect(trigger!.message).toContain('-1,000,000 shares');
    expect(trigger!.message).not.toContain('+-');
    expect(trigger!.level).toBe('red'); // 10% is over the 5% bar
  });

  it('treats any movement off a zero baseline as material', () => {
    // There is no percentage to take against zero, and a cap table that went
    // from no recorded shares to some is not a rounding difference.
    const from: MonitorSnapshot = { ...baseline, fully_diluted_shares: 0 };
    const to: MonitorSnapshot = { ...same, fully_diluted_shares: 1 };
    const [trigger] = evaluateTriggers(from, to, new Date('2026-03-01T00:00:00Z'));
    expect(trigger!.level).toBe('red');
  });

  it('ranks a mixed set by its worst member, in either order', () => {
    // `overallStatus` folds the set, so it has to be indifferent to the order
    // the triggers happen to have been pushed in.
    const current: MonitorSnapshot = {
      ...same,
      annual_revenue: 1_200_000, // +20% — yellow
      fully_diluted_shares: 11_000_000, // +10% — red
    };
    const triggers = evaluateTriggers(baseline, current, new Date('2026-03-01T00:00:00Z'));
    expect(triggers.map((t) => t.level).sort()).toEqual(['red', 'yellow']);
    expect(overallStatus(triggers)).toBe('red');
    expect(overallStatus([...triggers].reverse())).toBe('red');
  });

  describe('reconcileBaselineShares', () => {
    // The baseline is JSONB written once, and its share count was copied out of
    // the cap table's stored validation back when that summed preferred 1:1.
    // The live side is recomputed on read, so a table with a ratchet compares an
    // old denominator against a new one and reports a change nobody made.
    const TAKEN = new Date('2026-02-01T12:00:00Z');
    const BEFORE = new Date('2026-01-15T09:00:00Z');
    const AFTER = new Date('2026-03-20T09:00:00Z');

    it('adopts the live count when the cap table has not been written since', () => {
      const healed = reconcileBaselineShares(
        baseline,
        { fully_diluted_shares: 13_000_000, changed_at: BEFORE },
        TAKEN,
      );
      expect(healed.fully_diluted_shares).toBe(13_000_000);
      // Only that field moves; the rest of the snapshot is the record of what
      // was true when monitoring was enabled and must not be rewritten.
      expect({ ...healed, fully_diluted_shares: null }).toEqual({
        ...baseline,
        fully_diluted_shares: null,
      });
    });

    it('fires nothing once the count is reconciled', () => {
      const current: MonitorSnapshot = { ...same, fully_diluted_shares: 13_000_000 };
      const stale = evaluateTriggers(baseline, current, new Date('2026-03-01T00:00:00Z'));
      expect(stale.map((t) => t.type)).toContain('cap_table_change');

      const healed = reconcileBaselineShares(
        baseline,
        { fully_diluted_shares: current.fully_diluted_shares, changed_at: BEFORE },
        TAKEN,
      );
      expect(evaluateTriggers(healed, current, new Date('2026-03-01T00:00:00Z'))).toHaveLength(0);
    });

    it('leaves a cap table rewritten since the baseline alone', () => {
      // The rows behind the live count are no longer the rows the baseline was
      // taken from, so the difference may be a real issuance. Suppressing it
      // would silence the trigger this whole subsystem exists for.
      const kept = reconcileBaselineShares(
        baseline,
        { fully_diluted_shares: 13_000_000, changed_at: AFTER },
        TAKEN,
      );
      expect(kept.fully_diluted_shares).toBe(baseline.fully_diluted_shares);
      expect(evaluateTriggers(kept, { ...same, fully_diluted_shares: 13_000_000 }, AFTER)).toHaveLength(1);
    });

    it('treats a write at the same instant as the baseline as not later', () => {
      // `enableMonitor` reads the cap table and stamps `updated_at` in the same
      // request, so equal timestamps are the ordinary case for a table saved and
      // monitored together — not a rewrite.
      const healed = reconcileBaselineShares(
        baseline,
        { fully_diluted_shares: 13_000_000, changed_at: TAKEN },
        TAKEN,
      );
      expect(healed.fully_diluted_shares).toBe(13_000_000);
    });

    it('accepts the timestamps as ISO strings as well as Dates', () => {
      const healed = reconcileBaselineShares(
        baseline,
        { fully_diluted_shares: 13_000_000, changed_at: BEFORE.toISOString() },
        TAKEN.toISOString(),
      );
      expect(healed.fully_diluted_shares).toBe(13_000_000);
    });

    it('keeps the baseline when either timestamp is missing or unreadable', () => {
      const cases: Array<[Date | string | null, Date | string | null]> = [
        [null, TAKEN],
        [BEFORE, null],
        ['not a date', TAKEN],
        [BEFORE, 'not a date'],
      ];
      for (const [changed_at, takenAt] of cases) {
        const kept = reconcileBaselineShares(
          baseline,
          { fully_diluted_shares: 13_000_000, changed_at },
          takenAt,
        );
        expect(kept.fully_diluted_shares).toBe(baseline.fully_diluted_shares);
      }
    });

    it('keeps the baseline when there is no cap table to recompute from', () => {
      expect(reconcileBaselineShares(baseline, null, TAKEN)).toEqual(baseline);
      expect(
        reconcileBaselineShares(baseline, { fully_diluted_shares: null, changed_at: BEFORE }, TAKEN),
      ).toEqual(baseline);
    });

    it('returns the baseline untouched when the counts already agree', () => {
      const same_count = reconcileBaselineShares(
        baseline,
        { fully_diluted_shares: baseline.fully_diluted_shares, changed_at: BEFORE },
        TAKEN,
      );
      expect(same_count).toEqual(baseline);
    });

    it('reconciles a baseline of zero rather than reading it as absent', () => {
      // 0 is a share count the old summary could produce, and `?? null` on it
      // would be the classic falsy slip.
      const from_zero: MonitorSnapshot = { ...baseline, fully_diluted_shares: 0 };
      const healed = reconcileBaselineShares(
        from_zero,
        { fully_diluted_shares: 13_000_000, changed_at: BEFORE },
        TAKEN,
      );
      expect(healed.fully_diluted_shares).toBe(13_000_000);
    });

    it('leaves a null baseline count null', () => {
      // Nothing was ever snapshotted, so there is nothing to correct — and the
      // cap-table trigger already declines to fire against a null baseline.
      const never: MonitorSnapshot = { ...baseline, fully_diluted_shares: null };
      expect(
        reconcileBaselineShares(never, { fully_diluted_shares: 13_000_000, changed_at: BEFORE }, TAKEN)
          .fully_diluted_shares,
      ).toBeNull();
    });
  });
});
