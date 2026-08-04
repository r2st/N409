import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/**
 * Analyst-entered financial model (`valuation_params.engine_inputs`).
 *
 * The compute engine (engine-wrapper: app/engine/compute.py) reads its `inputs`
 * document to run the four approaches. Until now that document could only be
 * populated by AI document extraction (routes/ai.ts auto-apply); this endpoint
 * lets an analyst hand-enter the whole model. The Zod schema mirrors exactly
 * what compute.py + waterfall.py consume, so anything that validates here can
 * be fed straight to the engine.
 *
 * Persistence is a jsonb merge (applyEngineInputs) keyed on top-level fields:
 * each section the form submits replaces that key wholesale, and keys it does
 * not touch (e.g. an AI-extracted value the form has no widget for) survive.
 * Send an explicit null to clear a field/section.
 */

const nonNeg = z.number().nonnegative();
const pos = z.number().positive();
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');
const ClassName = z.string().trim().min(1).max(80);

/** One row of the cap table — mirrors waterfall.py `_normalize`. */
const ShareClass = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('common'), name: ClassName, shares: pos }),
  z.object({
    kind: z.literal('preferred'),
    name: ClassName,
    shares: pos,
    preference: nonNeg,
    seniority: z.number().int().min(1).max(50).default(1),
    participating: z.boolean().default(false),
    conversion_ratio: pos.max(1000).default(1),
  }),
  z.object({ kind: z.literal('option'), name: ClassName, shares: pos, strike: pos }),
]);

export const EngineInputsBody = z
  .object({
    // Cap table / OPM allocation (compute.py "OPM allocation to common").
    shares_outstanding_common: pos.nullable().optional(),
    shares_outstanding_preferred: nonNeg.nullable().optional(),
    options_outstanding: nonNeg.nullable().optional(),
    liquidation_preference: nonNeg.nullable().optional(),
    share_classes: z.array(ShareClass).max(50).nullable().optional(),

    // Shared assumptions.
    volatility: z.number().positive().max(5).nullable().optional(),
    risk_free_rate: z.number().min(0).max(1).nullable().optional(),
    time_to_exit_years: z.number().min(0).max(50).nullable().optional(),
    valuation_date: DateStr.nullable().optional(),
    cash: nonNeg.nullable().optional(),
    debt: nonNeg.nullable().optional(),

    // OPM backsolve — the last priced round.
    last_round_post_money: nonNeg.nullable().optional(),
    last_round_price_per_share: nonNeg.nullable().optional(),
    last_round_class: ClassName.nullable().optional(),

    // Asset approach.
    asset: z
      .object({
        total_assets: nonNeg.nullable().optional(),
        total_liabilities: nonNeg.nullable().optional(),
        cost_to_replicate: nonNeg.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // Income / DCF approach. `revenues` is stored alongside FCF for the record
    // (the report cites it); only free_cash_flows drives income_dcf().
    income: z
      .object({
        free_cash_flows: z.array(z.number()).max(30).nullable().optional(),
        revenues: z.array(nonNeg).max(30).nullable().optional(),
        discount_rate: z.number().positive().max(1).nullable().optional(),
        terminal_growth: z.number().min(0).max(1).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // Market / comparable-company multiples.
    market: z
      .object({
        metric: pos.nullable().optional(),
        multiples: z.array(pos).max(50).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // Hybrid method weights (compute.py `allocation_method == 'hybrid'`,
    // hybrid.py). The OPM weight covers the far-term continuation outcome, the
    // PWERM weight the modelled near-term liquidity scenarios; they must sum to
    // 1 (validated in the engine). Absent → the engine defaults to 50/50.
    hybrid: z
      .object({
        opm_weight: z.number().min(0).max(1).nullable().optional(),
        pwerm_weight: z.number().min(0).max(1).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // PWERM discrete exit scenarios (compute.py `allocation_method == 'pwerm'`,
    // pwerm.py). Each scenario carries a probability, an exit value (equity or
    // enterprise), a time to exit and an optional per-scenario discount rate.
    pwerm: z
      .object({
        discount_rate: z.number().min(-0.99).max(1).nullable().optional(),
        scenarios: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(120).nullable().optional(),
                type: z
                  .enum([
                    'ipo',
                    'acquisition',
                    'merger',
                    'continuation',
                    'stay_private',
                    'liquidation',
                    'dissolution',
                  ])
                  .nullable()
                  .optional(),
                probability: z.number().min(0).max(1),
                equity_value: nonNeg.nullable().optional(),
                enterprise_value: z.number().nullable().optional(),
                time_to_exit_years: z.number().min(0).max(50).default(0),
                discount_rate: z.number().min(-0.99).max(1).nullable().optional(),
              })
              .strict()
              .refine((s) => s.equity_value != null || s.enterprise_value != null, {
                message: 'Each scenario needs an equity_value or enterprise_value.',
              }),
          )
          .min(1)
          .max(50)
          .nullable()
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const classes = val.share_classes;
    if (classes && classes.length > 0) {
      if (!classes.some((c) => c.kind === 'common')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['share_classes'],
          message: 'The cap table must include at least one common class.',
        });
      }
      const names = classes.map((c) => c.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['share_classes'],
          message: `Duplicate share class name: ${dupes[0]}`,
        });
      }
      if (val.last_round_class && !names.includes(val.last_round_class)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['last_round_class'],
          message: 'last_round_class must match one of the share class names.',
        });
      }
    }
    const dr = val.income?.discount_rate;
    const tg = val.income?.terminal_growth;
    if (dr != null && tg != null && dr <= tg) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['income', 'discount_rate'],
        message: 'Discount rate must exceed terminal growth.',
      });
    }
  });

export type EngineInputsPatch = z.infer<typeof EngineInputsBody>;

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

export function registerEngineInputsRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
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

  // Read the current financial model (the raw engine_inputs document).
  app.get('/api/v1/valuations/:id/engine-inputs', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const params = await findParams(deps.pool, id);
    if (!params) throw problems.notFound();
    return { engine_inputs: params.engine_inputs ?? {} };
  });

  // Hand-enter / edit the financial model. Ops-only, mirroring the params and
  // calculation routes (methodology + inputs are analyst work).
  app.patch('/api/v1/valuations/:id/engine-inputs', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Financial model inputs are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const current = await findParams(deps.pool, id);
    if (!current) throw problems.notFound();

    const parsed = EngineInputsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw problems.unprocessable('Invalid financial model inputs', {
        errors: parsed.error.issues,
      });
    }

    const updated = await applyEngineInputs(
      deps.pool,
      id,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
    );
    return { params: updated };
  });
}
