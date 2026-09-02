import { describe, expect, it } from 'vitest';
import { ParamsPatchBody, validateDlomMethods } from '../../src/routes/params.js';
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
      'pre_ipo',
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
        dlom_study_table: [{ ...row, period_start: 2018, period_end: 2024, statistic: 'median' }],
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

  /**
   * R343, M19. Each end was bounded on its own and the pair was never
   * compared, so `{ period_start: 2000, period_end: 1990 }` was a valid row —
   * one the exhibit prints as "2000–1990" into the evidence table a 409A
   * conclusion rests on, and one the engine files under two different eras
   * because `dlom.py` keys the restricted-stock note on `period_start` and the
   * pre-IPO one on `period_end`.
   */
  it('rejects a period whose ends are the wrong way round', () => {
    expect(ok({ dlom_study_table: [{ ...row, period_start: 2000, period_end: 1990 }] }).success).toBe(false);
  });

  it('accepts a period of one year, where the ends are equal', () => {
    expect(ok({ dlom_study_table: [{ ...row, period_start: 1997, period_end: 1997 }] }).success).toBe(true);
  });

  it('accepts a row that states one end of its period and not the other', () => {
    // Undated rather than misdated: the engine's own filter reads
    // `period_start` alone, so half a period is a row it leaves out of the era
    // note rather than one it gets wrong.
    expect(ok({ dlom_study_table: [{ ...row, period_start: 1997 }] }).success).toBe(true);
    expect(ok({ dlom_study_table: [{ ...row, period_end: 1997 }] }).success).toBe(true);
  });

  it('rejects an empty table', () => {
    expect(ok({ dlom_study_table: [] }).success).toBe(false);
  });
});

/**
 * The pre-IPO study family (migration 0131).
 *
 * It gets its own selection keys rather than sharing `dlom_studies`, and the
 * case that forces it is the one where both families are live: a `dlom_methods`
 * blend weighting a restricted-stock leg against a pre-IPO one. A shared column
 * could not address both tables at once, so each leg's selection would be
 * unrepresentable in the presence of the other.
 */
describe('dlom_pre_ipo_studies', () => {
  it('accepts a selection', () => {
    expect(ok({ dlom_pre_ipo_studies: ['Emory 1997-2000', 'Willamette 1997'] }).success).toBe(true);
  });

  it('accepts null — the engine default set', () => {
    expect(ok({ dlom_pre_ipo_studies: null }).success).toBe(true);
  });

  it('rejects an empty selection', () => {
    expect(ok({ dlom_pre_ipo_studies: [] }).success).toBe(false);
  });

  it('is independent of the restricted-stock selection', () => {
    // Both set at once is the blend case, and it has to be expressible.
    expect(ok({ dlom_studies: ['Gelman'], dlom_pre_ipo_studies: ['Emory 1997-2000'] }).success).toBe(true);
  });
});

describe('dlom_pre_ipo_table', () => {
  const row = { study: 'Firm pre-IPO 2024', discount: 0.44 };

  it('takes the same row shape as the restricted-stock table', () => {
    // Identical on purpose: it is what lets the engine read either family
    // through one blender, so neither leg of a blend can grow a reporting
    // field the other lacks.
    expect(
      ok({
        dlom_pre_ipo_table: [{ ...row, period_start: 1997, period_end: 2000, statistic: 'mean' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a discount of 1.0 or more, a negative one, and an empty table', () => {
    expect(ok({ dlom_pre_ipo_table: [{ ...row, discount: 1 }] }).success).toBe(false);
    expect(ok({ dlom_pre_ipo_table: [{ ...row, discount: -0.1 }] }).success).toBe(false);
    expect(ok({ dlom_pre_ipo_table: [] }).success).toBe(false);
  });

  it('rejects an unrecognised field rather than dropping it', () => {
    expect(ok({ dlom_pre_ipo_table: [{ ...row, dicsount: 0.2 }] }).success).toBe(false);
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

// ── a weighted blend of methods ───────────────────────────────────────────────

/**
 * A discount weighted across several methods (migration 0129).
 *
 * The weights are checked in three places — here at save time, in the engine's
 * pre-flight, and in the engine itself — plus a table constraint on the
 * mutual exclusion. That looks redundant until you see what the shape makes
 * easy: a blend whose weights total 90%. They are deliberately never
 * normalised, so that blend concludes a tenth low rather than on the analyst's
 * figures scaled up, and nothing about the resulting report looks wrong.
 */
describe('dlom_methods', () => {
  const BLEND = [
    { method: 'finnerty', weight: 0.5 },
    { method: 'restricted_stock', weight: 0.5 },
  ];

  it('accepts a well-formed blend', () => {
    expect(ok({ dlom_methods: BLEND }).success).toBe(true);
  });

  it('accepts null (no blend — conclude on one method)', () => {
    expect(ok({ dlom_methods: null }).success).toBe(true);
  });

  it('rejects a blend of one', () => {
    // A single method with extra steps. Two is the point at which weighting
    // means anything, and `dlom_method` is how one method is selected.
    expect(ok({ dlom_methods: [{ method: 'finnerty', weight: 1 }] }).success).toBe(false);
  });

  it('rejects a method the engine cannot dispatch on', () => {
    expect(ok({ dlom_methods: [{ method: 'black_scholes', weight: 0.5 }, BLEND[1]] }).success).toBe(false);
  });

  it('rejects a weight outside [0, 1]', () => {
    expect(ok({ dlom_methods: [{ method: 'finnerty', weight: 1.5 }, BLEND[1]] }).success).toBe(false);
    expect(ok({ dlom_methods: [{ method: 'finnerty', weight: -0.5 }, BLEND[1]] }).success).toBe(false);
  });

  it('rejects a leg missing its weight, or carrying anything extra', () => {
    expect(ok({ dlom_methods: [{ method: 'finnerty' }, BLEND[1]] }).success).toBe(false);
    expect(ok({ dlom_methods: [{ ...BLEND[0], note: 'because' }, BLEND[1]] }).success).toBe(false);
  });
});

describe('validateDlomMethods', () => {
  const BLEND = [
    { method: 'finnerty' as const, weight: 0.5 },
    { method: 'restricted_stock' as const, weight: 0.5 },
  ];
  const EMPTY = { dlom_method: null, dlom_methods: null, dlom_qualitative: null };

  it('passes a blend summing to 1', () => {
    expect(validateDlomMethods(EMPTY, { dlom_methods: BLEND }).ok).toBe(true);
  });

  it('passes when no blend is configured at all', () => {
    expect(validateDlomMethods(EMPTY, {}).ok).toBe(true);
    expect(validateDlomMethods(EMPTY, { dlom_method: 'finnerty' }).ok).toBe(true);
  });

  it('refuses weights that do not sum to 1 rather than normalising them', () => {
    /*
     * The whole point. Weights totalling 0.9 are a mistake in somebody's
     * spreadsheet, not an instruction to scale up by a ninth — rescaling would
     * conclude on a discount nobody chose, and the report would state it with
     * every appearance of having been reasoned. Same rule the four approach
     * weights follow.
     */
    const result = validateDlomMethods(EMPTY, {
      dlom_methods: [
        { method: 'finnerty', weight: 0.5 },
        { method: 'restricted_stock', weight: 0.4 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('0.9000');
  });

  it('accepts thirds, which do not sum to 1 in binary floating point', () => {
    // Compared in basis points for exactly this: 0.3333 × 3 is not 1.0, and an
    // analyst splitting three ways evenly is not making a mistake.
    expect(
      validateDlomMethods(EMPTY, {
        dlom_methods: [
          { method: 'finnerty', weight: 0.3333 },
          { method: 'chaffee', weight: 0.3333 },
          { method: 'restricted_stock', weight: 0.3334 },
        ],
      }).ok,
    ).toBe(true);
  });

  it('refuses both forms at once', () => {
    // Two answers to "which discount was concluded"; whichever the engine read
    // would be the one the analyst did not mean.
    const result = validateDlomMethods(EMPTY, { dlom_method: 'chaffee', dlom_methods: BLEND });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('not both');
  });

  it('sees a conflict with a method already on the row', () => {
    // The patch is partial, so the conflict is between what is being saved and
    // what is already there — a blend saved onto a row that already names a
    // single method is the same illegal state.
    const result = validateDlomMethods({ ...EMPTY, dlom_method: 'chaffee' }, { dlom_methods: BLEND });
    expect(result.ok).toBe(false);
  });

  it('allows a blend that clears the single method in the same patch', () => {
    expect(
      validateDlomMethods({ ...EMPTY, dlom_method: 'chaffee' }, { dlom_method: null, dlom_methods: BLEND })
        .ok,
    ).toBe(true);
  });

  it('refuses a method weighted twice', () => {
    const result = validateDlomMethods(EMPTY, {
      dlom_methods: [
        { method: 'finnerty', weight: 0.5 },
        { method: 'finnerty', weight: 0.5 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('twice');
  });

  it('requires a qualitative leg to carry its own figure', () => {
    const blend = [
      { method: 'qualitative' as const, weight: 0.5 },
      { method: 'finnerty' as const, weight: 0.5 },
    ];
    expect(validateDlomMethods(EMPTY, { dlom_methods: blend }).ok).toBe(false);
    // Supplied in the same patch, or already on the row — either is enough.
    expect(validateDlomMethods(EMPTY, { dlom_methods: blend, dlom_qualitative: 0.2 }).ok).toBe(true);
    expect(validateDlomMethods({ ...EMPTY, dlom_qualitative: 0.2 }, { dlom_methods: blend }).ok).toBe(true);
  });

  it('accepts a nil-weighted method', () => {
    // An appraiser who computed Longstaff to show it as an upper bound and
    // weighted it to nothing is documenting the bound, not concluding on it.
    expect(
      validateDlomMethods(EMPTY, {
        dlom_methods: [
          { method: 'finnerty', weight: 1 },
          { method: 'longstaff', weight: 0 },
        ],
      }).ok,
    ).toBe(true);
  });
});
