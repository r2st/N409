import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { DLOC_METHODS, DLOM_METHODS, findParams, patchParams } from '../repos/params.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

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
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');
const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

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
    runway_months: z.number().int().min(0).max(600).nullable(),
    weight_asset: Weight.nullable(),
    weight_opm: Weight.nullable(),
    weight_income: Weight.nullable(),
    weight_market: Weight.nullable(),
    dloc: Fraction.nullable(),
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
    control_premium: z.number().min(0).max(10).nullable(),
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
            period_start: z.number().int().min(1900).max(2200).optional(),
            period_end: z.number().int().min(1900).max(2200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(60)
      .nullable(),
    dlom: Fraction.nullable(),
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
    dlom_qualitative: Fraction.nullable(),
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
            period_start: z.number().int().min(1900).max(2200).optional(),
            period_end: z.number().int().min(1900).max(2200).optional(),
            statistic: z.enum(['median', 'mean']).optional(),
          })
          .strict(),
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
            period_start: z.number().int().min(1900).max(2200).optional(),
            period_end: z.number().int().min(1900).max(2200).optional(),
            statistic: z.enum(['median', 'mean']).optional(),
          })
          .strict(),
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
        equity_risk_premium: z.number().min(0).max(1).optional(),
        forecast_horizon_years: z.number().gt(0).max(50).optional(),
        risk_free_rate_override: z.number().min(0).max(1).optional(),
        // { "5": 0.042 } — maturity in years to yield. The engine reads the
        // keys as numbers whether they arrive as strings or not.
        treasury_curve: z.record(z.number().min(0).max(1)).optional(),
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
    market_custom_ranges: z.record(z.unknown()).nullable(),
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
    | Record<string, unknown>
    | null
    | undefined;
  const on = 'auto_wacc' in patch ? patch.auto_wacc : current.auto_wacc === true;
  const present =
    inputs !== null && inputs !== undefined && typeof inputs === 'object' && Object.keys(inputs).length > 0;

  if (on && !present) {
    return {
      ok: false,
      detail: 'Enter the WACC build-up before switching it on — an empty build-up would leave the discount rate as it is',
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

  app.get('/api/v1/valuations/:id/params', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const params = await findParams(deps.pool, id);
    if (!params) throw problems.notFound();
    return { params };
  });

  app.patch('/api/v1/valuations/:id/params', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    // Methodology is set by analysts — ops-only, mirroring OPS_PATCH_FIELDS.
    if (!isOps(principal)) throw problems.forbidden('Valuation params are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const current = await findParams(deps.pool, id);
    if (!current) throw problems.notFound();

    const parsed = ParamsPatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid params', { errors: parsed.error.issues });

    const weights = validateWeights(current, parsed.data);
    if (!weights.ok) throw problems.unprocessable(weights.detail);

    // Qualitative DLOM needs its value; model methods compute DLOM in the engine.
    const method = 'dlom_method' in parsed.data ? parsed.data.dlom_method : current.dlom_method;
    const dlomQual =
      'dlom_qualitative' in parsed.data ? parsed.data.dlom_qualitative : current.dlom_qualitative;
    if (method === 'qualitative' && (dlomQual === null || dlomQual === undefined)) {
      throw problems.unprocessable('dlom_qualitative is required when dlom_method is "qualitative"');
    }

    const blend = validateDlomMethods(current, parsed.data);
    if (!blend.ok) throw problems.unprocessable(blend.detail);

    const wacc = validateWaccBuildUp(current, parsed.data);
    if (!wacc.ok) throw problems.unprocessable(wacc.detail);

    const updated = await patchParams(
      deps.pool,
      current,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
    );
    return { params: updated };
  });
}
