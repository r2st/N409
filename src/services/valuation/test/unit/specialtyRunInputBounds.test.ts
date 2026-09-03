import { describe, expect, it } from 'vitest';
import { RunBody } from '../../src/routes/specialty.js';
import { IntakeAnswers, MAX_INTAKE_ANSWER_KEYS } from '../../src/domain/intake.js';

/**
 * The last door onto the specialty engine document.
 *
 * `specialtyEngineRequest` assembles the request from the questionnaire's
 * answers and then spreads `inputs` over it, so this is the map that wins. The
 * answers it overrides arrive through `IntakeAnswers`, which bounds how many
 * there are and how long a key may be; this door took `z.record(z.unknown())`
 * and bounded neither — and both arms of the handler persist the merged
 * document to `calculations.inputs`, the failed arm included.
 */
describe('POST /valuations/:id/specialty bounds its override map', () => {
  const parse = (inputs: unknown) => RunBody.safeParse({ inputs });

  it('accepts an ordinary override', () => {
    const parsed = parse({ intangibles: [{ name: 'Tech', method: 'cost_approach', params: {} }] });
    expect(parsed.success).toBe(true);
  });

  it('still defaults to an empty document when the body is absent', () => {
    expect(RunBody.parse(undefined).inputs).toEqual({});
    expect(RunBody.parse({}).inputs).toEqual({});
  });

  it('refuses a key longer than any engine keyword the run can bind', () => {
    expect(parse({ ['x'.repeat(201)]: 1 }).success).toBe(false);
    expect(parse({ ['x'.repeat(200)]: 1 }).success).toBe(true);
  });

  it('refuses a map with more entries than a run has parameters', () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i]));
    expect(parse(many).success).toBe(false);
  });

  it('bounds the same two axes the questionnaire door it overrides bounds', () => {
    // The answers this map merges over are held to a key length and a key
    // count; the override that replaces them was held to neither.
    expect(IntakeAnswers.safeParse({ ['x'.repeat(201)]: 'v' }).success).toBe(false);
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_INTAKE_ANSWER_KEYS + 1 }, (_, i) => [`k${i}`, i]),
    );
    expect(IntakeAnswers.safeParse(tooMany).success).toBe(false);
  });
});
