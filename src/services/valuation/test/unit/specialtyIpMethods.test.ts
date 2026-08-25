/**
 * The IP questionnaire's four methods, each assembled into a request the
 * engine's dispatcher will actually accept.
 *
 * Three separate faults met on the cost approach and made it unrunnable, and
 * none of them was visible from either side alone:
 *
 *  - the select offered `cost`, and `value_intangible` looks the method up in
 *    `_METHODS`, whose key is `cost_approach`. Every cost-approach run came
 *    back "unknown intangible method 'cost'";
 *  - the assembler `put` a discount rate and a tax rate into the params
 *    unconditionally, and `cost_approach` accepts neither, so fixing the name
 *    alone would have moved the 422 to "unexpected keyword argument
 *    'discount_rate'";
 *  - `replacement_cost` is the method's one required parameter and the
 *    questionnaire asked for nothing that maps to it, so fixing both of the
 *    above would still have left "missing a required argument".
 *
 * So the assertions here are about the *shape the engine will accept*, not
 * about arithmetic: the method name is one the dispatcher knows, and every
 * key sent is one that method's signature declares.
 *
 * The signatures are restated below rather than imported because the engine is
 * Python. `test/unit/specialtyEngineParams.test.ts` is what keeps this copy
 * honest against the real thing.
 */

import { describe, expect, it } from 'vitest';
import { IP_METHODS, SpecialtyInputError, specialtyEngineRequest } from '../../src/domain/specialty.js';

/** `app/engine/intangibles.py`, keyword parameters per method. */
const ENGINE_ACCEPTS: Record<string, readonly string[]> = {
  relief_from_royalty: [
    'revenues',
    'royalty_rate',
    'tax_rate',
    'discount_rate',
    'terminal_growth',
    'include_tab',
  ],
  meem: [
    'revenues',
    'attrition_rate',
    'ebit_margin',
    'contributory_charges_pct',
    'tax_rate',
    'discount_rate',
    'include_tab',
  ],
  with_and_without: ['cash_flows_with', 'cash_flows_without', 'tax_rate', 'discount_rate', 'include_tab'],
  cost_approach: [
    'replacement_cost',
    'physical_obsolescence_pct',
    'functional_obsolescence_pct',
    'economic_obsolescence_pct',
    'developer_profit_pct',
    'opportunity_cost_pct',
  ],
};

/** Every field the IP questionnaire can carry, all answered at once. */
const FULLY_ANSWERED = {
  asset_name: 'Core platform',
  asset_type: 'software',
  remaining_life_years: 5,
  annual_revenue: 2_000_000,
  royalty_rate: 0.05,
  discount_rate: 0.15,
  tax_rate: 0.21,
  replacement_cost: 500_000,
  physical_obsolescence_pct: 0.1,
  functional_obsolescence_pct: 0.05,
  economic_obsolescence_pct: 0.02,
  developer_profit_pct: 0.12,
  opportunity_cost_pct: 0.08,
};

describe('IP method dispatch', () => {
  it('offers exactly the method names the engine dispatches on', () => {
    expect([...IP_METHODS].sort()).toEqual(Object.keys(ENGINE_ACCEPTS).sort());
  });

  for (const method of IP_METHODS) {
    it(`sends ${method} only parameters that method accepts`, () => {
      const req = specialtyEngineRequest('ip', { ...FULLY_ANSWERED, valuation_method: method });
      expect(req.body.method).toBe(method);
      const params = req.body.params as Record<string, unknown>;
      const unexpected = Object.keys(params).filter((k) => !ENGINE_ACCEPTS[method].includes(k));
      expect(unexpected).toEqual([]);
    });
  }

  it('sends the cost approach its replacement cost and every obsolescence layer', () => {
    const req = specialtyEngineRequest('ip', {
      ...FULLY_ANSWERED,
      valuation_method: 'cost_approach',
    });
    expect(req.body.params).toEqual({
      replacement_cost: 500_000,
      physical_obsolescence_pct: 0.1,
      functional_obsolescence_pct: 0.05,
      economic_obsolescence_pct: 0.02,
      developer_profit_pct: 0.12,
      opportunity_cost_pct: 0.08,
    });
  });

  it('keeps a discounted-cash-flow rate out of a cost-approach request', () => {
    const params = specialtyEngineRequest('ip', {
      ...FULLY_ANSWERED,
      valuation_method: 'cost_approach',
    }).body.params as Record<string, unknown>;
    expect('discount_rate' in params).toBe(false);
    expect('tax_rate' in params).toBe(false);
  });

  it('still builds the relief-from-royalty flat forecast and its royalty rate', () => {
    const params = specialtyEngineRequest('ip', {
      ...FULLY_ANSWERED,
      valuation_method: 'relief_from_royalty',
    }).body.params as Record<string, unknown>;
    expect(params.revenues).toEqual([2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000]);
    expect(params.royalty_rate).toBe(0.05);
    expect(params.discount_rate).toBe(0.15);
  });

  it('does not send a royalty rate to a method that has no royalty', () => {
    const carriers = IP_METHODS.filter((method) => {
      const params = specialtyEngineRequest('ip', { ...FULLY_ANSWERED, valuation_method: method }).body
        .params as Record<string, unknown>;
      return 'royalty_rate' in params;
    });
    expect(carriers).toEqual(['relief_from_royalty']);
  });

  it('reads the legacy `cost` answer as the cost approach rather than 422ing on it', () => {
    const req = specialtyEngineRequest('ip', { ...FULLY_ANSWERED, valuation_method: 'cost' });
    expect(req.body.method).toBe('cost_approach');
    expect((req.body.params as Record<string, unknown>).replacement_cost).toBe(500_000);
  });

  it('refuses a method the engine has no dispatcher for, naming the ones it has', () => {
    expect(() => specialtyEngineRequest('ip', { ...FULLY_ANSWERED, valuation_method: 'income' })).toThrow(
      SpecialtyInputError,
    );
    expect(() => specialtyEngineRequest('ip', { ...FULLY_ANSWERED, valuation_method: 'income' })).toThrow(
      /cost_approach/,
    );
  });

  it('lets a run override supply what the questionnaire cannot', () => {
    const params = specialtyEngineRequest(
      'ip',
      { ...FULLY_ANSWERED, valuation_method: 'with_and_without' },
      { cash_flows_with: [100, 110], cash_flows_without: [80, 85] },
    ).body.params as Record<string, unknown>;
    expect(params.cash_flows_with).toEqual([100, 110]);
    expect(params.discount_rate).toBe(0.15);
  });
});
