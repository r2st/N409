import { describe, expect, it } from 'vitest';
import {
  priorRequiredReturn,
  RollforwardInputError,
  shapeRollforward,
  type RollforwardEngineResponse,
} from '../../src/domain/rollforward.js';

/**
 * The shaping layer between `engine/v1/rollforward` and the row.
 *
 * The rule under test throughout: the four figures the bridge *is* — both ends,
 * the elapsed time and the rate — are refused rather than defaulted, and
 * everything else degrades. A roll-forward with a substituted rolled value is
 * not a roll-forward with a gap in it: it is a bridge claiming an arithmetic
 * the engine never performed, and the anchor of the next compute run would be
 * struck on it.
 */

/** A well-formed response, as the engine actually answers. */
const RESPONSE: RollforwardEngineResponse = {
  prior_valuation_date: '2025-06-30',
  new_valuation_date: '2026-06-30',
  years_elapsed: 1.0,
  prior_equity_value: 33_600_000,
  rolled_equity_value: 42_000_000,
  annual_accretion: 0.25,
  calibration_steps: [
    { step: 'prior_equity_value', value: 33_600_000 },
    { step: 'time_accretion', annual_rate: 0.25, years: 1.0, factor: 1.25, value: 42_000_000 },
  ],
  material_changes: [
    { field: 'revenue', material: false, detail: 'revenue moved +4.0%', delta_pct: 0.04 },
  ],
  requires_full_revaluation: false,
  pre_populated_inputs: { valuation_date: '2026-06-30', last_round_post_money: 42_000_000 },
};

describe('shapeRollforward', () => {
  it('carries the engine’s answer through unchanged', () => {
    const s = shapeRollforward(RESPONSE);
    expect(s.priorEquityValue).toBe(33_600_000);
    expect(s.rolledEquityValue).toBe(42_000_000);
    expect(s.annualAccretion).toBe(0.25);
    expect(s.yearsElapsed).toBe(1.0);
    expect(s.priorValuationDate).toBe('2025-06-30');
    expect(s.newValuationDate).toBe('2026-06-30');
    expect(s.calibrationSteps).toHaveLength(2);
    expect(s.prePopulatedInputs.last_round_post_money).toBe(42_000_000);
  });

  it('accepts a same-day roll-forward', () => {
    // Zero elapsed time is a legitimate re-measurement — a valuation redone at
    // the same date on new information — and `>= 0` is the engine's own rule.
    const s = shapeRollforward({
      ...RESPONSE,
      new_valuation_date: '2025-06-30',
      years_elapsed: 0,
      rolled_equity_value: 33_600_000,
    });
    expect(s.yearsElapsed).toBe(0);
  });

  it('accepts a zero accretion — a new priced round supersedes the decay', () => {
    const s = shapeRollforward({ ...RESPONSE, annual_accretion: 0, rolled_equity_value: 60_000_000 });
    expect(s.annualAccretion).toBe(0);
  });

  it('accepts a negative accretion — a down year is a valuation input', () => {
    const s = shapeRollforward({ ...RESPONSE, annual_accretion: -0.35, rolled_equity_value: 21_840_000 });
    expect(s.annualAccretion).toBe(-0.35);
  });

  it('refuses a response with no usable rolled value rather than substituting one', () => {
    for (const bad of [null, undefined, 0, -1, 'x', Infinity]) {
      expect(() => shapeRollforward({ ...RESPONSE, rolled_equity_value: bad })).toThrow(
        RollforwardInputError,
      );
    }
  });

  it('refuses a response with no usable prior value', () => {
    for (const bad of [null, undefined, 0, -1, NaN]) {
      expect(() => shapeRollforward({ ...RESPONSE, prior_equity_value: bad })).toThrow(
        RollforwardInputError,
      );
    }
  });

  it('refuses dates it cannot read, or reads them in the wrong order', () => {
    expect(() => shapeRollforward({ ...RESPONSE, new_valuation_date: 'soon' })).toThrow(
      RollforwardInputError,
    );
    expect(() => shapeRollforward({ ...RESPONSE, prior_valuation_date: null })).toThrow(
      RollforwardInputError,
    );
    expect(() => shapeRollforward({ ...RESPONSE, new_valuation_date: '2024-01-01' })).toThrow(
      /wrong order/,
    );
  });

  it('refuses an accretion at or below -100%', () => {
    // `(1 + rate) ** years` with a negative base and a fractional exponent is a
    // *complex* number in Python; the engine guards it and this is the same
    // floor, so a response carrying one is not one this service asked for.
    expect(() => shapeRollforward({ ...RESPONSE, annual_accretion: -1 })).toThrow(RollforwardInputError);
    expect(() => shapeRollforward({ ...RESPONSE, annual_accretion: -1.5 })).toThrow(
      RollforwardInputError,
    );
  });

  it('refuses a non-finite elapsed time or rate rather than storing NaN', () => {
    expect(() => shapeRollforward({ ...RESPONSE, years_elapsed: 'x' })).toThrow(RollforwardInputError);
    expect(() => shapeRollforward({ ...RESPONSE, annual_accretion: Infinity })).toThrow(
      RollforwardInputError,
    );
  });

  it('drops a calibration step whose running total is missing', () => {
    // The trail is read as arithmetic: each line is the total after that step,
    // and a line with no total reads as a step that took the value to nothing.
    const s = shapeRollforward({
      ...RESPONSE,
      calibration_steps: [
        { step: 'prior_equity_value', value: 33_600_000 },
        { step: 'adjustment', label: 'no total' },
        { step: 'time_accretion', value: 42_000_000 },
      ],
    });
    expect(s.calibrationSteps.map((c) => c.step)).toEqual(['prior_equity_value', 'time_accretion']);
  });

  it('keeps only the optional step fields the engine actually sent', () => {
    const s = shapeRollforward({
      ...RESPONSE,
      calibration_steps: [{ step: 'adjustment', label: '  Secondary mark  ', value: 40_000_000 }],
    });
    expect(s.calibrationSteps[0]).toEqual({ step: 'adjustment', label: 'Secondary mark', value: 40_000_000 });
  });

  it('drops a change with no field or no detail, and defaults material to false', () => {
    const s = shapeRollforward({
      ...RESPONSE,
      material_changes: [
        { field: 'revenue', detail: 'moved a lot' },
        { field: 'shares', detail: '   ' },
        { detail: 'nameless' },
        'not an object',
      ],
    });
    expect(s.materialChanges).toEqual([{ field: 'revenue', material: false, detail: 'moved a lot' }]);
  });

  it('derives the revaluation flag from the list rather than trusting it', () => {
    // The sentence the panel prints and the rows under it cannot disagree if
    // only one of them is stored — the rule `measuredCount` follows for the
    // volatility estimate.
    const lying = shapeRollforward({
      ...RESPONSE,
      requires_full_revaluation: false,
      material_changes: [{ field: 'new_round', material: true, detail: 'a new priced round' }],
    });
    expect(lying.requiresFullRevaluation).toBe(true);

    const alsoLying = shapeRollforward({
      ...RESPONSE,
      requires_full_revaluation: true,
      material_changes: [{ field: 'revenue', material: false, detail: 'below threshold' }],
    });
    expect(alsoLying.requiresFullRevaluation).toBe(false);
  });

  it('defaults the lists and the pre-populated inputs — an empty answer is legitimate', () => {
    const s = shapeRollforward({
      prior_valuation_date: '2025-06-30',
      new_valuation_date: '2026-06-30',
      years_elapsed: 1,
      prior_equity_value: 1_000_000,
      rolled_equity_value: 1_200_000,
      annual_accretion: 0.2,
    });
    expect(s.calibrationSteps).toEqual([]);
    expect(s.materialChanges).toEqual([]);
    expect(s.requiresFullRevaluation).toBe(false);
    expect(s.prePopulatedInputs).toEqual({});
  });

  it('survives a hostile response shape rather than throwing something untyped', () => {
    for (const shape of [
      { ...RESPONSE, calibration_steps: 'no' },
      { ...RESPONSE, material_changes: {} },
      { ...RESPONSE, pre_populated_inputs: [] },
      { ...RESPONSE, pre_populated_inputs: 'no' },
    ]) {
      expect(() => shapeRollforward(shape)).not.toThrow();
    }
  });
});

describe('priorRequiredReturn', () => {
  it('reads the discount rate the prior income approach concluded', () => {
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 0.28 } } })).toBe(0.28);
  });

  it('is null when the prior run applied no income approach', () => {
    // The engine's own resolution then stands — this exists to *narrow* the
    // engine's fallback, never to replace it with a guess of its own.
    expect(priorRequiredReturn({ approaches: { market: { weight: 1 } } })).toBeNull();
    expect(priorRequiredReturn({ approaches: null })).toBeNull();
    expect(priorRequiredReturn(null)).toBeNull();
    expect(priorRequiredReturn('nonsense')).toBeNull();
  });

  it('refuses a rate this service would not defend sending', () => {
    // A cost of capital outside (0, 100%] is not one. The engine's band on the
    // accretion is wider on purpose — an analyst may state a rate this would
    // not choose — but a rate picked up automatically has to be defensible.
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 0 } } })).toBeNull();
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: -0.1 } } })).toBeNull();
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 4 } } })).toBeNull();
    expect(priorRequiredReturn({ approaches: { income: { discount_rate: 'x' } } })).toBeNull();
  });
});
