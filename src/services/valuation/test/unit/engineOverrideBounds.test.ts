import { describe, expect, it } from 'vitest';
import { ComputeBody } from '../../src/routes/calculations.js';
import { EngineInputsBody } from '../../src/routes/engineInputs.js';

/**
 * The third door onto the engine input document.
 *
 * `PATCH /valuations/:id/engine-inputs` writes it and holds it to
 * `EngineInputsBody`. `sanitizeExtractedInputs` reads the model's extraction
 * and holds it to the same field schemas, which is what
 * `calculationInputBounds.test.ts` pins. `POST /calculations` — and the
 * sensitivity grid beside it — took the same document as
 * `z.record(z.unknown())`, so the door that merges *last* was the one that
 * checked nothing.
 *
 * The bound that matters most here is volatility. `EngineInputsBody` caps it
 * at 5 because "volatility of 65%" typed as `65` is a 6,500% vol the OPM
 * prices without complaint, and the extraction is checked against that cap for
 * exactly this reason. An analyst typing the same figure into the override
 * reached the engine with it.
 */
describe('POST /calculations holds its overrides to the hand-entry schema', () => {
  const parse = (inputs: unknown) => ComputeBody.safeParse({ inputs });

  it('accepts an override inside the bounds', () => {
    const parsed = parse({ volatility: 0.62, time_to_exit_years: 4 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.inputs).toMatchObject({ volatility: 0.62 });
  });

  it('defaults to an empty document when the body is absent', () => {
    expect(ComputeBody.parse(undefined).inputs).toEqual({});
    expect(ComputeBody.parse({}).inputs).toEqual({});
  });

  it('refuses the decimal-point error the hand-entry door refuses', () => {
    // 65 meaning 65%. Finite, plausible to a schema that only asks for a
    // number, and a 6,500% volatility to the OPM.
    const parsed = parse({ volatility: 65 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['inputs', 'volatility']);
    // The same figure is refused by the door this one now shares a schema with.
    expect(EngineInputsBody.safeParse({ volatility: 65 }).success).toBe(false);
  });

  it('refuses a misspelt override rather than merging it under its misspelling', () => {
    const parsed = parse({ volatilty: 0.62 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('refuses a cap table longer than the allocation will take', () => {
    const classes = Array.from({ length: 51 }, (_, i) => ({
      kind: 'common' as const,
      name: `C${i}`,
      shares: 1_000,
    }));
    expect(parse({ share_classes: classes }).success).toBe(false);
  });

  it('refuses a body that is not an input document at all', () => {
    expect(parse('not-an-object').success).toBe(false);
    expect(parse([{ volatility: 0.5 }]).success).toBe(false);
  });

  it('is the same schema, not a copy of it', () => {
    // If someone restates the bounds here instead of reusing the schema, this
    // fails the next time only one of the two is changed.
    for (const doc of [{ risk_free_rate: 4.2 }, { income: { discount_rate: 12 } }, { debt: -50_000 }]) {
      expect(parse(doc).success).toBe(EngineInputsBody.safeParse(doc).success);
      expect(parse(doc).success).toBe(false);
    }
  });
});
