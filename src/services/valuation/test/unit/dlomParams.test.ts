import { describe, expect, it } from 'vitest';
import { ParamsPatchBody } from '../../src/routes/params.js';
import { DLOM_METHODS } from '../../src/repos/params.js';

/**
 * The DLOM configuration accepted on PATCH /params.
 *
 * The split of responsibility is the thing worth pinning: this schema checks
 * *shape*, and the engine's pre-flight checks *membership* — it owns the study
 * table and is the only thing that can say which study names exist. So a
 * well-formed name for a study nobody has heard of passes here and is caught
 * there, and that is deliberate rather than a gap.
 */

const ok = (patch: Record<string, unknown>) => ParamsPatchBody.safeParse(patch);

describe('dlom_method', () => {
  it.each(DLOM_METHODS)('accepts %s', (method) => {
    expect(ok({ dlom_method: method }).success).toBe(true);
  });

  it('accepts null (unset)', () => {
    expect(ok({ dlom_method: null }).success).toBe(true);
  });

  it('rejects a method the engine cannot dispatch on', () => {
    expect(ok({ dlom_method: 'black_scholes' }).success).toBe(false);
  });

  it('covers every method the engine dispatches on', () => {
    // Mirrors engine dlom.py DLOM_METHODS. A method added to one side and not
    // the other is either a 422 the UI cannot explain or a value the engine
    // silently treats as a flat discount.
    expect([...DLOM_METHODS].sort()).toEqual([
      'chaffee',
      'finnerty',
      'ghaidarov',
      'longstaff',
      'qualitative',
      'restricted_stock',
    ]);
  });
});

describe('dlom_studies', () => {
  it('accepts a selection', () => {
    expect(ok({ dlom_studies: ['Gelman', 'Johnson'] }).success).toBe(true);
  });

  it('accepts null — which is how "use the engine default set" is spelled', () => {
    expect(ok({ dlom_studies: null }).success).toBe(true);
  });

  it('rejects an empty selection', () => {
    // An empty array is not "use the default", it is a set with nothing in it.
    // The column has a CHECK saying the same (migration 0111).
    expect(ok({ dlom_studies: [] }).success).toBe(false);
  });

  it('rejects a blank study name', () => {
    expect(ok({ dlom_studies: [''] }).success).toBe(false);
  });

  it('rejects a selection longer than the table could ever be', () => {
    expect(ok({ dlom_studies: Array(41).fill('Gelman') }).success).toBe(false);
  });

  it('passes an unknown-but-well-formed name through to the engine pre-flight', () => {
    expect(ok({ dlom_studies: ['No Such Study'] }).success).toBe(true);
  });
});

describe('dlom_statistic', () => {
  it.each(['median', 'mean'])('accepts %s', (stat) => {
    expect(ok({ dlom_statistic: stat }).success).toBe(true);
  });

  it('rejects anything else', () => {
    expect(ok({ dlom_statistic: 'mode' }).success).toBe(false);
  });
});

describe('dlom_study_table', () => {
  const row = { study: 'Firm internal 2024', discount: 0.18 };

  it('accepts a minimal row', () => {
    expect(ok({ dlom_study_table: [row] }).success).toBe(true);
  });

  it('accepts the optional period and statistic fields', () => {
    expect(
      ok({
        dlom_study_table: [
          { ...row, period_start: 2018, period_end: 2024, statistic: 'median' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a discount of 1.0 or more', () => {
    // A 100% discount says the interest is worthless, which is a conclusion
    // about the security rather than about its marketability.
    expect(ok({ dlom_study_table: [{ ...row, discount: 1 }] }).success).toBe(false);
  });

  it('rejects a negative discount', () => {
    expect(ok({ dlom_study_table: [{ ...row, discount: -0.1 }] }).success).toBe(false);
  });

  it('rejects a row with no discount', () => {
    expect(ok({ dlom_study_table: [{ study: 'Firm internal' }] }).success).toBe(false);
  });

  it('rejects an unrecognised field rather than dropping it', () => {
    // .strict() — a typo'd key is a silently ignored input otherwise, and the
    // engine would conclude on a table missing whatever the analyst meant.
    expect(ok({ dlom_study_table: [{ ...row, dicsount: 0.2 }] }).success).toBe(false);
  });

  it('rejects an out-of-range period year', () => {
    expect(ok({ dlom_study_table: [{ ...row, period_start: 1800 }] }).success).toBe(false);
  });

  it('rejects a non-integer period year', () => {
    expect(ok({ dlom_study_table: [{ ...row, period_start: 2018.5 }] }).success).toBe(false);
  });

  it('rejects an empty table', () => {
    expect(ok({ dlom_study_table: [] }).success).toBe(false);
  });
});

describe('market horizon', () => {
  it.each(['ltm', 'ntm'])('accepts %s', (horizon) => {
    expect(ok({ market_horizon: horizon }).success).toBe(true);
  });

  it('rejects a horizon the engine cannot resolve a metric for', () => {
    expect(ok({ market_horizon: 'forward' }).success).toBe(false);
  });

  it.each(['revenue', 'ebitda'])('accepts market_method %s', (method) => {
    expect(ok({ market_method: method }).success).toBe(true);
  });
});
