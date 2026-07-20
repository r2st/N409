import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { asc718Portfolio, type Asc718Grant } from '../domain/asc718.js';
import { findValuationById } from '../repos/valuations.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * ASC 718 stock-based-compensation expense (domain/asc718.ts). Dual-use with
 * the 409A engagement: the concluded common FMV is the grant-date underlying
 * price, from which we measure each option grant's grant-date fair value and
 * its straight-line amortization over the vesting period. Ops only; stateless
 * (computed on demand, like the sensitivity endpoints).
 */

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const GrantBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  options_granted: z.number().positive().max(1e12),
  grant_date: DateStr,
  vesting_months: z.number().int().min(1).max(600),
  exercise_price: z.number().positive().max(1e9),
  expected_term_years: z.number().gt(0).max(30),
  volatility: z.number().gt(0).max(5),
  risk_free_rate: z.number().min(0).max(0.25),
  dividend_yield: z.number().min(0).max(0.25).optional(),
  forfeiture_rate: z.number().min(0).max(1).optional(),
  amortization_frequency_months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).optional(),
  /** Underlying common FMV at grant; defaults to the valuation's 409A FMV. */
  grant_date_fair_value: z.number().positive().max(1e9).optional(),
});

const Body = z.object({
  grants: z.array(GrantBody).min(1).max(100),
  /** Fallback grant-date FMV when a grant omits its own and no calc exists. */
  default_grant_date_fair_value: z.number().positive().max(1e9).optional(),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('ASC 718 is operations-only');
}

export function registerAsc718Routes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.post('/api/v1/valuations/:id/asc718', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid ASC 718 request', { errors: parsed.error.issues });
    const b = parsed.data;

    // The concluded 409A FMV per share is the default grant-date underlying.
    const calculation = await latestSucceededCalculation(deps.pool, id);
    const fmv = calculation?.fmv_per_share != null ? Number(calculation.fmv_per_share) : null;
    const defaultFmv = b.default_grant_date_fair_value ?? (fmv != null && fmv > 0 ? fmv : undefined);

    const grants: Asc718Grant[] = [];
    for (const g of b.grants) {
      const underlying = g.grant_date_fair_value ?? defaultFmv;
      if (underlying === undefined) {
        throw problems.unprocessable(
          'No grant-date fair value: run a calculation first or supply grant_date_fair_value',
        );
      }
      grants.push({
        label: g.label,
        optionsGranted: g.options_granted,
        grantDate: g.grant_date,
        vestingMonths: g.vesting_months,
        forfeitureRate: g.forfeiture_rate,
        amortizationFrequencyMonths: g.amortization_frequency_months,
        assumptions: {
          grantDateFairValue: underlying,
          exercisePrice: g.exercise_price,
          expectedTermYears: g.expected_term_years,
          volatility: g.volatility,
          riskFreeRate: g.risk_free_rate,
          dividendYield: g.dividend_yield,
        },
      });
    }

    const portfolio = asc718Portfolio(grants);
    return {
      asc718: {
        ...portfolio,
        // Dual-use output: surface the 409A FMV alongside the ASC 718 expense.
        valuation_fmv_per_share: fmv,
        currency: valuation.currency,
      },
    };
  });
}
