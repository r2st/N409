import { describe, expect, it } from 'vitest';
import {
  addMonths,
  defaultScenarioFmvs,
  exerciseScenarios,
  isIssuableTemplate,
  ISSUABLE_TEMPLATE_KEYS,
  monthsElapsed,
  templateByKey,
  vestingStatus,
  vestingTimeline,
  VESTING_TEMPLATES,
  type VestingSchedule,
} from '../../src/domain/vesting.js';

const standard: VestingSchedule = {
  totalShares: 48000,
  vestingStartDate: '2024-01-01',
  vestingMonths: 48,
  cliffMonths: 12,
  frequencyMonths: 1,
};

describe('vesting', () => {
  describe('addMonths', () => {
    it('clamps the day of month instead of overflowing into the next', () => {
      // `setUTCMonth(+1)` on 31 January produces 31 February, which JS rolls
      // into 3 March — so February was skipped and March claimed twice.
      expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
      expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
      expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
      expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
      // Clamping is to the *target* month, so a leap February keeps its 29th.
      expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    });

    it('walks month-ends in order, one per calendar month', () => {
      const dates = Array.from({ length: 13 }, (_, m) => addMonths('2026-01-31', m));
      expect(dates).toEqual([
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
        '2026-05-31',
        '2026-06-30',
        '2026-07-31',
        '2026-08-31',
        '2026-09-30',
        '2026-10-31',
        '2026-11-30',
        '2026-12-31',
        '2027-01-31',
      ]);
      expect(new Set(dates.map((d) => d.slice(0, 7))).size).toBe(dates.length);
    });

    it('borrows a year on negative and year-crossing offsets', () => {
      expect(addMonths('2026-01-31', -1)).toBe('2025-12-31');
      expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
      expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
      expect(addMonths('2026-01-31', 12)).toBe('2027-01-31');
    });

    it('returns an unparseable date unchanged rather than throwing', () => {
      // The old form reached `toISOString()` on an Invalid Date, which throws
      // RangeError rather than producing a date.
      expect(addMonths('not-a-date', 1)).toBe('not-a-date');
    });
  });

  describe('monthsElapsed', () => {
    it('counts whole months, gated on day-of-month', () => {
      expect(monthsElapsed('2024-01-15', new Date('2024-01-14T00:00:00Z'))).toBe(0);
      expect(monthsElapsed('2024-01-15', new Date('2024-02-14T00:00:00Z'))).toBe(0);
      expect(monthsElapsed('2024-01-15', new Date('2024-02-15T00:00:00Z'))).toBe(1);
      expect(monthsElapsed('2024-01-01', new Date('2025-01-01T00:00:00Z'))).toBe(12);
    });

    it('never goes negative before the start', () => {
      expect(monthsElapsed('2024-06-01', new Date('2024-01-01T00:00:00Z'))).toBe(0);
    });

    it('counts a clamped month-end anniversary as arrived', () => {
      // 30 November is where addMonths puts month 15 of a 31 August grant —
      // November has no 31st. Judging it incomplete meant the month could
      // never complete at all.
      expect(monthsElapsed('2024-08-31', new Date('2025-11-30T00:00:00Z'))).toBe(15);
      expect(monthsElapsed('2024-01-31', new Date('2024-02-29T00:00:00Z'))).toBe(1);
      expect(monthsElapsed('2023-01-31', new Date('2023-02-28T00:00:00Z'))).toBe(1);
      expect(monthsElapsed('2024-08-31', new Date('2026-02-28T00:00:00Z'))).toBe(18);
    });

    it('still gates on a day the month actually reaches', () => {
      // 2024 is a leap year, so 28 February is not the clamped anniversary of
      // 31 January — the 29th is, and it has not arrived.
      expect(monthsElapsed('2024-01-31', new Date('2024-02-28T00:00:00Z'))).toBe(0);
      expect(monthsElapsed('2024-05-31', new Date('2024-06-15T00:00:00Z'))).toBe(0);
      expect(monthsElapsed('2024-01-15', new Date('2024-02-14T00:00:00Z'))).toBe(0);
    });

    it('inverts addMonths for every offset of a month-end grant', () => {
      // The invariant the two functions have to share: the date addMonths
      // calls month n is the date monthsElapsed reports n months at.
      for (const start of ['2024-01-31', '2024-08-31', '2023-03-31', '2024-02-29']) {
        for (let m = 0; m <= 48; m += 1) {
          const at = new Date(`${addMonths(start, m)}T00:00:00Z`);
          expect(monthsElapsed(start, at)).toBe(m);
        }
      }
    });
  });

  describe('vestingStatus — 4yr/1yr cliff', () => {
    it('vests nothing before the cliff', () => {
      const s = vestingStatus(standard, new Date('2024-11-01T00:00:00Z'));
      expect(s.vestedShares).toBe(0);
      expect(s.cliffCleared).toBe(false);
      expect(s.unvestedShares).toBe(48000);
    });

    it('vests 25% at the 1-year cliff', () => {
      const s = vestingStatus(standard, new Date('2025-01-01T00:00:00Z'));
      expect(s.vestedShares).toBe(12000);
      expect(s.percentVested).toBe(25);
      expect(s.cliffCleared).toBe(true);
    });

    it('accrues monthly after the cliff', () => {
      // 18 months → 18/48 of 48000 = 18000
      const s = vestingStatus(standard, new Date('2025-07-01T00:00:00Z'));
      expect(s.vestedShares).toBe(18000);
    });

    it('is fully vested at the end of the term', () => {
      const s = vestingStatus(standard, new Date('2028-01-01T00:00:00Z'));
      expect(s.vestedShares).toBe(48000);
      expect(s.fullyVested).toBe(true);
      expect(s.unvestedShares).toBe(0);
    });

    it('caps at total shares past the term', () => {
      const s = vestingStatus(standard, new Date('2030-01-01T00:00:00Z'));
      expect(s.vestedShares).toBe(48000);
    });
  });

  describe('vestingStatus — quarterly cadence', () => {
    const quarterly: VestingSchedule = {
      totalShares: 36000,
      vestingStartDate: '2024-01-01',
      vestingMonths: 36,
      cliffMonths: 12,
      frequencyMonths: 3,
    };
    it('only vests on quarter boundaries', () => {
      // 14 months → rounds down to 12 (last quarter boundary) → 12/36 * 36000
      const s = vestingStatus(quarterly, new Date('2025-03-01T00:00:00Z'));
      expect(s.vestedShares).toBe(12000);
      // 15 months → boundary at 15 → 15000
      const s2 = vestingStatus(quarterly, new Date('2025-04-01T00:00:00Z'));
      expect(s2.vestedShares).toBe(15000);
    });
  });

  describe('vestingTimeline', () => {
    it('starts at zero and ends fully vested', () => {
      const points = vestingTimeline(standard);
      expect(points[0]).toEqual({ monthOffset: 0, date: '2024-01-01', cumulativeVested: 0 });
      expect(points[points.length - 1]!.cumulativeVested).toBe(48000);
    });

    it('shows the cliff jump (0 until month 12)', () => {
      const points = vestingTimeline(standard);
      const preCliff = points.filter((p) => p.monthOffset > 0 && p.monthOffset < 12);
      expect(preCliff.every((p) => p.cumulativeVested === 0)).toBe(true);
      const atCliff = points.find((p) => p.monthOffset === 12);
      expect(atCliff?.cumulativeVested).toBe(12000);
    });

    it('gives a month-end grant one cadence point per calendar month', () => {
      // Boards routinely date grants to the last day of a quarter, so this is
      // not an edge case. Overflowing month arithmetic put offset 1 and offset
      // 2 both in March and dropped February from the chart entirely.
      const points = vestingTimeline({ ...standard, vestingStartDate: '2026-01-31' });
      const months = points.map((p) => p.date.slice(0, 7));
      expect(new Set(months).size).toBe(months.length);
      expect(points.slice(0, 4).map((p) => p.date)).toEqual([
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
      ]);
      // Dates advance in step with the offsets they are labelled with.
      for (let i = 1; i < points.length; i++) {
        expect(points[i]!.date > points[i - 1]!.date).toBe(true);
      }
    });

    it('does not stall a month-end grant on its own cadence points', () => {
      // A quarterly grant from 31 August. Offsets 15 and 18 land on 30 November
      // and 28 February, the days addMonths clamps them to — and those were the
      // days monthsElapsed called a month short, so each point repeated the
      // quarter before it and the chart flattened into 6-month steps.
      const points = vestingTimeline({
        ...standard,
        vestingStartDate: '2024-08-31',
        frequencyMonths: 3,
      });
      const at = (m: number) => points.find((p) => p.monthOffset === m)!;
      expect(at(12).cumulativeVested).toBe(12000);
      expect(at(15).cumulativeVested).toBe(15000);
      expect(at(18).cumulativeVested).toBe(18000);
      expect(at(21).cumulativeVested).toBe(21000);

      // Every post-cliff point is exactly its own offset's share, not a
      // neighbour's, and the series never repeats a value.
      for (const p of points.filter((q) => q.monthOffset >= 12)) {
        expect(p.cumulativeVested).toBe((48000 * p.monthOffset) / 48);
      }
    });

    it('vests a month-end grant on its clamped cliff date', () => {
      // 29 February is the first anniversary of a 29 February 2024 grant only
      // in a leap year; 2025 clamps it to the 28th, and that is the day the
      // cliff is due.
      const sched = { ...standard, vestingStartDate: '2024-02-29' };
      expect(vestingStatus(sched, new Date('2025-02-28T00:00:00Z')).vestedShares).toBe(12000);
      expect(vestingStatus(sched, new Date('2025-02-28T00:00:00Z')).cliffCleared).toBe(true);
      // The day before is still short of it.
      expect(vestingStatus(sched, new Date('2025-02-27T00:00:00Z')).vestedShares).toBe(0);
    });
  });

  describe('exerciseScenarios', () => {
    it('computes the in-the-money spread across all shares', () => {
      const [s] = exerciseScenarios({ totalShares: 1000, exercisePrice: 2, currentFmv: 2 }, [10]);
      expect(s).toMatchObject({ fmv: 10, spreadPerShare: 8, grossValue: 8000, multipleOfCurrent: 5 });
    });

    it('never goes below zero (options not exercised at a loss)', () => {
      const [s] = exerciseScenarios({ totalShares: 1000, exercisePrice: 5, currentFmv: 5 }, [3]);
      expect(s.spreadPerShare).toBe(0);
      expect(s.grossValue).toBe(0);
    });
  });

  it('defaultScenarioFmvs is a 1/2/5/10x ladder', () => {
    expect(defaultScenarioFmvs(2)).toEqual([2, 4, 10, 20]);
  });

  it('templateByKey resolves the standard template', () => {
    expect(templateByKey('standard_4yr_1yr_cliff')).toMatchObject({ vestingMonths: 48, cliffMonths: 12 });
    expect(templateByKey('nope')).toBeUndefined();
  });

  describe('isIssuableTemplate', () => {
    // `templateByKey` returning undefined used to be read as "use the defaults",
    // so a misspelled key issued a standard 4-year grant under the misspelling.
    // The write boundary needs a yes/no answer, not an optional lookup.
    it('accepts every built-in key plus custom', () => {
      for (const t of VESTING_TEMPLATES) expect(isIssuableTemplate(t.key)).toBe(true);
      expect(isIssuableTemplate('custom')).toBe(true);
      expect(ISSUABLE_TEMPLATE_KEYS).toHaveLength(VESTING_TEMPLATES.length + 1);
    });

    it('refuses anything else, including a near-miss and the empty string', () => {
      expect(isIssuableTemplate('three_year_quarterl')).toBe(false);
      expect(isIssuableTemplate('')).toBe(false);
      // Provenance the HRIS importer writes straight to the column — it is not
      // a schedule this service picks, so it is not issuable through the route.
      expect(isIssuableTemplate('imported')).toBe(false);
    });
  });
});
