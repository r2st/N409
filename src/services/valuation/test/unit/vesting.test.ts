import { describe, expect, it } from 'vitest';
import {
  defaultScenarioFmvs,
  exerciseScenarios,
  monthsElapsed,
  templateByKey,
  vestingStatus,
  vestingTimeline,
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
  });

  describe('exerciseScenarios', () => {
    it('computes the in-the-money spread across all shares', () => {
      const [s] = exerciseScenarios(
        { totalShares: 1000, exercisePrice: 2, currentFmv: 2 },
        [10],
      );
      expect(s).toMatchObject({ fmv: 10, spreadPerShare: 8, grossValue: 8000, multipleOfCurrent: 5 });
    });

    it('never goes below zero (options not exercised at a loss)', () => {
      const [s] = exerciseScenarios(
        { totalShares: 1000, exercisePrice: 5, currentFmv: 5 },
        [3],
      );
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
});
