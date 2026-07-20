import { describe, it, expect } from 'vitest';
import {
  buildAnalytics,
  percentileRank,
  quantile,
  type CalcInput,
} from '../../src/domain/valuationAnalytics.js';

function calc(as_of: string, over: { fmv: number; dlom: number; vol: number; multiples?: number[] }): CalcInput {
  return {
    calculation_id: `c-${as_of}`,
    valuation_id: `v-${as_of}`,
    as_of,
    results: {
      fmv_per_share: over.fmv,
      equity_value: over.fmv * 1_000_000,
      discounts: { dlom: over.dlom },
      assumptions: { volatility: over.vol },
      approaches: over.multiples ? { market: { multiples: over.multiples } } : {},
    },
  };
}

describe('quantile / percentileRank', () => {
  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
    expect(quantile([10, 20, 30], 0.25)).toBeCloseTo(15, 6);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('ranks a value within a sample', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBeCloseTo((2 + 0.5) / 4, 6);
    expect(percentileRank([5, 5, 5], 5)).toBeCloseTo(0.5, 6);
  });
});

describe('buildAnalytics (feature 5)', () => {
  it('produces a chronological series and directional trends', () => {
    const a = buildAnalytics([
      calc('2025-01-01', { fmv: 2.0, dlom: 0.3, vol: 0.6 }),
      calc('2025-06-01', { fmv: 2.5, dlom: 0.28, vol: 0.55 }),
      calc('2026-01-01', { fmv: 3.5, dlom: 0.2, vol: 0.5 }),
    ]);
    expect(a.count).toBe(3);
    expect(a.series.map((p) => p.fmv_per_share)).toEqual([2.0, 2.5, 3.5]);
    expect(a.trends.fmv_per_share.change).toBeCloseTo(1.5, 6);
    expect(a.trends.fmv_per_share.pct_change).toBeCloseTo(0.75, 6);
    expect(a.trends.dlom.change).toBeCloseTo(-0.1, 6);
    expect(a.trends.volatility.last).toBeCloseTo(0.5, 6);
  });

  it('builds a comparable-multiple benchmark from the latest calculation', () => {
    const a = buildAnalytics([
      calc('2025-01-01', { fmv: 2, dlom: 0.3, vol: 0.6, multiples: [4] }),
      calc('2026-01-01', { fmv: 3, dlom: 0.25, vol: 0.5, multiples: [3, 5, 7, 9] }),
    ]);
    expect(a.benchmark.count).toBe(4);
    expect(a.benchmark.median).toBeCloseTo(6, 6); // median of 3,5,7,9
    expect(a.benchmark.company_multiple).toBeCloseTo(6, 6); // mean
    expect(a.benchmark.percentile).toBeCloseTo(0.5, 6);
  });

  it('handles an empty history', () => {
    const a = buildAnalytics([]);
    expect(a.count).toBe(0);
    expect(a.benchmark.count).toBe(0);
    expect(a.trends.fmv_per_share.first).toBeNull();
  });
});
