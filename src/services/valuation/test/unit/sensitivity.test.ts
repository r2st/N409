import { describe, expect, it } from 'vitest';
import {
  blackScholesCall,
  normCdf,
  opmFmvPerShareCents,
  sensitivityGrid,
} from '../../src/domain/sensitivity.js';

describe('OPM sensitivity math (M4 #19)', () => {
  it('normCdf matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('Black-Scholes matches the textbook reference case', () => {
    // S=100, K=100, σ=20%, T=1y, r=5% → C ≈ 10.4506 (Hull)
    expect(blackScholesCall(100, 100, 0.2, 1, 0.05)).toBeCloseTo(10.4506, 3);
  });

  it('degenerates to intrinsic value at zero volatility / zero term', () => {
    expect(blackScholesCall(100, 80, 0, 1, 0)).toBeCloseTo(20, 6);
    expect(blackScholesCall(100, 120, 0.5, 0, 0.05)).toBe(0);
  });

  it('call value increases with volatility and term', () => {
    const base = blackScholesCall(100, 100, 0.3, 2, 0.04);
    expect(blackScholesCall(100, 100, 0.5, 2, 0.04)).toBeGreaterThan(base);
    expect(blackScholesCall(100, 100, 0.3, 4, 0.04)).toBeGreaterThan(base);
  });

  const inputs = {
    equityValueCents: 50_000_000_00, // $50M equity
    strikeCents: 20_000_000_00, // $20M preference stack
    volatility: 0.6,
    termYears: 3,
    riskFreeRate: 0.043,
    commonShares: 10_000_000,
    dlom: 0.3,
  };

  it('applies DLOM to the per-share FMV', () => {
    const withDlom = opmFmvPerShareCents(inputs);
    const without = opmFmvPerShareCents({ ...inputs, dlom: 0 });
    expect(withDlom).toBeCloseTo(without * 0.7, 6);
    expect(withDlom).toBeGreaterThan(0);
  });

  it('builds a default 5×5 grid with the base case in the center', () => {
    const grid = sensitivityGrid(inputs);
    expect(grid.rows).toHaveLength(5);
    expect(grid.rows[0]).toHaveLength(5);
    expect(grid.volatilities[2]).toBeCloseTo(0.6, 6);
    expect(grid.terms[2]).toBeCloseTo(3, 6);
    const center = grid.rows[2]![2]!;
    expect(center.fmvPerShareCents).toBe(grid.base.fmvPerShareCents);
    expect(center.deltaFromBase).toBeCloseTo(0, 3);
  });

  it('FMV is monotonically increasing across the volatility axis', () => {
    const grid = sensitivityGrid(inputs);
    for (let j = 0; j < grid.terms.length; j++) {
      for (let i = 1; i < grid.volatilities.length; i++) {
        expect(grid.rows[i]![j]!.fmvPerShareCents).toBeGreaterThanOrEqual(
          grid.rows[i - 1]![j]!.fmvPerShareCents,
        );
      }
    }
  });

  it('honors custom stress steps and clamps the term floor', () => {
    const grid = sensitivityGrid(inputs, { volatilitySteps: [0], termSteps: [-10, 0] });
    expect(grid.rows).toHaveLength(1);
    expect(grid.terms).toEqual([0.1, 3]); // 3 - 10 clamps to 0.1y
  });
});
