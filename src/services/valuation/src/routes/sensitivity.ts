import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { sensitivityGrid, sensitivityTables } from '../domain/sensitivity.js';
import { findValuationById } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Sensitivity dashboard (M4, P1 #19). Computes the OPM volatility × term
 * stress table for a valuation from analyst-supplied assumptions, defaulting
 * DLOM from the stored valuation params. Analyst tooling — ops only.
 */

const Body = z.object({
  equity_value_cents: z.number().int().positive().max(1e15),
  strike_cents: z.number().int().min(0).max(1e15),
  volatility: z.number().gt(0).max(5),
  term_years: z.number().gt(0).max(30),
  risk_free_rate: z.number().min(0).max(0.25),
  common_shares: z.number().int().positive().max(1e12),
  dlom: z.number().min(0).max(0.95).optional(),
  volatility_steps: z.array(z.number().min(-0.9).max(2)).min(1).max(9).optional(),
  term_steps: z.array(z.number().min(-20).max(20)).min(1).max(9).optional(),
  rfr_steps: z.array(z.number().min(-0.25).max(0.25)).min(1).max(9).optional(),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Sensitivity analysis is operations-only');
}

export function registerSensitivityRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.post('/api/v1/valuations/:id/sensitivity', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid assumptions', { errors: parsed.error.issues });
    const b = parsed.data;

    let dlom = b.dlom;
    if (dlom === undefined) {
      const { rows } = await deps.pool.query<{ dlom: string | null }>(
        'SELECT dlom FROM valuation_params WHERE valuation_id = $1',
        [id],
      );
      dlom = rows[0]?.dlom != null ? Number(rows[0].dlom) : 0;
    }

    const inputs = {
      equityValueCents: b.equity_value_cents,
      strikeCents: b.strike_cents,
      volatility: b.volatility,
      termYears: b.term_years,
      riskFreeRate: b.risk_free_rate,
      commonShares: b.common_shares,
      dlom,
    };
    const grid = sensitivityGrid(inputs, {
      volatilitySteps: b.volatility_steps,
      termSteps: b.term_steps,
    });
    // The three-table dashboard (Term×Vol, RFR×Vol, RFR×Term) rides along
    // with the classic grid so existing consumers keep working.
    const { tables, base } = sensitivityTables(inputs, {
      volatilitySteps: b.volatility_steps,
      termSteps: b.term_steps,
      rfrSteps: b.rfr_steps,
    });
    return {
      sensitivity: { ...grid, base, tables, dlom, currency: valuation.currency },
    };
  });
}
