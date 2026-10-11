import { describe, expect, it } from 'vitest';
import {
  blackScholesCall,
  normCdf,
  opmFmvPerShareCents,
  sensitivityGrid,
  sensitivityTables,
  type OpmInputs,
} from '../../src/domain/sensitivity.js';

const BASE: OpmInputs = {
  equityValueCents: 50_000_000_00,
  strikeCents: 20_000_000_00,
  volatility: 0.6,
  termYears: 3,
  riskFreeRate: 0.043,
  commonShares: 10_000_000,
  dlom: 0.3,
};

describe('Black-Scholes boundary inputs', () => {
  it('returns 0 for spot = 0', () => {
    expect(blackScholesCall(0, 100, 0.3, 1, 0.05)).toBe(0);
  });

  it('returns 0 for negative spot', () => {
    expect(blackScholesCall(-100, 100, 0.3, 1, 0.05)).toBe(0);
  });

  it('returns spot when strike <= 0', () => {
    expect(blackScholesCall(100, 0, 0.3, 1, 0.05)).toBe(100);
    expect(blackScholesCall(100, -50, 0.3, 1, 0.05)).toBe(100);
  });

  it('returns intrinsic value when volatility = 0 and term > 0', () => {
    const call = blackScholesCall(100, 80, 0, 1, 0.05);
    const intrinsic = Math.max(0, 100 - 80 * Math.exp(-0.05));
    expect(call).toBeCloseTo(intrinsic, 6);
  });

  it('returns intrinsic when term = 0 and volatility > 0', () => {
    const call = blackScholesCall(100, 80, 0.5, 0, 0.05);
    expect(call).toBeCloseTo(Math.max(0, 100 - 80), 6);
  });

  it('returns 0 when deeply out of the money at zero vol and zero term', () => {
    expect(blackScholesCall(50, 100, 0, 0, 0)).toBe(0);
  });

  it('handles very large spot and strike without NaN', () => {
    const call = blackScholesCall(1e15, 1e15, 0.3, 1, 0.04);
    expect(Number.isFinite(call)).toBe(true);
    expect(call).toBeGreaterThan(0);
  });

  it('handles very small positive values', () => {
    const call = blackScholesCall(0.001, 0.001, 0.3, 1, 0.04);
    expect(Number.isFinite(call)).toBe(true);
    expect(call).toBeGreaterThanOrEqual(0);
  });

  it('handles a very high volatility without returning NaN', () => {
    const call = blackScholesCall(100, 100, 5.0, 1, 0.05);
    expect(Number.isFinite(call)).toBe(true);
    expect(call).toBeGreaterThan(0);
  });

  it('handles a very long term without NaN', () => {
    const call = blackScholesCall(100, 100, 0.3, 100, 0.05);
    expect(Number.isFinite(call)).toBe(true);
    expect(call).toBeGreaterThan(0);
  });

  it('handles negative risk-free rate', () => {
    const call = blackScholesCall(100, 100, 0.3, 1, -0.02);
    expect(Number.isFinite(call)).toBe(true);
    expect(call).toBeGreaterThanOrEqual(0);
  });
});

describe('normCdf boundary inputs', () => {
  it('approaches 0 for very large negative x', () => {
    expect(normCdf(-10)).toBeCloseTo(0, 6);
    expect(normCdf(-38)).toBeCloseTo(0, 10);
  });

  it('approaches 1 for very large positive x', () => {
    expect(normCdf(10)).toBeCloseTo(1, 6);
    expect(normCdf(38)).toBeCloseTo(1, 10);
  });

  it('stays in [0, 1] for extreme inputs', () => {
    for (const x of [-100, -50, -10, 0, 10, 50, 100]) {
      const result = normCdf(x);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});

describe('opmFmvPerShareCents boundary inputs', () => {
  it('returns 0 for zero equity value', () => {
    expect(opmFmvPerShareCents({ ...BASE, equityValueCents: 0 })).toBe(0);
  });

  it('returns 0 for negative equity value', () => {
    expect(opmFmvPerShareCents({ ...BASE, equityValueCents: -1 })).toBe(0);
  });

  it('clamps DLOM at 0.99 so result stays positive', () => {
    const result = opmFmvPerShareCents({ ...BASE, dlom: 5.0 });
    expect(result).toBeGreaterThan(0);
  });

  it('clamps negative DLOM to 0', () => {
    const withNeg = opmFmvPerShareCents({ ...BASE, dlom: -0.5 });
    const withZero = opmFmvPerShareCents({ ...BASE, dlom: 0 });
    expect(withNeg).toBe(withZero);
  });

  it('applies DLOC multiplicatively with DLOM', () => {
    const noDloc = opmFmvPerShareCents({ ...BASE, dlom: 0.3 });
    const withDloc = opmFmvPerShareCents({ ...BASE, dlom: 0.3, dloc: 0.1 });
    expect(withDloc).toBeCloseTo(noDloc * 0.9, 0);
  });

  it('clamps DLOC at 0.99', () => {
    const result = opmFmvPerShareCents({ ...BASE, dloc: 2.0 });
    expect(result).toBeGreaterThan(0);
  });

  it('handles 1 common share without overflow', () => {
    const result = opmFmvPerShareCents({ ...BASE, commonShares: 1 });
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it('handles very large share count', () => {
    const result = opmFmvPerShareCents({ ...BASE, commonShares: 1e15 });
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('handles strike = 0 (no preference stack)', () => {
    const result = opmFmvPerShareCents({ ...BASE, strikeCents: 0 });
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });
});

describe('sensitivityGrid boundary inputs', () => {
  it('handles single-step stress (1×1 grid)', () => {
    const grid = sensitivityGrid(BASE, { volatilitySteps: [0], termSteps: [0] });
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]).toHaveLength(1);
    expect(grid.rows[0]![0]!.deltaFromBase).toBeCloseTo(0, 3);
  });

  it('handles zero equity value without division by zero in deltaFromBase', () => {
    const grid = sensitivityGrid({ ...BASE, equityValueCents: 0 });
    for (const row of grid.rows) {
      for (const cell of row) {
        expect(Number.isFinite(cell.deltaFromBase)).toBe(true);
        expect(cell.deltaFromBase).toBe(0);
      }
    }
  });

  it('handles zero volatility base case', () => {
    const grid = sensitivityGrid({ ...BASE, volatility: 0 });
    expect(grid.rows.length).toBeGreaterThan(0);
    for (const row of grid.rows) {
      for (const cell of row) {
        expect(Number.isFinite(cell.fmvPerShareCents)).toBe(true);
      }
    }
  });

  it('deduplicates when all volatility steps collapse to zero', () => {
    const grid = sensitivityGrid(
      { ...BASE, volatility: 0 },
      { volatilitySteps: [-0.5, -0.2, 0, 0.1, 0.2] },
    );
    // All multiplicative steps on 0 yield 0
    expect(new Set(grid.volatilities).size).toBe(grid.volatilities.length);
  });
});

describe('sensitivityTables boundary inputs', () => {
  it('handles zero risk-free rate without negative clamped values', () => {
    const { tables } = sensitivityTables({ ...BASE, riskFreeRate: 0 });
    for (const v of tables.rfr_vol.rowValues) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
    for (const v of tables.rfr_term.rowValues) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces finite values at all extremes of the base-case grid', () => {
    const { tables } = sensitivityTables(BASE);
    for (const table of [tables.term_vol, tables.rfr_vol, tables.rfr_term]) {
      for (const row of table.rows) {
        for (const cell of row) {
          expect(Number.isFinite(cell.fmvPerShareCents)).toBe(true);
          expect(Number.isFinite(cell.deltaFromBase)).toBe(true);
        }
      }
    }
  });
});
