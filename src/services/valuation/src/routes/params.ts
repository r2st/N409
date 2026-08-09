import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { DLOM_METHODS, findParams, patchParams } from '../repos/params.js';
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
    last_round_date: DateStr.nullable(),
    last_year_revenue_cents: Cents.nullable(),
    ytd_revenue_cents: Cents.nullable(),
    runway_months: z.number().int().min(0).max(600).nullable(),
    weight_asset: Weight.nullable(),
    weight_opm: Weight.nullable(),
    weight_income: Weight.nullable(),
    weight_market: Weight.nullable(),
    dloc: Fraction.nullable(),
    dlom: Fraction.nullable(),
    dlom_method: z.enum(DLOM_METHODS).nullable(),
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

    const updated = await patchParams(
      deps.pool,
      current,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
    );
    return { params: updated };
  });
}
