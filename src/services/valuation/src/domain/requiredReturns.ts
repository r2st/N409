import { DEVELOPMENT_STAGES, STAGE_DEFINITIONS, type DevelopmentStage } from './developmentStage.js';

/**
 * Indicative required rates of return by stage of enterprise development.
 *
 * The income approach concludes on a discount rate, and Appendix I sets out how
 * that rate was built. What a build-up cannot do on its own is say whether the
 * result is *plausible for a company at this stage* — a 22% WACC is unremarkable
 * for a profitable business and implausible for one with a prototype and no
 * revenue. The venture capital literature answers exactly that question, which
 * is why the legacy deliverable devotes a table to it, and why a reviewer looks
 * for one.
 *
 * ## Provenance, and its limits
 *
 * These are the stage-banded ranges of the venture capital method — Plummer
 * (1987) and Scherlis & Sahlman (1987), reproduced in the standard valuation
 * texts and echoed by the AICPA practice aid whose six-stage scale
 * `developmentStage.ts` implements. They are *indicative ranges from the
 * literature*, not a survey vintage:
 *
 *   * They are not attributed to any one annual survey. Sources such as the
 *     Pepperdine Private Capital Markets Report publish their own figures on
 *     their own cut, they are revised every year, and a table hardcoded from
 *     one edition would go stale silently while continuing to carry that
 *     report's name in a document somebody relies on. Nothing here claims to
 *     be a particular survey's numbers.
 *   * They corroborate a rate; they do not derive one. The report says so, and
 *     `matchedStage` marks the concluded stage's band rather than proposing a
 *     rate from it.
 *
 * A firm with subscription data supplies its own rows through
 * `valuation_params.required_return_table`, exactly as `dlom_study_table`
 * replaces the built-in restricted-stock studies. The built-ins exist so a
 * report can carry the corroboration without that, not to settle what the
 * authoritative figures are. Anyone concluding on this should cite the source
 * they actually read, not this file.
 */

export interface RequiredReturnBand {
  /** The AICPA stage this band describes. */
  stage: DevelopmentStage;
  /** Investment category, as the venture capital literature names it. */
  category: string;
  /** Inclusive low end of the indicative range, as a fraction. */
  low: number;
  /** Inclusive high end, as a fraction. */
  high: number;
}

/**
 * The built-in ladder. Returns fall monotonically with stage because the
 * required return is compensation for the risk that remains: a seed company
 * carries technology risk, market risk and financing risk at once, and each
 * milestone retires one of them.
 */
export const REQUIRED_RETURN_BANDS: readonly RequiredReturnBand[] = [
  { stage: 1, category: 'Seed / start-up', low: 0.5, high: 0.7 },
  { stage: 2, category: 'First stage — product development', low: 0.4, high: 0.6 },
  { stage: 3, category: 'Second stage — milestones met, pre-revenue', low: 0.35, high: 0.5 },
  { stage: 4, category: 'Third stage — revenue, operating at a loss', low: 0.3, high: 0.4 },
  { stage: 5, category: 'Bridge / mezzanine — breakeven or positive cash flow', low: 0.25, high: 0.35 },
  { stage: 6, category: 'Late stage — liquidity event foreseeable', low: 0.2, high: 0.3 },
];

/** One row as the report prints it, with the concluded stage marked. */
export interface RequiredReturnRow extends RequiredReturnBand {
  /** The practice aid's label for the stage, so the row is self-describing. */
  label: string;
  /** Whether this is the stage the analyst concluded on. */
  matched: boolean;
}

/**
 * What this module refuses a stored table with.
 *
 * A type, not a bare `Error`, because the wording now reaches a person. R345
 * put a schedule that failed to build on the QA review a reviewer reads, and
 * `errorBodyDisclosure`'s rule is that an error's own message is publishable
 * only when something vouched for it — every sentence below is written here
 * and names a field and a rule, so this class is that vouching. Anything else
 * escaping this function is a shape nobody wrote a sentence for and is
 * published as a category instead.
 */
export class RequiredReturnTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequiredReturnTableError';
  }
}

/**
 * A caller-supplied table, validated, or the built-in ladder.
 *
 * A malformed override is refused rather than silently ignored: a firm that
 * meant to supply its own figures and typed them wrongly should not have a
 * report quietly print a different table under the same heading. `null` and
 * `undefined` both mean "no override".
 */
export function requiredReturnBands(override?: unknown): readonly RequiredReturnBand[] {
  if (override === null || override === undefined) return REQUIRED_RETURN_BANDS;
  if (!Array.isArray(override) || override.length === 0) {
    throw new RequiredReturnTableError('required_return_table must be a non-empty array of bands');
  }
  return override.map((raw, i) => {
    const row = raw as Partial<RequiredReturnBand>;
    if (typeof row !== 'object' || row === null) {
      throw new RequiredReturnTableError(`required_return_table[${i}] must be an object`);
    }
    const { stage, category, low, high } = row;
    if (!DEVELOPMENT_STAGES.includes(stage as DevelopmentStage)) {
      throw new RequiredReturnTableError(
        `required_return_table[${i}].stage must be one of ${DEVELOPMENT_STAGES.join(', ')}`,
      );
    }
    if (typeof category !== 'string' || category.trim() === '') {
      throw new RequiredReturnTableError(`required_return_table[${i}].category is required`);
    }
    for (const [key, v] of [
      ['low', low],
      ['high', high],
    ] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 5) {
        throw new RequiredReturnTableError(`required_return_table[${i}].${key} must be a fraction in (0, 5)`);
      }
    }
    if ((low as number) > (high as number)) {
      throw new RequiredReturnTableError(`required_return_table[${i}].low must not exceed .high`);
    }
    return { stage: stage as DevelopmentStage, category, low: low as number, high: high as number };
  });
}

/**
 * The table as the report prints it, in stage order, with the concluded stage
 * marked.
 *
 * `stage` null — nobody has concluded one — still returns the full table:
 * the ladder is context for the discount rate whether or not a stage has been
 * recorded, and it is the *marking* that depends on the conclusion, not the
 * table. Callers that want nothing at all in that case check the stage
 * themselves.
 */
export function requiredReturnRows(
  stage: number | null | undefined,
  override?: unknown,
): RequiredReturnRow[] {
  return [...requiredReturnBands(override)]
    .sort((a, b) => a.stage - b.stage)
    .map((band) => ({
      ...band,
      label: STAGE_DEFINITIONS[band.stage]?.label ?? `Stage ${band.stage}`,
      matched: stage === band.stage,
    }));
}
