import { describe, expect, it } from 'vitest';
import {
  amortizationSchedule,
  asc718Grant,
  asc718Portfolio,
  blackScholesMerton,
  monteCarloFairValue,
} from '../../src/domain/asc718.js';

describe('ASC 718 grant-date fair value', () => {
  const textbook = {
    grantDateFairValue: 100,
    exercisePrice: 100,
    expectedTermYears: 1,
    volatility: 0.2,
    riskFreeRate: 0.05,
  };

  it('Black-Scholes-Merton matches the Hull reference (no dividend)', () => {
    // S=100, K=100, σ=20%, T=1y, r=5%, q=0 → C ≈ 10.4506.
    expect(blackScholesMerton(textbook)).toBeCloseTo(10.4506, 3);
  });

  it('a dividend yield lowers the option value', () => {
    const withDiv = blackScholesMerton({ ...textbook, dividendYield: 0.03 });
    expect(withDiv).toBeLessThan(blackScholesMerton(textbook));
    expect(withDiv).toBeGreaterThan(0);
  });

  it('degenerates to intrinsic value at zero term / zero volatility', () => {
    expect(blackScholesMerton({ ...textbook, expectedTermYears: 0, volatility: 0, grantDateFairValue: 120 })).toBeCloseTo(20, 6);
    expect(blackScholesMerton({ ...textbook, expectedTermYears: 0, volatility: 0 })).toBeCloseTo(0, 6);
  });

  it('Monte-Carlo estimate agrees with Black-Scholes and is deterministic', () => {
    const mc1 = monteCarloFairValue(textbook, { paths: 40000, seed: 7 });
    const mc2 = monteCarloFairValue(textbook, { paths: 40000, seed: 7 });
    expect(mc1).toBe(mc2); // reproducible
    expect(mc1).toBeCloseTo(blackScholesMerton(textbook), 0); // within ~$1
  });
});

describe('straight-line amortization schedule', () => {
  it('spreads cost evenly and sums exactly to the total', () => {
    const schedule = amortizationSchedule(10000, '2026-01-01', 48, 12);
    expect(schedule).toHaveLength(4);
    for (const p of schedule) expect(p.expense).toBeCloseTo(2500, 2);
    expect(schedule[3]!.cumulative).toBeCloseTo(10000, 2);
    expect(schedule[3]!.remaining).toBeCloseTo(0, 2);
    expect(schedule[0]!.startDate).toBe('2026-01-01');
    expect(schedule[3]!.endDate).toBe('2030-01-01');
  });

  it('handles a partial final period and absorbs rounding', () => {
    const schedule = amortizationSchedule(10000, '2026-01-01', 30, 12);
    // 30 months annual → 12 + 12 + 6.
    expect(schedule).toHaveLength(3);
    expect(schedule[2]!.startMonth).toBe(24);
    expect(schedule[2]!.endMonth).toBe(30);
    const total = schedule.reduce((s, p) => s + p.expense, 0);
    expect(total).toBeCloseTo(10000, 2);
  });

  it('supports monthly buckets', () => {
    const schedule = amortizationSchedule(1200, '2026-01-01', 12, 1);
    expect(schedule).toHaveLength(12);
    expect(schedule[0]!.expense).toBeCloseTo(100, 2);
  });
});

describe('asc718Grant', () => {
  const grant = {
    label: 'Q1 new hires',
    optionsGranted: 100000,
    grantDate: '2026-01-01',
    vestingMonths: 48,
    forfeitureRate: 0.1,
    assumptions: {
      grantDateFairValue: 2,
      exercisePrice: 2,
      expectedTermYears: 6,
      volatility: 0.6,
      riskFreeRate: 0.04,
    },
  };

  it('measures fair value, expected-to-vest cost, and the schedule', () => {
    const r = asc718Grant(grant);
    const fv = blackScholesMerton(grant.assumptions); // unrounded reference
    expect(r.fairValuePerOption).toBeGreaterThan(0);
    expect(r.expectedToVestOptions).toBe(90000); // 100k × (1 − 10%)
    // Total cost is net of forfeitures; gross uses all options.
    expect(r.totalCompensationCost).toBeCloseTo(fv * 90000, 0);
    expect(r.grossFairValue).toBeCloseTo(fv * 100000, 0);
    expect(r.schedule).toHaveLength(4);
    const total = r.schedule.reduce((s, p) => s + p.expense, 0);
    expect(total).toBeCloseTo(r.totalCompensationCost, 2);
    expect(r.assumptions.dividendYield).toBe(0);
  });

  it('vesting of 0 months expenses immediately', () => {
    const r = asc718Grant({ ...grant, vestingMonths: 0, forfeitureRate: 0 });
    expect(r.schedule).toHaveLength(1);
    expect(r.schedule[0]!.expense).toBeCloseTo(r.totalCompensationCost, 2);
  });
});

describe('asc718Portfolio', () => {
  it('aggregates cost and expense-by-year across grants', () => {
    const grants = [
      {
        optionsGranted: 50000,
        grantDate: '2026-01-01',
        vestingMonths: 48,
        assumptions: { grantDateFairValue: 2, exercisePrice: 2, expectedTermYears: 6, volatility: 0.6, riskFreeRate: 0.04 },
      },
      {
        optionsGranted: 30000,
        grantDate: '2026-06-01',
        vestingMonths: 24,
        assumptions: { grantDateFairValue: 2, exercisePrice: 2, expectedTermYears: 5, volatility: 0.6, riskFreeRate: 0.04 },
      },
    ];
    const p = asc718Portfolio(grants);
    expect(p.grants).toHaveLength(2);
    const sum = p.grants.reduce((s, g) => s + g.totalCompensationCost, 0);
    expect(p.totalCompensationCost).toBeCloseTo(sum, 2);
    // Years 1 and 2 receive expense from both grants (48- and 24-month vests).
    expect(p.expenseByYear.length).toBeGreaterThanOrEqual(2);
    const yearTotal = p.expenseByYear.reduce((s, y) => s + y.expense, 0);
    expect(yearTotal).toBeCloseTo(p.totalCompensationCost, 1);
    // Cumulative is monotonically increasing.
    for (let i = 1; i < p.expenseByYear.length; i++) {
      expect(p.expenseByYear[i]!.cumulative).toBeGreaterThanOrEqual(p.expenseByYear[i - 1]!.cumulative);
    }
  });
});
