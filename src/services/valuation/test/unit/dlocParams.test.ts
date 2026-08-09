import { describe, expect, it } from 'vitest';
import { ParamsPatchBody } from '../../src/routes/params.js';
import { DLOC_METHODS } from '../../src/repos/params.js';

/**
 * The DLOC configuration accepted on PATCH /params (migration 0132).
 *
 * `dloc` was a bare numeric from the first migration — a figure an analyst
 * typed, applied as-is, and reported with no derivation behind it, while the
 * DLOM in the column beside it accumulated four option models, two study
 * families and a weighting scheme. The split of responsibility here is the same
 * as for the DLOM: this schema checks *shape*, and the engine's pre-flight
 * checks *membership*, because the engine owns the study table.
 */

const ok = (patch: Record<string, unknown>) => ParamsPatchBody.safeParse(patch);

describe('dloc_method', () => {
  it.each(DLOC_METHODS)('accepts %s', (method) => {
    expect(ok({ dloc_method: method }).success).toBe(true);
  });

  it('accepts null — which is how "apply dloc as a stated figure" is spelled', () => {
    // The behaviour of every row written before 0132, and the one a rerun of
    // an engagement concluded last year has to reproduce exactly.
    expect(ok({ dloc_method: null }).success).toBe(true);
  });

  it('rejects a method the engine cannot dispatch on', () => {
    expect(ok({ dloc_method: 'mergerstat' }).success).toBe(false);
  });

  it('covers every method the engine dispatches on', () => {
    // Mirrors engine dloc.py DLOC_METHODS.
    expect([...DLOC_METHODS].sort()).toEqual(['control_premium', 'qualitative', 'studies']);
  });
});

describe('control_premium', () => {
  it('accepts a premium above 100%', () => {
    // Deliberately not a Fraction. A premium is unbounded above and 100%+
    // premiums are observed; only the sign is constrained.
    expect(ok({ control_premium: 1.4 }).success).toBe(true);
  });

  it('rejects a negative premium', () => {
    // A discount paid for control is a finding about that transaction rather
    // than evidence for a DLOC, and the engine's inversion would read it as a
    // premium.
    expect(ok({ control_premium: -0.1 }).success).toBe(false);
  });

  it('accepts null', () => {
    expect(ok({ control_premium: null }).success).toBe(true);
  });
});

describe('dloc_synergy_share', () => {
  it('accepts a fraction', () => {
    expect(ok({ dloc_synergy_share: 0.4 }).success).toBe(true);
  });

  it('rejects 1.0', () => {
    // All of the premium being synergy says control is worth nothing, which is
    // a conclusion about that transaction rather than an adjustment to it.
    expect(ok({ dloc_synergy_share: 1 }).success).toBe(false);
  });

  it('rejects a negative share', () => {
    expect(ok({ dloc_synergy_share: -0.1 }).success).toBe(false);
  });
});

describe('dloc_studies', () => {
  it('accepts a selection and null', () => {
    expect(ok({ dloc_studies: ['US public targets, 2020s'] }).success).toBe(true);
    expect(ok({ dloc_studies: null }).success).toBe(true);
  });

  it('rejects an empty selection', () => {
    // Not "use the default" — a set with nothing in it, which the engine
    // refuses. The column has a CHECK saying the same.
    expect(ok({ dloc_studies: [] }).success).toBe(false);
  });

  it('passes an unknown-but-well-formed name through to the engine pre-flight', () => {
    expect(ok({ dloc_studies: ['FactSet SIC 7372 2019-2024'] }).success).toBe(true);
  });
});

describe('dloc_study_table', () => {
  const row = { study: 'FactSet SIC 7372, 2019-2024', premium: 0.28 };

  it('accepts a minimal row and the optional period', () => {
    expect(ok({ dloc_study_table: [row] }).success).toBe(true);
    expect(ok({ dloc_study_table: [{ ...row, period_start: 2019, period_end: 2024 }] }).success).toBe(true);
  });

  it('carries a premium, not a discount', () => {
    // The two are the same fact from opposite sides and the conversion is not
    // symmetric, so the field that is stored has to be the one that was
    // observed. A row keyed `discount` is the restricted-stock shape and would
    // be inverted a second time.
    expect(ok({ dloc_study_table: [{ study: row.study, discount: 0.28 }] }).success).toBe(false);
  });

  it('rejects a negative premium and an empty table', () => {
    expect(ok({ dloc_study_table: [{ ...row, premium: -0.1 }] }).success).toBe(false);
    expect(ok({ dloc_study_table: [] }).success).toBe(false);
  });

  it('rejects an unrecognised field rather than dropping it', () => {
    expect(ok({ dloc_study_table: [{ ...row, premuim: 0.3 }] }).success).toBe(false);
  });
});
