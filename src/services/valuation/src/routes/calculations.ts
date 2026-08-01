import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams, type ValuationParamsRow } from '../repos/params.js';
import { latestSucceededJob } from '../repos/aiJobs.js';
import {
  createCalculation,
  latestSucceededCalculation,
  listCalculations,
  type CalculationRow,
} from '../repos/calculations.js';
import {
  InternalServiceError,
  parseIssues,
  postJson,
  toProblem,
  type UpstreamIssue,
} from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/** UI approach names → engine approach keys (per-subsystem recalculate). */
export const RECALC_APPROACHES = {
  asset: { engineKey: 'asset', weightKey: 'weight_asset' },
  opm: { engineKey: 'opm_backsolve', weightKey: 'weight_opm' },
  income: { engineKey: 'income', weightKey: 'weight_income' },
  market: { engineKey: 'market', weightKey: 'weight_market' },
} as const;
export type RecalcApproach = keyof typeof RECALC_APPROACHES;

const ComputeBody = z
  .object({
    inputs: z.record(z.unknown()).default({}),
    // When set, only this approach is recomputed; the other approaches reuse
    // the latest successful calculation and the weighting/allocation/discount
    // chain re-runs on top (409.ai's per-subsystem recompute triggers).
    approach: z.enum(['asset', 'opm', 'income', 'market']).optional(),
  })
  .default({ inputs: {} });

export interface EngineComputeResponse {
  engine_version: string;
  results: {
    equity_value: number;
    fmv_per_share: number;
    [key: string]: unknown;
  };
  /** Review warnings from the engine's pre-flight validator (non-blocking). */
  warnings?: UpstreamIssue[];
}

export interface EngineValidateResponse {
  engine_version: string;
  ok: boolean;
  errors: UpstreamIssue[];
  warnings: UpstreamIssue[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Engine payload params — numbers, not the DB's numeric-as-string. */
export function engineParams(p: ValuationParamsRow): Record<string, unknown> {
  return {
    weight_asset: num(p.weight_asset),
    weight_opm: num(p.weight_opm),
    weight_income: num(p.weight_income),
    weight_market: num(p.weight_market),
    dloc: num(p.dloc),
    dlom: num(p.dlom),
    dlom_method: p.dlom_method,
    dlom_qualitative: num(p.dlom_qualitative),
    market_method: p.market_method,
    market_horizon: p.market_horizon,
    revenue_status: p.revenue_status,
    exit_timeline: p.exit_timeline,
    asset_method: p.asset_method,
    allocation_method: p.allocation_method ?? 'opm',
  };
}

/** Deep-merges b over a (plain objects only — arrays/scalars replace). */
export function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function actorFor(principal: Principal): EventActor {
  return { actorType: 'engine', actorId: principal.id, source: 'engine-wrapper' };
}

/**
 * Assembles the engine input document for a valuation: AI-extracted engine
 * inputs, then analyst-applied inputs (extraction auto-apply), then AI
 * comparables multiples, then the caller's explicit overrides. Shared by the
 * calculation route, the auto-pipeline orchestrator, and the scenario sandbox.
 */
export async function buildCalculationInputs(
  pool: pg.Pool,
  valuationId: string,
  paramsRow: ValuationParamsRow,
  explicit: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  let inputs: Record<string, unknown> = {};
  const extractJob = await latestSucceededJob(pool, valuationId, 'extract');
  const extracted = extractJob?.result?.engine_inputs;
  if (extracted && typeof extracted === 'object') {
    inputs = deepMerge(inputs, extracted as Record<string, unknown>);
  }
  const applied = paramsRow.engine_inputs;
  if (applied && typeof applied === 'object' && !Array.isArray(applied)) {
    inputs = deepMerge(inputs, applied as Record<string, unknown>);
  }
  const compsJob = await latestSucceededJob(pool, valuationId, 'comparables');
  const comps = compsJob?.result?.comparables;
  if (Array.isArray(comps)) {
    const key = paramsRow.market_method === 'ebitda' ? 'ebitda_multiple' : 'revenue_multiple';
    const multiples = comps
      .map((c) => (c && typeof c === 'object' ? Number((c as Record<string, unknown>)[key]) : NaN))
      .filter((m) => Number.isFinite(m) && m > 0);
    if (multiples.length > 0) inputs = deepMerge(inputs, { market: { multiples } });
  }
  return deepMerge(inputs, explicit);
}

export interface CalculationDeps {
  pool: pg.Pool;
  engineUrl: string;
}

/**
 * Calls the engine and persists the run (succeeded or failed) with its full
 * input payload. On an engine rejection the failed calculation is recorded
 * and the InternalServiceError re-thrown for the caller to map.
 */
export async function runCalculation(
  deps: CalculationDeps,
  args: {
    valuation: ValuationRow;
    paramsRow: ValuationParamsRow;
    inputs: Record<string, unknown>;
    recompute?: string[];
    priorApproaches?: Record<string, unknown>;
    createdBy: string;
    actor: EventActor;
  },
): Promise<CalculationRow> {
  const payload = {
    params: engineParams(args.paramsRow),
    inputs: args.inputs,
    ...(args.recompute ? { recompute: args.recompute, prior_approaches: args.priorApproaches } : {}),
  };
  try {
    const response = await postJson<EngineComputeResponse>(
      'engine',
      `${deps.engineUrl}/engine/v1/compute`,
      payload,
      { timeoutMs: 30_000 },
    );
    return await createCalculation(
      deps.pool,
      {
        valuationId: args.valuation.id,
        engineVersion: response.engine_version,
        status: 'succeeded',
        inputs: payload,
        results: response.results,
        equityValue: response.results.equity_value,
        fmvPerShare: response.results.fmv_per_share,
        // Review warnings travel with the run: a value that computes cleanly
        // can still rest on an assumption a reviewer has to sign off on.
        diagnostics: parseIssues(response.warnings),
        createdBy: args.createdBy,
      },
      args.actor,
    );
  } catch (err) {
    if (err instanceof InternalServiceError) {
      await createCalculation(
        deps.pool,
        {
          valuationId: args.valuation.id,
          engineVersion: 'unknown',
          status: 'failed',
          inputs: payload,
          error: err.message,
          diagnostics: err.issues,
          createdBy: args.createdBy,
        },
        args.actor,
      );
    }
    throw err;
  }
}

export function registerCalculationRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadValuation = async (id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.post('/api/v1/valuations/:id/calculations', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);
    const paramsRow = await findParams(deps.pool, id);
    if (!paramsRow) throw problems.notFound();

    const parsed = ComputeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid inputs', { errors: parsed.error.issues });

    // Inputs = AI-extracted engine inputs, then analyst-applied inputs
    // (extraction auto-apply), then AI comparables multiples, then the
    // analyst's explicit overrides from the request body.
    const inputs = await buildCalculationInputs(deps.pool, id, paramsRow, parsed.data.inputs);

    // Per-approach recalc: reuse the other approaches from the latest
    // successful run so the engine only recomputes the selected subsystem.
    let recompute: string[] | undefined;
    let priorApproaches: Record<string, unknown> | undefined;
    if (parsed.data.approach) {
      const { engineKey, weightKey } = RECALC_APPROACHES[parsed.data.approach];
      const weight = num(paramsRow[weightKey]);
      if (!weight || weight <= 0) {
        throw problems.unprocessable(
          `The ${parsed.data.approach} approach has zero weight — give it a weight in params first`,
        );
      }
      const baseline = await latestSucceededCalculation(deps.pool, id);
      const prior = baseline?.results?.approaches;
      if (!prior || typeof prior !== 'object') {
        throw problems.unprocessable('Run a full calculation before recalculating a single approach');
      }
      recompute = [engineKey];
      priorApproaches = prior as Record<string, unknown>;
    }

    try {
      const calculation = await runCalculation(deps, {
        valuation,
        paramsRow,
        inputs,
        recompute,
        priorApproaches,
        createdBy: principal.id,
        actor: actorFor(principal),
      });
      return reply.status(201).send({ calculation });
    } catch (err) {
      if (err instanceof InternalServiceError) {
        req.log.warn({ err }, 'engine compute failed');
        throw toProblem(err);
      }
      throw err;
    }
  });

  /**
   * Pre-flight: what would go wrong if we computed right now. Assembles the
   * exact payload `POST /calculations` would send and asks the engine's
   * validator for *every* problem — blocking errors and review warnings —
   * each with the dotted field path that caused it. Nothing is persisted, so
   * an analyst can check their work as often as they like.
   */
  app.post(
    '/api/v1/valuations/:id/calculations/preflight',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
      const { id } = req.params as { id: string };
      await loadValuation(id);
      const paramsRow = await findParams(deps.pool, id);
      if (!paramsRow) throw problems.notFound();

      const parsed = ComputeBody.safeParse(req.body ?? {});
      if (!parsed.success) throw problems.unprocessable('Invalid inputs', { errors: parsed.error.issues });

      const inputs = await buildCalculationInputs(deps.pool, id, paramsRow, parsed.data.inputs);

      // A per-approach recalculation only needs the approach being recomputed;
      // the rest are reused, so the validator checks the prior run instead.
      let recompute: string[] | undefined;
      let priorApproaches: Record<string, unknown> | undefined;
      if (parsed.data.approach) {
        recompute = [RECALC_APPROACHES[parsed.data.approach].engineKey];
        const baseline = await latestSucceededCalculation(deps.pool, id);
        const prior = baseline?.results?.approaches;
        if (prior && typeof prior === 'object') priorApproaches = prior as Record<string, unknown>;
      }

      try {
        const response = await postJson<EngineValidateResponse>(
          'engine',
          `${deps.engineUrl}/engine/v1/validate`,
          {
            params: engineParams(paramsRow),
            inputs,
            ...(recompute ? { recompute, prior_approaches: priorApproaches ?? {} } : {}),
          },
          { timeoutMs: 15_000 },
        );
        return {
          ok: response.ok === true,
          engine_version: response.engine_version,
          errors: parseIssues(response.errors),
          warnings: parseIssues(response.warnings),
        };
      } catch (err) {
        if (err instanceof InternalServiceError) {
          req.log.warn({ err }, 'engine preflight failed');
          throw toProblem(err);
        }
        throw err;
      }
    },
  );

  app.get('/api/v1/valuations/:id/calculations', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(id);
    return { calculations: await listCalculations(deps.pool, id) };
  });
}
