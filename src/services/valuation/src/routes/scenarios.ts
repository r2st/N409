import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation, type CalculationRow } from '../repos/calculations.js';
import {
  countScenarios,
  createScenario,
  deleteScenario,
  findScenarioById,
  listScenarios,
  SCENARIO_LABELS,
} from '../repos/scenarios.js';
import { deepMerge, type EngineComputeResponse } from './calculations.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/**
 * Improvement 3 — client-facing what-if scenario sandbox. Clients clone the
 * inputs of the latest official calculation, adjust the headline assumptions
 * (revenue, growth, discount rate, multiples), and see the value move — the
 * engine computes fresh but NOTHING is persisted: no calculation row, no
 * event, no change to the valuation. Strictly read-only.
 */

const PreviewBody = z.object({
  revenue: z.number().positive().max(1e15).optional(),
  growth_rate: z.number().min(-0.5).max(2).optional(),
  discount_rate: z.number().gt(0).max(1).optional(),
  multiples: z.array(z.number().gt(0).max(1000)).min(1).max(20).optional(),
  volatility: z.number().gt(0).max(5).optional(),
});
export type ScenarioInputs = z.infer<typeof PreviewBody>;

/** IMPROVEMENTS_RESEARCH §5.7 — saved bull/base/bear/custom cases. */
export const MAX_SCENARIOS = 12;

const SaveBody = PreviewBody.extend({
  name: z.string().trim().min(1).max(100),
  label: z.enum(SCENARIO_LABELS).default('custom'),
});

interface EnginePayload {
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

/** The stored payload of the baseline run, stripped of partial-recalc bits. */
function basePayload(calc: CalculationRow): EnginePayload {
  const stored = (calc.inputs ?? {}) as Record<string, unknown>;
  return {
    params: (stored.params ?? {}) as Record<string, unknown>,
    inputs: (stored.inputs ?? {}) as Record<string, unknown>,
  };
}

/** Maps the sandbox's named knobs onto engine input paths. */
export function scenarioOverrides(body: ScenarioInputs): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const income: Record<string, unknown> = {};
  const market: Record<string, unknown> = {};
  if (body.discount_rate !== undefined) income.discount_rate = body.discount_rate;
  if (body.growth_rate !== undefined) income.terminal_growth = body.growth_rate;
  if (body.revenue !== undefined) market.metric = body.revenue;
  if (body.multiples !== undefined) market.multiples = body.multiples;
  if (body.volatility !== undefined) overrides.volatility = body.volatility;
  if (Object.keys(income).length > 0) overrides.income = income;
  if (Object.keys(market).length > 0) overrides.market = market;
  return overrides;
}

/** The current values of the adjustable knobs, for initializing the UI. */
export function scenarioDefaults(payload: EnginePayload): Record<string, unknown> {
  const inputs = payload.inputs;
  const income = (inputs.income ?? {}) as Record<string, unknown>;
  const market = (inputs.market ?? {}) as Record<string, unknown>;
  return {
    revenue: market.metric ?? null,
    growth_rate: income.terminal_growth ?? null,
    discount_rate: income.discount_rate ?? null,
    multiples: Array.isArray(market.multiples) ? market.multiples : null,
    volatility: inputs.volatility ?? null,
  };
}

function activeApproaches(params: Record<string, unknown>): Record<string, boolean> {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
  return {
    asset: num(params.weight_asset) > 0,
    opm_backsolve: num(params.weight_opm) > 0,
    income: num(params.weight_income) > 0,
    market: num(params.weight_market) > 0,
  };
}

export function registerScenarioRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadValuation = async (principal: Principal, id: string): Promise<ValuationRow> => {
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

  const baselineOf = (calc: CalculationRow) => ({
    calculation_id: calc.id,
    created_at: calc.created_at,
    equity_value: calc.equity_value != null ? Number(calc.equity_value) : null,
    fmv_per_share: calc.fmv_per_share != null ? Number(calc.fmv_per_share) : null,
  });

  // Sandbox bootstrap: the baseline numbers + the current knob values.
  app.get('/api/v1/valuations/:id/scenarios/baseline', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    const calc = await latestSucceededCalculation(deps.pool, valuation.id);
    if (!calc) return { baseline: null, defaults: null, approaches: null, currency: valuation.currency };
    const payload = basePayload(calc);
    return {
      baseline: baselineOf(calc),
      defaults: scenarioDefaults(payload),
      approaches: activeApproaches(payload.params),
      currency: valuation.currency,
    };
  });

  app.post('/api/v1/valuations/:id/scenarios/preview', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);

    const parsed = PreviewBody.safeParse(req.body ?? {});
    if (!parsed.success)
      throw problems.unprocessable('Invalid scenario inputs', { errors: parsed.error.issues });

    const calc = await latestSucceededCalculation(deps.pool, valuation.id);
    if (!calc) {
      throw problems.unprocessable(
        'No completed calculation to sandbox yet — check back once the valuation is drafted',
      );
    }

    const base = basePayload(calc);
    const payload: EnginePayload = {
      params: base.params,
      inputs: deepMerge(base.inputs, scenarioOverrides(parsed.data)),
    };
    try {
      const response = await postJson<EngineComputeResponse>(
        'engine',
        `${deps.engineUrl}/engine/v1/compute`,
        payload,
        { timeoutMs: 30_000 },
      );
      const baseline = baselineOf(calc);
      const equity = response.results.equity_value;
      const fmv = response.results.fmv_per_share;
      return {
        scenario: {
          equity_value: equity,
          fmv_per_share: fmv,
          approaches: response.results.approaches ?? null,
        },
        baseline,
        delta: {
          equity_value: baseline.equity_value != null ? equity - baseline.equity_value : null,
          fmv_per_share: baseline.fmv_per_share != null ? fmv - baseline.fmv_per_share : null,
        },
        currency: valuation.currency,
      };
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  });

  // ── Saved scenarios (IMPROVEMENTS_RESEARCH §5.7) ───────────────────────────

  const actorFor = (principal: Principal): EventActor => ({
    actorType: 'human',
    actorId: principal.id,
    source: 'scenarios',
  });

  // Save the current knobs as a named case, computed against the latest
  // official calculation and persisted with its results for comparison.
  app.post('/api/v1/valuations/:id/scenarios', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);

    const parsed = SaveBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid scenario', { errors: parsed.error.issues });
    const { name, label, ...knobs } = parsed.data;

    if ((await countScenarios(deps.pool, valuation.id)) >= MAX_SCENARIOS) {
      throw problems.unprocessable(
        `A valuation holds at most ${MAX_SCENARIOS} saved scenarios — delete one first`,
      );
    }
    const calc = await latestSucceededCalculation(deps.pool, valuation.id);
    if (!calc) {
      throw problems.unprocessable('No completed calculation to build scenarios from yet');
    }

    const base = basePayload(calc);
    const payload: EnginePayload = {
      params: base.params,
      inputs: deepMerge(base.inputs, scenarioOverrides(knobs)),
    };
    try {
      const response = await postJson<EngineComputeResponse>(
        'engine',
        `${deps.engineUrl}/engine/v1/compute`,
        payload,
        { timeoutMs: 30_000 },
      );
      const scenario = await createScenario(
        deps.pool,
        {
          valuationId: valuation.id,
          name,
          label,
          inputs: knobs,
          baselineCalculationId: calc.id,
          equityValue: response.results.equity_value,
          fmvPerShare: response.results.fmv_per_share,
          results: { approaches: response.results.approaches ?? null },
          createdBy: principal.id,
        },
        actorFor(principal),
      );
      return reply.status(201).send({ scenario });
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  });

  // Side-by-side comparison payload: saved cases + the current baseline.
  app.get('/api/v1/valuations/:id/scenarios', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    const [scenarios, calc] = await Promise.all([
      listScenarios(deps.pool, valuation.id),
      latestSucceededCalculation(deps.pool, valuation.id),
    ]);
    return {
      scenarios,
      baseline: calc ? baselineOf(calc) : null,
      currency: valuation.currency,
      max_scenarios: MAX_SCENARIOS,
    };
  });

  app.delete(
    '/api/v1/valuations/:id/scenarios/:scenarioId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, scenarioId } = req.params as { id: string; scenarioId: string };
      const valuation = await loadValuation(principal, id);
      if (!isUlid(scenarioId)) throw problems.notFound();
      const scenario = await findScenarioById(deps.pool, scenarioId);
      if (!scenario || scenario.valuation_id !== valuation.id) throw problems.notFound();
      // Ops can prune anything; everyone else only what they saved.
      if (!isOps(principal) && scenario.created_by !== principal.id) throw problems.forbidden();
      await deleteScenario(deps.pool, scenario, actorFor(principal));
      return reply.status(204).send();
    },
  );
}
