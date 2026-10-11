import { describe, expect, it } from 'vitest';
import {
  priorRequiredReturn,
  RollforwardInputError,
  shapeRollforward,
  type RollforwardEngineResponse,
} from '../../src/domain/rollforward.js';

const GOOD: RollforwardEngineResponse = {
  prior_valuation_date: '2025-06-30',
  new_valuation_date: '2026-06-30',
  years_elapsed: 1.0,
  prior_equity_value: 33_600_000,
  rolled_equity_value: 42_000_000,
  annual_accretion: 0.25,
  calibration_steps: [{ step: 'prior_equity_value', value: 33_600_000 }],
  material_changes: [],
};

describe('shapeRollforward boundary inputs', () => {
  it('refuses NaN prior equity value', () => {
    expect(() => shapeRollforward({ ...GOOD, prior_equity_value: NaN })).toThrow(RollforwardInputError);
  });

  it('refuses Infinity prior equity value', () => {
    expect(() => shapeRollforward({ ...GOOD, prior_equity_value: Infinity })).toThrow(RollforwardInputError);
  });

  it('refuses -Infinity rolled equity value', () => {
    expect(() => shapeRollforward({ ...GOOD, rolled_equity_value: -Infinity })).toThrow(RollforwardInputError);
  });

  it('refuses zero prior equity value', () => {
    expect(() => shapeRollforward({ ...GOOD, prior_equity_value: 0 })).toThrow(RollforwardInputError);
  });

  it('refuses negative prior equity value', () => {
    expect(() => shapeRollforward({ ...GOOD, prior_equity_value: -1 })).toThrow(RollforwardInputError);
  });

  it('refuses zero rolled equity value', () => {
    expect(() => shapeRollforward({ ...GOOD, rolled_equity_value: 0 })).toThrow(RollforwardInputError);
  });

  it('refuses null valuation dates', () => {
    expect(() => shapeRollforward({ ...GOOD, prior_valuation_date: null })).toThrow(RollforwardInputError);
    expect(() => shapeRollforward({ ...GOOD, new_valuation_date: null })).toThrow(RollforwardInputError);
  });

  it('refuses impossible calendar dates like Feb 31', () => {
    expect(() => shapeRollforward({ ...GOOD, prior_valuation_date: '2026-02-31' })).toThrow(
      RollforwardInputError,
    );
  });

  it('refuses dates in the wrong order', () => {
    expect(() =>
      shapeRollforward({
        ...GOOD,
        prior_valuation_date: '2026-12-31',
        new_valuation_date: '2025-01-01',
      }),
    ).toThrow(RollforwardInputError);
  });

  it('refuses negative years_elapsed', () => {
    expect(() => shapeRollforward({ ...GOOD, years_elapsed: -0.5 })).toThrow(RollforwardInputError);
  });

  it('accepts zero years_elapsed (same-day)', () => {
    const s = shapeRollforward({
      ...GOOD,
      prior_valuation_date: '2026-06-30',
      new_valuation_date: '2026-06-30',
      years_elapsed: 0,
    });
    expect(s.yearsElapsed).toBe(0);
  });

  it('refuses accretion rate at exactly -1 (total loss)', () => {
    expect(() => shapeRollforward({ ...GOOD, annual_accretion: -1 })).toThrow(RollforwardInputError);
  });

  it('accepts accretion rate just above -1', () => {
    const s = shapeRollforward({ ...GOOD, annual_accretion: -0.99 });
    expect(s.annualAccretion).toBeCloseTo(-0.99, 6);
  });

  it('refuses NaN accretion rate', () => {
    expect(() => shapeRollforward({ ...GOOD, annual_accretion: NaN })).toThrow(RollforwardInputError);
  });

  it('refuses null accretion rate', () => {
    expect(() => shapeRollforward({ ...GOOD, annual_accretion: null })).toThrow(RollforwardInputError);
  });

  it('accepts a very large accretion rate', () => {
    const s = shapeRollforward({ ...GOOD, annual_accretion: 99.99 });
    expect(s.annualAccretion).toBe(99.99);
  });

  it('degrades gracefully with empty calibration_steps', () => {
    const s = shapeRollforward({ ...GOOD, calibration_steps: [] });
    expect(s.calibrationSteps).toEqual([]);
  });

  it('degrades gracefully with null calibration_steps', () => {
    const s = shapeRollforward({ ...GOOD, calibration_steps: null });
    expect(s.calibrationSteps).toEqual([]);
  });

  it('drops calibration steps with missing step name or value', () => {
    const s = shapeRollforward({
      ...GOOD,
      calibration_steps: [
        { step: null, value: 100 },
        { step: 'ok', value: null },
        { step: 'good', value: 42 },
      ],
    });
    expect(s.calibrationSteps).toHaveLength(1);
    expect(s.calibrationSteps[0]!.step).toBe('good');
  });

  it('drops material changes with missing field or empty detail', () => {
    const s = shapeRollforward({
      ...GOOD,
      material_changes: [
        { field: null, material: true, detail: 'something' },
        { field: 'revenue', material: true, detail: '' },
        { field: 'revenue', material: true, detail: 'real change' },
      ],
    });
    expect(s.materialChanges).toHaveLength(1);
    expect(s.materialChanges[0]!.detail).toBe('real change');
  });

  it('derives requiresFullRevaluation from materialChanges, not from the flag', () => {
    const s = shapeRollforward({
      ...GOOD,
      requires_full_revaluation: false,
      material_changes: [{ field: 'revenue', material: true, detail: 'tripled' }],
    });
    expect(s.requiresFullRevaluation).toBe(true);
  });

  it('defaults prePopulatedInputs to empty object when null', () => {
    const s = shapeRollforward({ ...GOOD, pre_populated_inputs: null });
    expect(s.prePopulatedInputs).toEqual({});
  });

  it('defaults prePopulatedInputs to empty object when an array is sent', () => {
    const s = shapeRollforward({ ...GOOD, pre_populated_inputs: [1, 2, 3] });
    expect(s.prePopulatedInputs).toEqual({});
  });
});

describe('priorRequiredReturn boundary inputs', () => {
  it('returns null for null input', () => {
    expect(priorRequiredReturn(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(priorRequiredReturn(undefined)).toBeNull();
  });

  it('returns null when discount_rate is 0', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 0 } } })).toBeNull();
  });

  it('returns null when discount_rate is negative', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: -0.1 } } })).toBeNull();
  });

  it('returns null when discount_rate exceeds 1', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 1.01 } } })).toBeNull();
  });

  it('returns exactly 1 at the upper boundary', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 1 } } })).toBe(1);
  });

  it('returns the rate for a minimal positive value', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 0.001 } } })).toBe(0.001);
  });

  it('returns null when discount_rate is NaN', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: NaN } } })).toBeNull();
  });

  it('returns null when discount_rate is Infinity', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: Infinity } } })).toBeNull();
  });

  it('returns null when no income approach is present', () => {
    expect(priorRequiredReturn({ approaches: { market: {} } })).toBeNull();
  });
});
