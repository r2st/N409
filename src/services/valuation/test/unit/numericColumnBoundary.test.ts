import { describe, expect, it } from 'vitest';
import {
  numericCeiling,
  fitsNumeric,
  requireStorableFigure,
  FUND_MARK_FAIR_VALUE,
  DEBT_FAIR_VALUE,
  ROLLFORWARD_EQUITY_VALUE,
  PROJECTION_TERMINAL_VALUE,
} from '../../src/domain/numericColumn.js';

describe('numericCeiling', () => {
  it('returns 10^20 for numeric(24,4)', () => {
    expect(numericCeiling(FUND_MARK_FAIR_VALUE)).toBe(1e20);
  });

  it('returns 10^18 for numeric(24,6)', () => {
    expect(numericCeiling(DEBT_FAIR_VALUE)).toBe(1e18);
  });

  it('returns 10^18 for numeric(20,2)', () => {
    expect(numericCeiling(ROLLFORWARD_EQUITY_VALUE)).toBe(1e18);
  });

  it('returns 10^18 for projection terminal value', () => {
    expect(numericCeiling(PROJECTION_TERMINAL_VALUE)).toBe(1e18);
  });
});

describe('fitsNumeric boundary inputs', () => {
  it('rejects NaN', () => {
    expect(fitsNumeric(NaN, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(fitsNumeric(Infinity, FUND_MARK_FAIR_VALUE)).toBe(false);
    expect(fitsNumeric(-Infinity, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('accepts zero', () => {
    expect(fitsNumeric(0, FUND_MARK_FAIR_VALUE)).toBe(true);
  });

  it('accepts a value just below the ceiling', () => {
    const ceiling = numericCeiling(FUND_MARK_FAIR_VALUE);
    expect(fitsNumeric(ceiling * 0.999, FUND_MARK_FAIR_VALUE)).toBe(true);
  });

  it('rejects a value at exactly the ceiling', () => {
    const ceiling = numericCeiling(FUND_MARK_FAIR_VALUE);
    expect(fitsNumeric(ceiling, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('rejects a value above the ceiling', () => {
    const ceiling = numericCeiling(FUND_MARK_FAIR_VALUE);
    expect(fitsNumeric(ceiling + 1, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('accepts negative values within the magnitude bound', () => {
    expect(fitsNumeric(-999_999, FUND_MARK_FAIR_VALUE)).toBe(true);
  });

  it('rejects negative values above the magnitude bound', () => {
    const ceiling = numericCeiling(FUND_MARK_FAIR_VALUE);
    expect(fitsNumeric(-ceiling, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('accepts very small positive values', () => {
    expect(fitsNumeric(0.0001, FUND_MARK_FAIR_VALUE)).toBe(true);
  });
});

describe('requireStorableFigure boundary inputs', () => {
  it('passes null through unchanged', () => {
    expect(requireStorableFigure(null, 'test', FUND_MARK_FAIR_VALUE)).toBeNull();
  });

  it('passes a storable value through', () => {
    expect(requireStorableFigure(42_000, 'fair_value', FUND_MARK_FAIR_VALUE)).toBe(42_000);
  });

  it('throws for a value at the ceiling', () => {
    const ceiling = numericCeiling(FUND_MARK_FAIR_VALUE);
    expect(() => requireStorableFigure(ceiling, 'fair_value', FUND_MARK_FAIR_VALUE)).toThrow(
      /too large to record/,
    );
  });

  it('throws for NaN', () => {
    expect(() => requireStorableFigure(NaN, 'fair_value', FUND_MARK_FAIR_VALUE)).toThrow();
  });

  it('throws for Infinity', () => {
    expect(() => requireStorableFigure(Infinity, 'fair_value', FUND_MARK_FAIR_VALUE)).toThrow();
  });

  it('includes the field name in the error message', () => {
    const ceiling = numericCeiling(DEBT_FAIR_VALUE);
    expect(() => requireStorableFigure(ceiling, 'debt_value', DEBT_FAIR_VALUE)).toThrow(/debt_value/);
  });

  it('includes the ceiling in the error message', () => {
    const ceiling = numericCeiling(ROLLFORWARD_EQUITY_VALUE);
    expect(() =>
      requireStorableFigure(ceiling, 'rolled_equity', ROLLFORWARD_EQUITY_VALUE),
    ).toThrow(/1e\+18/);
  });
});
