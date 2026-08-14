import { describe, expect, it } from 'vitest';
import {
  blackScholesCall,
  normCdf,
  opmFmvPerShareCents,
  sensitivityGrid,
  sensitivityTables,
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

  it('returns zero for zero or negative commonShares instead of Infinity', () => {
    expect(
      opmFmvPerShareCents({
        equityValueCents: 100_000,
        strikeCents: 50_000,
        volatility: 0.5,
        termYears: 3,
        riskFreeRate: 0.04,
        commonShares: 0,
        dlom: 0.25,
      }),
    ).toBe(0);
    expect(
      opmFmvPerShareCents({
        equityValueCents: 100_000,
        strikeCents: 50_000,
        volatility: 0.5,
        termYears: 3,
        riskFreeRate: 0.04,
        commonShares: -100,
        dlom: 0.25,
      }),
    ).toBe(0);
  });

  it('clamps DLOM to [0, 0.99] so FMV never goes negative', () => {
    const base = {
      equityValueCents: 100_000,
      strikeCents: 50_000,
      volatility: 0.5,
      termYears: 3,
      riskFreeRate: 0.04,
      commonShares: 1000,
      dlom: 1.0,
    };
    expect(opmFmvPerShareCents(base)).toBeGreaterThan(0);
    expect(opmFmvPerShareCents({ ...base, dlom: 1.5 })).toBeGreaterThan(0);
  });
});

describe('the term axis floor', () => {
  const opm = {
    equityValueCents: 42_000_000 * 10_000,
    strikeCents: 10_000_000 * 10_000,
    volatility: 0.65,
    termYears: 3.5,
    riskFreeRate: 0.042,
    commonShares: 8_000_000,
    dlom: 0.25,
  };

  it('floors a downward step at 0.1 years rather than striking a fortnight out', () => {
    const grid = sensitivityGrid({ ...opm, termYears: 0.5 });
    expect(Math.min(...grid.terms)).toBe(0.1);
  });

  it('never floors above the applied term itself', () => {
    // A term shorter than the floor is not a degenerate stress — it is the
    // valuation's own assumption, and the one point on the axis that is not
    // hypothetical. Flooring it away swept a grid that did not contain the term
    // its own base case was priced at.
    const grid = sensitivityGrid({ ...opm, termYears: 0.05 }, { termSteps: [0, 0.5] });
    expect(grid.terms).toContain(0.05);
    expect(grid.base.termYears).toBe(0.05);
    expect(grid.rows[0]![0]!.deltaFromBase).toBe(0);
  });

  it('applies the same floor to the risk-free tables', () => {
    // F-3 stresses the rate against the term through `sensitivityTables`, so a
    // floor that differed there would put two different term axes in one report.
    const { tables } = sensitivityTables({ ...opm, termYears: 0.05 }, { termSteps: [0, 0.5] });
    expect(tables.rfr_term.colValues).toContain(0.05);
  });

  it('keeps the 0.1 floor for a non-positive term rather than sweeping backwards', () => {
    const grid = sensitivityGrid({ ...opm, termYears: 0 }, { termSteps: [-1, 0, 1] });
    expect(Math.min(...grid.terms)).toBe(0.1);
  });
});
