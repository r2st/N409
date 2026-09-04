import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { DLOC_METHODS, DLOM_METHODS, findParams, patchParams } from '../repos/params.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { malformedIfMatch, parseIfMatch, versionEtag } from '../domain/concurrency.js';
import { invalidBody } from '../domain/validationProblem.js';
import { overwriteBand } from '../domain/overwrites.js';

/**
 * Weights are accepted with up to 4 decimal places and must sum to exactly 1
 * once all four are present. Comparing in integer basis points sidesteps
 * float noise AND matches the DB CHECK (numeric addition is exact at 4dp).
 */
const Weight = z
  .number()
  .min(0)
  .max(1)
  .refine((w) => Number.isInteger(Math.round(w * 1e6) / 100), {
    message: 'At most 4 decimal places',
  });

const Fraction = z.number().min(0).max(1);

/**
 * A discount the analyst states outright, held to what the engine will apply.
 *
 * `Fraction` admits 1.0, and `compute._check_discount_range` refuses it at both
 * ends: "a 100% discount says the interest is worthless, which is a conclusion
 * about the security rather than about its control or its marketability, and
 * the two applied multiplicatively would make the other one unfalsifiable."
 * So a DLOM of 1 stored here, under a 200, and the engagement then could not be
 * calculated at all — the 422 arriving on whoever next pressed Calculate, about
 * a figure they may not have entered. `routes/engineInputs.ts` states the rule
 * this breaks a few lines from its own `exit_multiple` check: a refusal the
 * store defers is a valuation that looks configured and is not.
 *
 * Bounded at the *applied* quantum rather than at 1, because R214 moved the
 * engine's check to run after `_concluded_dlom`'s `round(dlom, 4)`: a stated
 * 0.99996 is a fraction in [0, 1) here and is refused there as 1.0. Checking
 * the figure the conclusion is struck with is the same rule, applied at the
 * door that stores it.
 *
 * Only the stated discounts take this. The model and study paths clamp at
 * `_MAX_DLOM` (0.99) inside the engine and never reach the quantum; the two
 * that take an analyst's figure without a model to cap it are `params.dlom`
 * and `dlom_method: 'qualitative'`, which is what `_concluded_dlom`'s docstring
 * names.
 *
 * The quantum is read from the registry rather than spelled out here (R413).
 * `dlom` and `dloc` are both `banded` fields — the workbook's Discounts tab
 * names each as the override that supersedes the params cell — and this door
 * accepted up to 0.9999 while the registry published 0.9, so the two doors onto
 * one number disagreed exactly as PARAMS_BAND's original four did. `min`/`max`
 * rather than `lt(1)` plus a rounding refinement, because a plain inclusive
 * band is the shape `validateOverwriteValue` enforces on the other door, and
 * two doors can only be held to one number if they can state it the same way.
 */
const StatedDiscount = (() => {
  const { min, max } = overwriteBand('dlom');
  const dloc = overwriteBand('dloc');
  // One schema for both cells, so a registry edit that moved only one of them
  // would otherwise silently bind the wrong band to the other.
  if (dloc.min !== min || dloc.max !== max) {
    throw new Error('dlom and dloc must publish the same stated-discount band');
  }
  return z.number().min(min).max(max);
})();
/** A study year on a firm-supplied evidence table. */
const StudyYear = z.number().int().min(1900).max(2200).optional();
/**
 * A study row's period, the right way round.
 *
 * The three study tables below each take a `period_start` and a `period_end`
 * and each bounded them only individually, so `{ period_start: 2000,
 * period_end: 1990 }` was a valid row. Two things then read it.
 *
 * The report does: Exhibit "Control-premium study" and the DLOM study table
 * both print `${from}–${to}` from these two columns, so an inverted row ships
 * as "2000–1990" in the evidence table a 409A conclusion rests on.
 *
 * And the engine does, differently at each family — `dlom.py` keys the
 * restricted-stock era note on `period_start` and the pre-IPO one on
 * `period_end`, each saying in as many words that it is deliberately not the
 * other. An inverted row is therefore filed under two different eras by the two
 * blenders, and neither matches the period printed beside it.
 *
 * `required_return_table` below already carries exactly this refinement, for
 * exactly this reason ("a band whose ends are the wrong way round would print
 * as a range nobody could satisfy"); the study tables were the three that did
 * not. Only ordering is checked, and only when both ends are given: a row that
 * states one end and not the other is undated rather than misdated, which is
 * what the engine's `isinstance(row.get("period_start"), int)` filter already
 * makes of it.
 */
const orderedPeriod = <T extends { period_start?: number; period_end?: number }>(row: T): boolean =>
  row.period_start === undefined || row.period_end === undefined || row.period_start <= row.period_end;
const PERIOD_ORDER = { message: 'period_start must not be after period_end' };
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');
const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A number bounded by what the overwrites registry publishes for the same
 * field — see PARAMS_BAND in `domain/overwrites.ts`.
 *
 * Four keys were bounded here *and* there, under different numbers, so the two
 * doors onto one figure disagreed about what may be in it: a runway of 400
 * months was enterable on this screen and unrecordable on the Overwrites tab
 * that supersedes it, and a control premium of 1.5 — which the comment on that
 * field below says is a real observation — was refused by the registry that
 * publishes the field's schema. Read from the registry rather than restated, so
 * the next edit to either moves both.
 */
const banded = (key: string) => {
  const { min, max } = overwriteBand(key);
  return z.number().min(min).max(max);
};
/** Treasury publishes thirteen constant-maturity tenors; 100 leaves room for any of them. */
const MAX_CURVE_POINTS = 100;

/**
 * A Treasury curve, held to the shape the engine will actually interpolate.
 *
 * The map is `{ maturity_years: yield }`, and the *keys* were checked by
 * nothing: `z.record` bounds the values, the refine below bounds how many there
 * are, and the comment beside it says "the engine reads the keys as numbers
 * whether they arrive as strings or not" — which is an assumption about the
 * keys, not a check on them. `wacc._normalize_curve` is where they are actually
 * read, and it refuses four things this door stored under a 200:
 *
 *   * a key that is not a number — `{ "5 years": 0.04 }`, or a tenor written
 *     `"5y"`, `"2Y"`, `"30-year"`;
 *   * a key that is not positive — `{ "0": 0.04 }`, overnight expressed as
 *     zero, and `{ "-1": 0.04 }`;
 *   * two keys that coerce to the same maturity — its own docstring gives the
 *     case, `{ "5": 0.04, "5.0": 0.05 }`, "interpolating strictly between them
 *     divides by `m1 - m0` == 0";
 *   * an empty curve — the branch `wacc.risk_free_rate` keeps deliberately
 *     distinct from an absent one, so that clearing the last tenor is not
 *     silently answered from the placeholder curve.
 *
 * Each of those is the shape R406 closed for `dlom`: the PATCH returns 200, the
 * engagement looks configured, and the 422 arrives on whoever next presses
 * Calculate — about a build-up input they may not have entered, named in the
 * engine's vocabulary rather than the form's. It is worse here than for a
 * discount, because the curve is *persisted and re-sent on every compute*: one
 * bad tenor stops every calculation on the engagement until somebody finds it.
 *
 * The four checks are the engine's, restated at the door that stores them, and
 * the coercion is deliberately the same one: `_num` is `float(value)`, which
 * takes `" 5 "` and `"1e1"` and refuses `"5y"` and `""`. `Number()` agrees on
 * all of those except the empty string, which it reads as 0 and which the
 * positivity check then refuses anyway.
 */
const TreasuryCurve = z
  .record(z.number().min(0).max(1))
  .superRefine((curve, ctx) => {
    const keys = Object.keys(curve);
    if (keys.length > MAX_CURVE_POINTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_CURVE_POINTS} treasury-curve points`,
      });
      return;
    }
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A treasury curve with no tenors cannot be interpolated — omit treasury_curve to use the default curve.',
      });
      return;
    }
    const seen = new Map<number, string>();
    for (const key of keys) {
      const maturity = key.trim() === '' ? Number.NaN : Number(key);
      if (!Number.isFinite(maturity) || maturity <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Treasury-curve keys are maturities in years, so “${key}” is not one — a positive number, as in {"5": 0.042}.`,
        });
        continue;
      }
      const clash = seen.get(maturity);
      if (clash !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `“${key}” and “${clash}” are the same maturity (${maturity}), and two yields at one tenor cannot be interpolated between.`,
        });
        continue;
      }
      seen.set(maturity, key);
    }
  });
/** One override per market multiple in play, with headroom. */
const MAX_CUSTOM_RANGES = 100;

export const ParamsPatchBody = z
  .object({
    rolling_forward: z.boolean(),
    inception_date: DateStr.nullable(),
    fiscal_year_end: DateStr.nullable(),
    exit_timeline: DateStr.nullable(),
    business_overview: z.string().max(20000).nullable(),
    revenue_status: z.enum(['pre_revenue', 'post_revenue']).nullable(),
    // AICPA stage of enterprise development — a judgement, so it is entered
    // rather than inferred (domain/developmentStage.ts).
    development_stage: z.number().int().min(1).max(6).nullable(),
    last_round_date: DateStr.nullable(),
    last_year_revenue_cents: Cents.nullable(),
    ytd_revenue_cents: Cents.nullable(),
    runway_months: banded('runway_months').int().nullable(),
    weight_asset: Weight.nullable(),
    weight_opm: Weight.nullable(),
    weight_income: Weight.nullable(),
    weight_market: Weight.nullable(),
    dloc: StatedDiscount.nullable(),
    // How the DLOC was derived (migration 0132). Null applies `dloc` as a
    // stated figure — the behaviour of every row written before it.
    dloc_method: z.enum(DLOC_METHODS).nullable(),
    /*
     * The control premium, as a fraction, for dloc_method = 'control_premium'.
     *
     * Not a `Fraction`: a premium is unbounded above, and 100%+ premiums are
     * observed. Only the sign is constrained, here and by the table CHECK — a
     * negative premium is a discount paid for control, which is a finding about
     * that transaction rather than evidence for a DLOC, and the engine's
     * inversion would silently read it as a premium.
     */
    control_premium: banded('control_premium').nullable(),
    // The share of an observed acquisition premium attributed to synergies
    // rather than to control, removed before the inversion. 1.0 excluded: all
    // of it being synergy says control is worth nothing, which is a conclusion
    // about that transaction rather than an adjustment to it.
    dloc_synergy_share: z.number().min(0).max(0.99).nullable(),
    // Control-premium study configuration. Shape here, membership in the
    // engine's pre-flight, which owns the table.
    dloc_studies: z.array(z.string().min(1).max(200)).min(1).max(40).nullable(),
    dloc_statistic: z.enum(['median', 'mean']).nullable(),
    dloc_study_table: z
      .array(
        z
          .object({
            study: z.string().min(1).max(200),
            premium: z.number().min(0).max(10),
            period_start: StudyYear,
            period_end: StudyYear,
          })
          .strict()
          .refine(orderedPeriod, PERIOD_ORDER),
      )
      .min(1)
      .max(60)
      .nullable(),
    dlom: StatedDiscount.nullable(),
    dlom_method: z.enum(DLOM_METHODS).nullable(),
    /**
     * A discount weighted across several methods, instead of concluded on one.
     *
     * The weights are checked for shape here and for *sum* below, with the
     * engine's pre-flight re-checking both: the DB constraint (migration 0129)
     * is the last line, and each is cheap. What none of them do is normalise —
     * see `validateDlomMethods`.
     */
    dlom_methods: z
      .array(z.object({ method: z.enum(DLOM_METHODS), weight: Fraction }).strict())
      .min(2)
      .max(DLOM_METHODS.length)
      .nullable(),
    dlom_qualitative: StatedDiscount.nullable(),
    // Restricted-stock study configuration. Validated for shape here and for
    // *membership* by the engine's pre-flight, which owns the study table and
    // is the only thing that can say which names exist.
    dlom_studies: z.array(z.string().min(1).max(200)).min(1).max(40).nullable(),
    dlom_statistic: z.enum(['median', 'mean']).nullable(),
    dlom_study_table: z
      .array(
        z
          .object({
            study: z.string().min(1).max(200),
            discount: z.number().min(0).max(0.99),
            period_start: StudyYear,
            period_end: StudyYear,
            statistic: z.enum(['median', 'mean']).optional(),
          })
          .strict()
          .refine(orderedPeriod, PERIOD_ORDER),
      )
      .min(1)
      .max(60)
      .nullable(),
    // Pre-IPO study configuration (migration 0131). Its own keys because the
    // two study tables share no names, so a blend weighting both families has
    // to be able to select from each; `dlom_statistic` is shared by both. Row
    // shape is identical to the restricted-stock table above, which is what
    // lets the engine read either through one blender.
    dlom_pre_ipo_studies: z.array(z.string().min(1).max(200)).min(1).max(40).nullable(),
    dlom_pre_ipo_table: z
      .array(
        z
          .object({
            study: z.string().min(1).max(200),
            discount: z.number().min(0).max(0.99),
            period_start: StudyYear,
            period_end: StudyYear,
            statistic: z.enum(['median', 'mean']).optional(),
          })
          .strict()
          .refine(orderedPeriod, PERIOD_ORDER),
      )
      .min(1)
      .max(60)
      .nullable(),
    // A firm's own required-return ladder, replacing the built-in literature
    // ranges Appendix III prints. Validated for shape here; `low <= high` is
    // checked per row because a band whose ends are the wrong way round would
    // print as a range nobody could satisfy.
    required_return_table: z
      .array(
        z
          .object({
            stage: z.number().int().min(1).max(6),
            category: z.string().min(1).max(200),
            low: z.number().gt(0).lt(5),
            high: z.number().gt(0).lt(5),
          })
          .strict()
          .refine((b) => b.low <= b.high, { message: 'low must not exceed high' }),
      )
      .min(1)
      .max(20)
      .nullable(),
    /*
     * The CAPM/WACC build-up behind the DCF discount rate (migration 0135).
     *
     * Keyed exactly as `engine/wacc.py compute_wacc` takes them, and `.strict()`
     * so an unknown key is a 422 here rather than a 422 from the engine's
     * pre-flight halfway through a calculation. Every premium and rate is a
     * *fraction*: the engine's overflow guard exists because 5 for 5% reaches
     * it, and the bands below are the cheap half of the same defence.
     *
     * `comparable_betas` carries the guideline set the unlevered beta is the
     * median of — stored, not just the median, for the reason `comparable_items`
     * stores the peers rather than the multiple: a median cannot be re-struck
     * on a corrected input or checked against a source.
     */
    wacc_inputs: z
      .object({
        comparable_betas: z
          .array(
            z
              .object({
                ticker: z.string().trim().min(1).max(12).optional(),
                name: z.string().trim().min(1).max(200).optional(),
                beta: z.number().min(-5).max(10),
                debt_to_equity: z.number().min(0).max(20).optional(),
                tax_rate: Fraction.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(40)
          .optional(),
        unlevered_beta_input: z.number().min(-5).max(10).optional(),
        target_debt_to_equity: z.number().min(0).max(20).optional(),
        market_cap: z.number().min(0).max(1e15).optional(),
        tax_rate: Fraction.optional(),
        equity_risk_premium: banded('equity_risk_premium').optional(),
        // `gt(0)` rather than the registry's inclusive floor of 0: a horizon of
        // zero years is not a short forecast, it is no forecast at all, and the
        // terminal-value maths divides by it.
        forecast_horizon_years: banded('forecast_horizon_years').gt(0).optional(),
        risk_free_rate_override: z.number().min(0).max(1).optional(),
        // { "5": 0.042 } — maturity in years to yield, bounded on all three
        // axes: the yields by `z.record`, the point count and the maturities
        // themselves by `TreasuryCurve`. This map is persisted to
        // `valuation_params` and re-sent to the engine on every compute, so
        // anything wrong with it is wrong with every calculation from here on.
        treasury_curve: TreasuryCurve.optional(),
        company_specific_premium: z.number().min(-1).max(1).optional(),
        size_premium_override: z.number().min(-1).max(1).optional(),
        cost_of_debt: z.number().min(0).max(1).optional(),
        debt_weight: Fraction.optional(),
      })
      .strict()
      .nullable(),
    // Whether the build-up drives the discount rate. Separate from the presence
    // of `wacc_inputs`, so an analyst can hold a build-up on the engagement
    // while deciding whether to adopt it.
    auto_wacc: z.boolean(),
    market_method: z.enum(['revenue', 'ebitda']).nullable(),
    market_horizon: z.enum(['ltm', 'ntm']).nullable(),
    // Same reasoning as `treasury_curve`: persisted jsonb, one entry per market
    // multiple the analyst overrides, and nothing measured the count.
    market_custom_ranges: z
      .record(z.unknown())
      .refine((v) => Object.keys(v).length <= MAX_CUSTOM_RANGES, {
        message: `At most ${MAX_CUSTOM_RANGES} custom market ranges`,
      })
      .nullable(),
    asset_method: z.enum(['cost_to_replicate', 'nav']).nullable(),
    allocation_method: z.enum(['opm', 'pwerm', 'hybrid', 'cvm', 'monte_carlo']),
  })
  .partial()
  .strict();

export type ParamsPatch = z.infer<typeof ParamsPatchBody>;

const WEIGHT_KEYS = ['weight_asset', 'weight_opm', 'weight_income', 'weight_market'] as const;

/**
 * Validates the merged weight set (current row + patch): either all four are
 * null, or all four are set and sum to 1.0000 (basis-point exact).
 */
export function validateWeights(
  current: Record<string, unknown>,
  patch: ParamsPatch,
): { ok: true } | { ok: false; detail: string } {
  const merged = WEIGHT_KEYS.map((k) =>
    k in patch ? (patch[k] as number | null) : current[k] === null ? null : Number(current[k]),
  );
  const setCount = merged.filter((w) => w !== null).length;
  if (setCount === 0) return { ok: true };
  if (setCount < 4) {
    return { ok: false, detail: 'Set all four approach weights together (or clear all four)' };
  }
  const bps = merged.reduce((acc: number, w) => acc + Math.round((w as number) * 10000), 0);
  if (bps !== 10000) {
    return { ok: false, detail: `Approach weights must sum to 1.0 (got ${(bps / 10000).toFixed(4)})` };
  }
  return { ok: true };
}

/**
 * Validates the merged DLOM selection (current row + patch).
 *
 * Three things, all of which the engine also checks — this is the one that can
 * refuse at save time, before a calculation is dispatched:
 *
 *   * one form or the other. A row carrying both `dlom_method` and
 *     `dlom_methods` has two answers to "which discount was concluded", and
 *     whichever the engine read would be the one the analyst did not mean.
 *   * weights summing to 1. They are deliberately *not* normalised: weights
 *     totalling 0.9 are a mistake in somebody's spreadsheet, not an instruction
 *     to scale up by a ninth, and rescaling them would conclude on a discount
 *     nobody chose. Compared in basis points for the same reason
 *     `validateWeights` is — 0.1 + 0.2 + 0.7 is not 1.0 in binary floating point.
 *   * a qualitative leg needs its own figure, exactly as a qualitative
 *     single-method run does. Nothing derives it.
 */
export function validateDlomMethods(
  current: Record<string, unknown>,
  patch: ParamsPatch,
): { ok: true } | { ok: false; detail: string } {
  const blend =
    'dlom_methods' in patch ? patch.dlom_methods : (current.dlom_methods as ParamsPatch['dlom_methods']);
  if (blend === null || blend === undefined) return { ok: true };

  const method = 'dlom_method' in patch ? patch.dlom_method : current.dlom_method;
  if (method !== null && method !== undefined) {
    return {
      ok: false,
      detail:
        'Set either dlom_method (one method) or dlom_methods (a weighted blend), not both — ' +
        'clear dlom_method to weight several',
    };
  }

  const names = blend.map((m) => m.method);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate !== undefined) {
    return { ok: false, detail: `${duplicate} is weighted twice — give each method a single weight` };
  }

  const bps = blend.reduce((acc, m) => acc + Math.round(m.weight * 10000), 0);
  if (bps !== 10000) {
    return {
      ok: false,
      detail: `DLOM method weights must sum to 1.0 (got ${(bps / 10000).toFixed(4)})`,
    };
  }

  const qual = 'dlom_qualitative' in patch ? patch.dlom_qualitative : current.dlom_qualitative;
  if (names.includes('qualitative') && (qual === null || qual === undefined)) {
    return {
      ok: false,
      detail: 'dlom_qualitative is required when "qualitative" is one of the weighted methods',
    };
  }
  return { ok: true };
}

/**
 * Validates the merged WACC build-up (current row + patch).
 *
 * Two states are refused, both because they read as configured and do nothing:
 *
 *   * `auto_wacc` on with no build-up to run — the engine's `auto_wacc` branch
 *     skips a missing or empty `inputs.wacc` in silence, so the switch would
 *     sit on with no effect and Appendix I would still not render;
 *   * a build-up with neither a beta set nor an unlevered beta — the engine
 *     raises "provide comparable_betas or unlevered_beta_input", and catching
 *     it here names the field while the analyst is still on the form rather
 *     than at the end of a calculation.
 */
export function validateWaccBuildUp(
  current: Record<string, unknown>,
  patch: ParamsPatch,
): { ok: true } | { ok: false; detail: string } {
  const inputs = ('wacc_inputs' in patch ? patch.wacc_inputs : current.wacc_inputs) as
    Record<string, unknown> | null | undefined;
  const on = 'auto_wacc' in patch ? patch.auto_wacc : current.auto_wacc === true;
  const present =
    inputs !== null && inputs !== undefined && typeof inputs === 'object' && Object.keys(inputs).length > 0;

  if (on && !present) {
    return {
      ok: false,
      detail:
        'Enter the WACC build-up before switching it on — an empty build-up would leave the discount rate as it is',
    };
  }
  if (present) {
    const betas = inputs.comparable_betas;
    const hasSet = Array.isArray(betas) && betas.length > 0;
    if (!hasSet && inputs.unlevered_beta_input === undefined) {
      return {
        ok: false,
        detail: 'A WACC build-up needs either a guideline beta set or an unlevered beta to relever',
      };
    }
  }
  return { ok: true };
}

/**
 * Every invariant a patched params row has to satisfy, checked against the row
 * the patch will actually land on.
 *
 * The four above were each called once, in this order, on the row the request
 * had read moments earlier — which is correct for one editor and wrong for
 * two. Two analysts on one engagement each merge their patch over the row *as
 * they read it*, so two patches that are individually legal compose into a row
 * that is not: one moves weight from asset to opm while the other moves it
 * from market to opm, both pass, and the row that lands sums to 1.25. The
 * table's `weights_sum_to_one` and `valuation_params_one_dlom_form` are then
 * the only things between that and a stored valuation, and a check constraint
 * firing inside a repo nothing catches is a 500 — which tells the analyst who
 * lost the race nothing at all.
 *
 * So the rules are named once here and run twice: by the route, on the row it
 * read, so a patch that is wrong on its own is refused before a transaction is
 * opened; and by `patchParams`, on the row it has locked for the write, which
 * is the one reading nobody else can have moved. The second run is what turns
 * the losing patch of a race into the same 422 it would have got had the two
 * analysts saved a second apart.
 */
export function checkParamInvariants(
  current: Record<string, unknown>,
  patch: ParamsPatch,
): { ok: true } | { ok: false; detail: string } {
  const weights = validateWeights(current, patch);
  if (!weights.ok) return weights;

  // Qualitative DLOM needs its value; model methods compute DLOM in the engine.
  const method = 'dlom_method' in patch ? patch.dlom_method : current.dlom_method;
  const dlomQual = 'dlom_qualitative' in patch ? patch.dlom_qualitative : current.dlom_qualitative;
  if (method === 'qualitative' && (dlomQual === null || dlomQual === undefined)) {
    return { ok: false, detail: 'dlom_qualitative is required when dlom_method is "qualitative"' };
  }

  const blend = validateDlomMethods(current, patch);
  if (!blend.ok) return blend;

  return validateWaccBuildUp(current, patch);
}

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

export function registerParamsRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (principal: Principal, id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };

  app.get('/api/v1/valuations/:id/params', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const params = await findParams(deps.pool, id);
    if (!params) throw problems.notFound();
    // The version the Params panel sends back as If-Match. `params` already
    // carries `version` in its body, so this header is the part that lets a
    // plain HTTP client play along without knowing the column exists.
    reply.header('ETag', versionEtag(params.version));
    return { params };
  });

  app.patch('/api/v1/valuations/:id/params', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    // Methodology is set by analysts — ops-only, mirroring OPS_PATCH_FIELDS.
    if (!isOps(principal)) throw problems.forbidden('Valuation params are operations-only');
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadValuation(principal, id), 'accepting changes');
    const current = await findParams(deps.pool, id);
    if (!current) throw problems.notFound();

    // Same contract as the engine-inputs editor beside it, which has been
    // guarding this very row since migration 0158 — and the same reason,
    // more so: the Params panel posts forty-odd fields it read when the tab
    // was opened, so the write it builds on a stale read reverts every one of
    // them. A malformed header is refused rather than ignored; an If-Match
    // nobody parses is a lost-update guard that silently is not there.
    const ifMatch = parseIfMatch(req.headers['if-match']);
    if (ifMatch.kind === 'invalid') {
      throw malformedIfMatch(ifMatch);
    }
    const expectedVersion = ifMatch.kind === 'version' ? ifMatch.version : undefined;

    const parsed = ParamsPatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid params', parsed.error);

    const check = checkParamInvariants(current, parsed.data);
    if (!check.ok) throw problems.unprocessable(check.detail);

    const updated = await patchParams(
      deps.pool,
      current,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
      // Run again inside the write, against the locked row. Same rules, same
      // messages — the only difference is that this reading of "the row" is
      // one no concurrent editor can have moved.
      {
        revalidate: (fresh) => checkParamInvariants(fresh, parsed.data),
        expectedVersion,
      },
    );
    reply.header('ETag', versionEtag(updated.version));
    return { params: updated };
  });
}
