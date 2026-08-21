import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { sensitivityGrid, sensitivityTables } from '../domain/sensitivity.js';
import { findValuationById } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { buildCalculationInputs, engineParams } from './calculations.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

/** The five levers the engine sensitivity endpoint understands. */
const ENGINE_PARAMETERS = [
  'discount_rate',
  'volatility',
  'exit_multiple',
  'time_to_exit',
  'growth_rate',
] as const;

const ModelBody = z
  .object({
    parameters: z.array(z.enum(ENGINE_PARAMETERS)).max(5).optional(),
    two_way: z
      .array(z.tuple([z.enum(ENGINE_PARAMETERS), z.enum(ENGINE_PARAMETERS)]))
      .max(10)
      .optional(),
    span: z.number().gt(0).max(2).optional(),
    steps: z.number().int().min(2).max(21).optional(),
    inputs: z.record(z.unknown()).default({}),
  })
  .default({ inputs: {} });

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

export function registerSensitivityRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  app.post('/api/v1/valuations/:id/sensitivity', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    refuseIfRetired(valuation, 'accepting sensitivity runs');

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

  /**
   * Full-model sensitivity (engine-wrapper app/engine/sensitivity.py): re-runs
   * the whole valuation while stressing discount_rate / volatility /
   * exit_multiple / time_to_exit / growth_rate one or two at a time, off the
   * valuation's own stored params + inputs. Ops only.
   */
  app.post('/api/v1/valuations/:id/sensitivity/model', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    refuseIfRetired(valuation, 'accepting sensitivity runs');
    const paramsRow = await findParams(deps.pool, id);
    if (!paramsRow) throw problems.notFound();

    const parsed = ModelBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid options', { errors: parsed.error.issues });
    const b = parsed.data;

    const inputs = await buildCalculationInputs(deps.pool, id, paramsRow, b.inputs);
    const payload = {
      params: engineParams(paramsRow),
      inputs,
      ...(b.parameters ? { parameters: b.parameters } : {}),
      ...(b.two_way ? { two_way: b.two_way } : {}),
      ...(b.span !== undefined ? { span: b.span } : {}),
      ...(b.steps !== undefined ? { steps: b.steps } : {}),
    };

    try {
      const result = await postJson<Record<string, unknown>>(
        'engine',
        `${deps.engineUrl}/engine/v1/sensitivity`,
        payload,
        { timeoutMs: 60_000, record: { valuationId: valuation.id, name: 'engine sensitivity' } },
      );
      return { sensitivity: { ...result, currency: valuation.currency } };
    } catch (err) {
      if (err instanceof InternalServiceError) {
        req.log.warn({ err }, 'engine sensitivity failed');
        throw toProblem(err);
      }
      throw err;
    }
  });
}
