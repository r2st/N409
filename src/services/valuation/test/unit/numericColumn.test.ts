import { describe, expect, it } from 'vitest';
import {
  DEBT_FAIR_VALUE,
  FUND_MARK_FAIR_VALUE,
  fitsNumeric,
  numericCeiling,
  requireStorableFigure,
} from '../../src/domain/numericColumn.js';

describe('numeric column capacity', () => {
  it('reads the ceiling off the column declaration', () => {
    // numeric(24, 4) leaves 20 digits left of the point.
    expect(numericCeiling(FUND_MARK_FAIR_VALUE)).toBe(1e20);
    expect(numericCeiling(DEBT_FAIR_VALUE)).toBe(1e18);
  });

  it('admits what the column holds and refuses what it does not', () => {
    expect(fitsNumeric(0, FUND_MARK_FAIR_VALUE)).toBe(true);
    expect(fitsNumeric(-1e19, FUND_MARK_FAIR_VALUE)).toBe(true);
    expect(fitsNumeric(1e20, FUND_MARK_FAIR_VALUE)).toBe(false);
    expect(fitsNumeric(-1e20, FUND_MARK_FAIR_VALUE)).toBe(false);
    // The product the fund routes could previously produce.
    expect(fitsNumeric(1e15 * 1e12, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('refuses a non-finite figure too', () => {
    expect(fitsNumeric(Number.POSITIVE_INFINITY, DEBT_FAIR_VALUE)).toBe(false);
    expect(fitsNumeric(Number.NaN, DEBT_FAIR_VALUE)).toBe(false);
  });

  it('passes a storable figure straight through', () => {
    expect(requireStorableFigure(1234.5, 'Fair value', DEBT_FAIR_VALUE)).toBe(1234.5);
  });

  it('leaves a null figure alone — not every run produces one', () => {
    expect(requireStorableFigure(null, 'Fair value', DEBT_FAIR_VALUE)).toBeNull();
  });

  it('names the figure and the ceiling when it will not fit', () => {
    try {
      requireStorableFigure(1e27, 'Fair value', FUND_MARK_FAIR_VALUE);
      expect.unreachable('should have thrown');
    } catch (err) {
      const problem = err as { statusCode?: number; status?: number; detail?: string; message?: string };
      expect(problem.statusCode ?? problem.status).toBe(422);
      const text = problem.detail ?? problem.message ?? '';
      expect(text).toMatch(/1\.000e\+27/);
      expect(text).toMatch(/1e\+20/);
      expect(text).toMatch(/Fair value/);
    }
  });
});
