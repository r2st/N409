import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams, type ValuationParamsRow } from '../repos/params.js';
import { latestSucceededJob } from '../repos/aiJobs.js';
import { listComparableItems } from '../repos/comparableItems.js';
import { marketMultiples } from '../domain/comparables.js';
import {
  createCalculation,
  findCalculationWithTrace,
  latestApproachBaseline,
  listCalculations,
  type CalculationRow,
  type CalculationStep,
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
import { RECALC_APPROACHES } from '../domain/approaches.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

/**
 * UI approach names → engine approach keys (per-subsystem recalculate).
 * Defined in `domain/approaches.ts`; re-exported here because this route was
 * where it lived and callers still import it from here.
 */
export { RECALC_APPROACHES, type RecalcApproach } from '../domain/approaches.js';

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
  /**
   * Ordered pipeline steps for the inspector. Absent from an engine older than
   * the `trace` request flag, which is why nothing here requires it.
   */
  trace?: CalculationStep[];
}

/**
 * Check that the engine actually answered with a calculation, and say so when
 * it did not.
 *
 * `postJson<EngineComputeResponse>` is a *cast*. It proves the body was JSON
 * and nothing else, and every reader downstream — here, and both scenario call
 * sites — then walks `response.results.equity_value` as though the shape were
 * established. It is not, and the two ways it can be wrong fail in opposite
 * and equally bad directions.
 *
 * A body with no `results` at all raises a `TypeError` at the first property
 * read. That is not an `InternalServiceError`, so `runCalculation`'s catch
 * declines to record a `failed` calculation and the error escapes as a bare
 * 500 with no detail: the run leaves *no row of any kind*, so nothing in the
 * calculations history says it was ever attempted, and the analyst is told
 * "Internal Server Error" about a valuation whose inputs are all fine. An
 * absent `engine_version` fails the same way one line later, on the column's
 * NOT NULL.
 *
 * A body that has `results` but not the two concluded figures is worse,
 * because it succeeds. `createCalculation` coerces the missing numbers to
 * `null` (`args.equityValue ?? null`) and writes `status: 'succeeded'`, so the
 * valuation acquires a latest-good calculation that concludes nothing. The QA
 * review then *passes* it: the two output-sanity rules are written
 * `if (equity !== null && ...)`, so a null figure does not fail the check — it
 * deletes it, and the review comes back `pass` with the two rules that would
 * have objected simply absent from the list. That is the vacuous-guard shape,
 * and the publish gate reads that review.
 *
 * So the shape is asserted once, here, at the boundary where the bytes stop
 * being the engine's and start being ours. The failure is raised as an
 * `InternalServiceError` — the type every caller of this module already
 * handles — carrying status 200, deliberately: the engine answered, so this is
 * not an outage, must not count toward the breaker as one (`classifyStatus`
 * calls a 2xx permanent), and must not be retried, because a body of the wrong
 * shape will be the wrong shape again. The precedent is `postJsonOnce`'s own
 * 'invalid JSON in response body', which is the same failure caught one layer
 * earlier and reported exactly this way.
 */
export function parseComputeResponse(body: unknown): EngineComputeResponse {
  const fail = (detail: string): never => {
    throw new InternalServiceError('engine', 200, `response is not a calculation result — ${detail}`);
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(`expected an object, got ${Array.isArray(body) ? 'an array' : typeof body}`);
  }
  const doc = body as Record<string, unknown>;
  if (typeof doc.engine_version !== 'string' || doc.engine_version === '') {
    fail('engine_version is missing');
  }
  const results = doc.results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    fail('results is missing');
  }
  // Finite, not merely present: a null, a string, or the NaN/Infinity the
  // engine's own `_assert_finite_results` exists to stop are each a figure
  // that cannot be a concluded value, and `numeric` would take two of the
  // three without complaint.
  for (const key of ['equity_value', 'fmv_per_share'] as const) {
    const value = (results as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`results.${key} is ${value === undefined ? 'missing' : `not a finite number (${String(value)})`}`);
    }
  }
  return doc as unknown as EngineComputeResponse;
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
    // How the DLOC is derived, and the configuration each method reads. Null
    // method means `dloc` above is applied as a stated figure — the behaviour
    // of every valuation stored before migration 0132, and the one a rerun of
    // one of those must reproduce exactly.
    dloc_method: p.dloc_method,
    control_premium: num(p.control_premium),
    dloc_synergy_share: num(p.dloc_synergy_share),
    dloc_studies: p.dloc_studies,
    dloc_statistic: p.dloc_statistic,
    dloc_study_table: p.dloc_study_table,
    dlom: num(p.dlom),
    dlom_method: p.dlom_method,
    // A weighted blend, when one was configured. Null and `dlom_method` set is
    // the single-method case; the engine refuses both at once, as do the route
    // and the table, because two answers to "which discount was concluded" is
    // the one state with no safe reading.
    dlom_methods: p.dlom_methods,
    dlom_qualitative: num(p.dlom_qualitative),
    // Only meaningful for dlom_method = 'restricted_stock'; the engine ignores
    // them otherwise. Passed unconditionally so switching the method does not
    // also need a params round-trip to carry its configuration across.
    dlom_studies: p.dlom_studies,
    dlom_statistic: p.dlom_statistic,
    dlom_study_table: p.dlom_study_table,
    // The same, for the other empirical family. `dlom_statistic` above is
    // shared by both — how the rows combine is the same question either way.
    dlom_pre_ipo_studies: p.dlom_pre_ipo_studies,
    dlom_pre_ipo_table: p.dlom_pre_ipo_table,
    market_method: p.market_method,
    market_horizon: p.market_horizon,
    revenue_status: p.revenue_status,
    exit_timeline: p.exit_timeline,
    asset_method: p.asset_method,
    allocation_method: p.allocation_method ?? 'opm',
  };
}

/** Deep-merges b over a (plain objects only — arrays/scalars replace). */
export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
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
  // The extraction job and the screened peer set live in different tables and
  // neither is derived from the other, so they are fetched together. The
  // *comparables* job below stays behind the peer set on purpose — it is the
  // fallback for an unscreened engagement, and fetching it eagerly would query
  // for an answer most engagements throw away.
  const [extractJob, peers] = await Promise.all([
    latestSucceededJob(pool, valuationId, 'extract'),
    listComparableItems(pool, valuationId),
  ]);
  const extracted = extractJob?.result?.engine_inputs;
  if (extracted && typeof extracted === 'object') {
    inputs = deepMerge(inputs, extracted as Record<string, unknown>);
  }
  const applied = paramsRow.engine_inputs;
  if (applied && typeof applied === 'object' && !Array.isArray(applied)) {
    inputs = deepMerge(inputs, applied as Record<string, unknown>);
  }
  // The persisted peer set (design §4.5) outranks the AI aggregate when it has
  // rows: it is the set an analyst screened and signed off on, row by row, with
  // the exclusions recorded. The AI job's summarised multiples stay the fallback
  // for every engagement nobody has screened, which is the behaviour that
  // existed before `comparable_items` did — a new empty table must not change
  // what an untouched valuation computes.
  const peerMultiples = marketMultiples(peers, paramsRow.market_method, paramsRow.market_horizon);
  if (peerMultiples.length > 0) {
    inputs = deepMerge(inputs, { market: { multiples: peerMultiples } });
  } else {
    const compsJob = await latestSucceededJob(pool, valuationId, 'comparables');
    const comps = compsJob?.result?.comparables;
    if (Array.isArray(comps)) {
      const key = paramsRow.market_method === 'ebitda' ? 'ebitda_multiple' : 'revenue_multiple';
      const multiples = comps
        .map((c) => (c && typeof c === 'object' ? Number((c as Record<string, unknown>)[key]) : NaN))
        .filter((m) => Number.isFinite(m) && m > 0);
      if (multiples.length > 0) inputs = deepMerge(inputs, { market: { multiples } });
    }
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
    /**
     * The run `priorApproaches` was read from. Carried all the way to the
     * INSERT, which refuses the row if a different run has become the baseline
     * in the meantime — see `createCalculation`'s `expectedBaselineId`.
     */
    baselineId?: string;
    createdBy: string;
    actor: EventActor;
  },
): Promise<CalculationRow> {
  /*
   * The CAPM/WACC build-up (migration 0135).
   *
   * `engine/wacc.py` and the `auto_wacc` branch of `compute.py` have been
   * complete since they were written, and nothing here ever set the flag — so
   * `results.auto.wacc` was never populated and Appendix I, which reads it and
   * is named in the report's index of exhibits, could not render on any
   * engagement on the platform.
   *
   * Sent only when the analyst has both entered a build-up and switched it on.
   * The two conditions are separate on purpose: a build-up recorded but not
   * adopted must not move a discount rate somebody has already reviewed. The
   * engine's own rule is the other half — a hand-entered
   * `income.discount_rate` still wins, and the build-up is recorded beside it
   * so Appendix I can print the derived figure against the applied one.
   */
  const waccInputs = args.paramsRow.wacc_inputs;
  const autoWacc =
    args.paramsRow.auto_wacc === true &&
    waccInputs !== null &&
    typeof waccInputs === 'object' &&
    !Array.isArray(waccInputs) &&
    Object.keys(waccInputs).length > 0;

  const payload = {
    params: engineParams(args.paramsRow),
    inputs: autoWacc ? { ...args.inputs, wacc: waccInputs } : args.inputs,
    ...(autoWacc ? { auto_wacc: true } : {}),
    ...(args.recompute ? { recompute: args.recompute, prior_approaches: args.priorApproaches } : {}),
    // Every run, not on request. The run worth inspecting is always one that
    // already happened, so a trace you have to ask for in advance is one you
    // never have when it matters. It costs the engine a few dict copies and
    // costs the row a few kilobytes; the column is read by one endpoint and
    // selected by nothing else (`CALCULATION_COLUMNS`).
    trace: true,
  };
  try {
    const response = parseComputeResponse(
      await postJson<unknown>('engine', `${deps.engineUrl}/engine/v1/compute`, payload, {
        timeoutMs: 30_000,
        record: { valuationId: args.valuation.id, name: 'engine compute' },
      }),
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
        trace: response.trace ?? null,
        createdBy: args.createdBy,
        // Only a recalculation quotes a baseline; a full run computes every
        // approach from the inputs as they stand and has nothing to go stale.
        ...(args.recompute ? { expectedBaselineId: args.baselineId ?? null } : {}),
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

  /**
   * The valuation and its methodology params, together. Both are keyed on the
   * same id and neither is derived from the other, so the compute and validate
   * routes fetch them in one wave rather than two. The id is checked first —
   * a malformed one must be a 404 rather than a query.
   */
  const loadValuationAndParams = async (id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const [valuation, paramsRow] = await Promise.all([
      findValuationById(deps.pool, id),
      findParams(deps.pool, id),
    ]);
    if (!valuation) throw problems.notFound();
    return { valuation, paramsRow };
  };

  app.post('/api/v1/valuations/:id/calculations', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
    const { id } = req.params as { id: string };
    const { valuation, paramsRow } = await loadValuationAndParams(id);
    // A retired engagement does not spend the firm's AI budget or engine time.
    // Placed before the body is parsed so the reason a caller gets back is the
    // state of the file rather than whatever else was wrong with the request.
    refuseIfRetired(valuation, 'accepting calculations');
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
    let baselineId: string | undefined;
    if (parsed.data.approach) {
      const { engineKey, weightKey } = RECALC_APPROACHES[parsed.data.approach];
      const weight = num(paramsRow[weightKey]);
      if (!weight || weight <= 0) {
        throw problems.unprocessable(
          `The ${parsed.data.approach} approach has zero weight — give it a weight in params first`,
        );
      }
      const baseline = await latestApproachBaseline(deps.pool, id);
      const prior = baseline?.results?.approaches;
      if (!prior || typeof prior !== 'object') {
        throw problems.unprocessable('Run a full calculation before recalculating a single approach');
      }
      recompute = [engineKey];
      priorApproaches = prior as Record<string, unknown>;
      baselineId = baseline!.id;
    }

    try {
      const calculation = await runCalculation(deps, {
        valuation,
        paramsRow,
        inputs,
        recompute,
        priorApproaches,
        baselineId,
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
  app.post('/api/v1/valuations/:id/calculations/preflight', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
    const { id } = req.params as { id: string };
    const { valuation, paramsRow } = await loadValuationAndParams(id);
    refuseIfRetired(valuation, 'accepting calculations');
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
      const baseline = await latestApproachBaseline(deps.pool, id);
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
        { timeoutMs: 15_000, record: { valuationId: id, name: 'engine validate' } },
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
  });

  app.get('/api/v1/valuations/:id/calculations', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(id);
    return listCalculations(deps.pool, id);
  });

  /**
   * The calculation step inspector (409.ai gap §1.3).
   *
   * `calculations` has always stored the two ends of a run — the exact payload
   * posted to the engine and the document it returned — and nothing of the
   * middle. Answering "why is the market approach $4M when the multiples say
   * 8x" meant reading compute.py beside the stored payload and redoing the
   * arithmetic. This serves all three: the request, the response, and the
   * engine's own account of each stage in between.
   *
   * A failed run is served too, and is the more useful case: its steps stop at
   * whichever stage raised, which names the stage without anyone reading a log.
   */
  app.get(
    '/api/v1/valuations/:id/calculations/:calculationId',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      if (!isOps(principal)) throw problems.forbidden('Calculations are operations-only');
      const { id, calculationId } = req.params as { id: string; calculationId: string };
      await loadValuation(id);
      if (!isUlid(calculationId)) throw problems.notFound();
      const calculation = await findCalculationWithTrace(deps.pool, id, calculationId);
      if (!calculation) throw problems.notFound();

      const { trace, ...rest } = calculation;
      return {
        calculation: rest,
        // The raw pair, named for what they are rather than left to be inferred
        // from `calculation.inputs`: this is the payload that went over the wire
        // to the engine and the document that came back, which is what someone
        // reproducing a run by hand needs to copy.
        request: calculation.inputs,
        response: calculation.results,
        steps: trace ?? [],
        /**
         * Distinguishes "this run recorded no steps" from "this run predates
         * the trace column" — the second is every calculation older than
         * migration 0126, and an empty step list with no explanation reads as
         * a broken inspector rather than as history.
         */
        traced: Array.isArray(trace),
      };
    },
  );
}
