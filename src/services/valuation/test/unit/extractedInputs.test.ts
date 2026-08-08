import { describe, expect, it } from 'vitest';
import {
  EXTRACTABLE_INPUT_FIELDS,
  EngineInputsBody,
  sanitizeExtractedInputs,
} from '../../src/routes/engineInputs.js';

/**
 * `engine_inputs` has two writers — the analyst form (PATCH
 * /valuations/:id/engine-inputs, validated by EngineInputsBody) and the AI
 * extraction pipeline (auto-applied on upload). The second used to merge
 * whatever the model returned straight into the same jsonb document, so the
 * document's guarantees depended on which writer last touched it.
 *
 * These tests pin the property that closes that: anything the AI path applies
 * would also have been accepted from a human.
 */
describe('sanitizeExtractedInputs', () => {
  it('keeps values a hand-entry would have accepted', () => {
    const { applied, rejected } = sanitizeExtractedInputs({
      shares_outstanding_common: 8_000_000,
      cash: 1_200_000.5,
      debt: 0,
      volatility: 0.65,
      risk_free_rate: 0.042,
      ebitda_ltm: -450_000, // pre-revenue companies are routinely negative
    });
    expect(rejected).toEqual([]);
    expect(applied).toEqual({
      shares_outstanding_common: 8_000_000,
      cash: 1_200_000.5,
      debt: 0,
      volatility: 0.65,
      risk_free_rate: 0.042,
      ebitda_ltm: -450_000,
    });
  });

  it('rejects a percentage the model forgot to convert to a fraction', () => {
    // "volatility of 65%" read off a page as `65` is a 6,500% volatility. The
    // analyst schema caps it at 5; the AI path did not, and the OPM priced it.
    const { applied, rejected } = sanitizeExtractedInputs({ volatility: 65 });
    expect(applied).toEqual({});
    expect(rejected.map((r) => r.field)).toEqual(['volatility']);
    expect(rejected[0]!.value).toBe(65);
  });

  it('rejects a risk-free rate above 100%', () => {
    expect(sanitizeExtractedInputs({ risk_free_rate: 4.5 }).applied).toEqual({});
    expect(sanitizeExtractedInputs({ risk_free_rate: -0.01 }).applied).toEqual({});
  });

  it('rejects negative share and money counts', () => {
    const { applied, rejected } = sanitizeExtractedInputs({
      shares_outstanding_common: -5_000,
      shares_outstanding_preferred: -1,
      options_outstanding: -1,
      liquidation_preference: -1,
      cash: -1,
      debt: -1,
    });
    expect(applied).toEqual({});
    expect(rejected).toHaveLength(6);
  });

  it('rejects a zero common share count — it would divide the equity value', () => {
    expect(sanitizeExtractedInputs({ shares_outstanding_common: 0 }).applied).toEqual({});
  });

  it('rejects non-numbers, nulls and non-finite values', () => {
    const { applied, rejected } = sanitizeExtractedInputs({
      cash: null,
      debt: 'a lot',
      revenue_ltm: Number.NaN,
      revenue_ntm: Number.POSITIVE_INFINITY,
      ebitda_ltm: { value: 5 },
    });
    expect(applied).toEqual({});
    expect(rejected.map((r) => r.field).sort()).toEqual([
      'cash',
      'debt',
      'ebitda_ltm',
      'revenue_ltm',
      'revenue_ntm',
    ]);
  });

  it('rejects a key that is not an engine input at all', () => {
    const { applied, rejected } = sanitizeExtractedInputs({ made_up_field: 42, cash: 10 });
    expect(applied).toEqual({ cash: 10 });
    expect(rejected).toEqual([
      { field: 'made_up_field', value: 42, reason: 'not an engine input this pipeline may set' },
    ]);
  });

  it('applies the good fields of a partly bad extraction rather than losing all of it', () => {
    const { applied, rejected } = sanitizeExtractedInputs({
      shares_outstanding_common: 8_000_000,
      cash: 1_000_000,
      volatility: 65,
    });
    expect(applied).toEqual({ shares_outstanding_common: 8_000_000, cash: 1_000_000 });
    expect(rejected.map((r) => r.field)).toEqual(['volatility']);
  });

  it('treats a missing, null or non-object result as an empty extraction', () => {
    for (const raw of [undefined, null, 'nope', 42, [1, 2, 3]]) {
      expect(sanitizeExtractedInputs(raw)).toEqual({ applied: {}, rejected: [] });
    }
  });

  /**
   * The property, stated directly: for every field both writers share, a value
   * the AI path applies must also survive the analyst schema. If the two ever
   * drift, this fails rather than the drift shipping.
   */
  it('never applies a value the analyst schema would refuse', () => {
    const probes: Record<string, unknown[]> = {
      shares_outstanding_common: [-1, 0, 1, 1e9, Number.NaN, 'x', null],
      shares_outstanding_preferred: [-1, 0, 1e6],
      options_outstanding: [-1, 0, 1e6],
      liquidation_preference: [-1, 0, 5e6],
      last_round_post_money: [-1, 0, 5e7],
      last_round_price_per_share: [-1, 0, 2.5],
      cash: [-1, 0, 1e6],
      debt: [-1, 0, 1e6],
      volatility: [-1, 0, 0.65, 5, 5.01, 65],
      risk_free_rate: [-0.01, 0, 0.042, 1, 1.01, 4.5],
    };
    for (const [field, values] of Object.entries(probes)) {
      for (const value of values) {
        const { applied } = sanitizeExtractedInputs({ [field]: value });
        if (!(field in applied)) continue;
        expect(
          EngineInputsBody.safeParse({ [field]: applied[field] }).success,
          `${field}=${String(value)} was applied but hand-entry refuses it`,
        ).toBe(true);
      }
    }
  });

  it('covers every field the AI service is allowed to emit', () => {
    // Mirrors ENGINE_INPUT_FIELDS in src/services/ai/app/pipelines.py. A field
    // added there without a bound here would be applied unchecked.
    expect([...EXTRACTABLE_INPUT_FIELDS].sort()).toEqual(
      [
        'cash',
        'debt',
        'ebitda_ltm',
        'ebitda_ntm',
        'last_round_post_money',
        'last_round_price_per_share',
        'liquidation_preference',
        'options_outstanding',
        'revenue_ltm',
        'revenue_ntm',
        'risk_free_rate',
        'shares_outstanding_common',
        'shares_outstanding_preferred',
        'volatility',
      ].sort(),
    );
  });
});
