import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  findProjection,
  insertProjection,
  listProjections,
  markProjectionApplied,
  type ProjectionRow,
  type ProjectionYear,
} from '../repos/projections.js';

/**
 * The financial projection — the build behind the DCF's cash flows.
 *
 * `engine/v1/projection` has produced the unlevered FCFF stream from an
 * assumption set since it was written, and had no caller. Every income
 * approach on the platform therefore discounted a column an analyst typed into
 * the financial-model form, one figure per year, with nothing anywhere saying
 * what revenue, what margin or what capital intensity produced it. The cash
 * flows are the input a reviewer questions first, and the honest answer was
 * unavailable.
 *
 * The shape follows the volatility derivation exactly, because the problem is
 * the same one:
 *
 *   * Running and adopting are separate calls. A projection that silently
 *     overwrote the engagement's cash flows would move the concluded value of
 *     a valuation somebody may already have reviewed, on a button labelled
 *     "project". Adoption is its own POST, writes through `applyEngineInputs`
 *     — the same path the hand-entered form uses — so it lands in the audit
 *     trail as an ordinary inputs change.
 *   * The assumptions are stored with the run. A cash-flow stream with no
 *     build behind it is a typed column with extra steps, which is what this
 *     replaces.
 *
 * Reading is open to anyone who can read the engagement — "where did year
 * four's eight million come from" is a fair question from the client whose
 * report rests on it. Running and adopting are operations-only.
 */

/** Wall clock for one projection. In-process arithmetic; generous. */
const PROJECTION_TIMEOUT_MS = 15_000;

/**
 * A ratio to revenue, as a fraction.
 *
 * The upper bound is 20 rather than 1 on purpose: an early-stage company's
 * operating expense genuinely runs at several times its revenue, and refusing
 * that would refuse most of the engagements this platform values. It is still
 * a rail — 60 typed for a 60% margin is 6,000% and is caught here rather than
 * compounding quietly into a forecast.
 */
const Ratio = z.number().min(-20).max(20);

/** A per-year vector, or one rate applied to every year. */
const RateOrVector = z.union([Ratio, z.array(Ratio).min(1).max(100)]);

/** A per-year line of figures, in currency units. */
const Line = z.array(z.number().min(-1e15).max(1e15)).min(1).max(100);

/*
 * Keyed exactly as `engine/projection.py project_financials` takes them, and
 * `.strict()` so an unknown key is a 422 here rather than a TypeError from
 * `project_financials(**inputs)` at the far end. The method-specific
 * requirements — a base and a growth rate for `growth`, a revenue list for
 * `driver` — are left to the engine, which owns them and states them by field
 * name; what this refuses is the shapes and magnitudes it would accept and
 * compound.
 */
export const ProjectionRunBody = z
  .object({
    method: z.enum(['growth', 'driver']).default('growth'),
    years: z.number().int().min(1).max(100).optional(),

    // growth mode.
    base_revenue: z.number().positive().max(1e15).optional(),
    revenue_growth: RateOrVector.optional(),
    cogs_pct: RateOrVector.optional(),
    opex_pct: RateOrVector.optional(),
    da_pct: RateOrVector.optional(),
    capex_pct: RateOrVector.optional(),
    nwc_pct: RateOrVector.optional(),
    prior_nwc: z.number().min(-1e15).max(1e15).optional(),

    // driver mode.
    revenue: Line.optional(),
    cogs: Line.optional(),
    opex: Line.optional(),
    da: Line.optional(),
    capex: Line.optional(),
    nwc: Line.optional(),

    tax_rate: z.number().min(0).lt(1).optional(),

    // Terminal value. Computed for the record and never adopted — see below.
    terminal_method: z.enum(['gordon', 'exit_multiple', 'none']).optional(),
    terminal_growth: z.number().min(-0.5).max(1).optional(),
    discount_rate: z.number().gt(0).max(1).optional(),
    exit_multiple: z.number().positive().max(100).optional(),
    exit_metric: z.enum(['ebitda', 'revenue']).optional(),
  })
  .strict();

/** What `engine/v1/projection` returns. */
interface ProjectionEngineResponse {
  method?: unknown;
  years?: unknown;
  tax_rate?: unknown;
  projections?: unknown;
  free_cash_flows?: unknown;
  terminal_method?: unknown;
  terminal_value?: unknown;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function present(row: ProjectionRow) {
  return {
    id: row.id,
    method: row.method,
    years: row.years,
    tax_rate: row.tax_rate,
    inputs: row.inputs,
    projections: row.projections,
    free_cash_flows: row.free_cash_flows,
    terminal_method: row.terminal_method,
    terminal_value: row.terminal_value,
    // The figure an exit-multiple terminal value is struck on, and the one
    // adoption writes to `terminal_metric`. Derived here rather than stored,
    // so it and the per-year build can never disagree.
    terminal_ebitda: row.projections.at(-1)?.ebitda ?? null,
    terminal_revenue: row.projections.at(-1)?.revenue ?? null,
    applied_at: row.applied_at,
    created_at: row.created_at,
  };
}

/** The DCF's cash flows as the calculation would read them today. */
function appliedFlows(engineInputs: unknown): number[] | null {
  if (!engineInputs || typeof engineInputs !== 'object') return null;
  const income = (engineInputs as Record<string, unknown>).income;
  if (!income || typeof income !== 'object') return null;
  const flows = (income as Record<string, unknown>).free_cash_flows;
  if (!Array.isArray(flows)) return null;
  const out = flows.map(num);
  return out.every((n): n is number => n !== null) ? out : null;
}

/** Two streams agree when they are the same length and figure for figure equal. */
function sameFlows(a: number[] | null, b: number[]): boolean {
  if (a === null || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 1e-6);
}

export function registerProjectionRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadReadable = async (id: string, principal: Principal): Promise<ValuationRow> => {
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

  const loadOps = async (id: string, principal: Principal): Promise<ValuationRow> => {
    if (!isOps(principal)) throw problems.forbidden('Projecting the financials is operations-only');
    return loadReadable(id, principal);
  };

  const audit = async (
    valuation: ValuationRow,
    principal: Principal,
    type: string,
    payload: Record<string, unknown>,
  ) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload,
    });

  /**
   * Every projection run for this engagement, newest first, and the cash flows
   * the calculation would read today.
   *
   * The applied stream is served beside the runs rather than left for the
   * caller to fetch from the financial-model tab, because the only question
   * the panel exists to answer is whether the two agree.
   */
  app.get('/api/v1/valuations/:id/projection', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(id, principal);

    const [runs, params] = await Promise.all([
      listProjections(deps.pool, valuation.id),
      findParams(deps.pool, valuation.id),
    ]);
    const applied = appliedFlows(params?.engine_inputs);

    return {
      projections: runs.map(present),
      applied_free_cash_flows: applied,
      // Whether the stream the calculation reads is one of these runs. A
      // hand-typed column is the state this feature exists to replace, and a
      // panel that could not say which one it was looking at would not.
      applied_matches_run: runs.some((r) => sameFlows(applied, r.free_cash_flows)) ? true : false,
    };
  });

  /**
   * Build a forecast from an assumption set.
   *
   * Records the run and returns it; it does not touch the financial model. The
   * body is the assumption set rather than a stored param — which is safe here
   * and would not be for the WACC preview, because the run itself persists
   * what it was struck on, so a stored run is always reproducible from its own
   * row.
   */
  app.post(
    '/api/v1/valuations/:id/projection/run',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id } = req.params as { id: string };
      const valuation = await loadOps(id, principal);

      const parsed = ProjectionRunBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw problems.unprocessable('Invalid projection assumptions', {
          errors: parsed.error.issues,
        });
      }
      // `none` is the engine's way of asking for no terminal value, and it
      // reads it as the absence of one; sending the string through keeps the
      // stored inputs an exact record of what was asked for.
      const inputs = parsed.data as Record<string, unknown>;

      let result: ProjectionEngineResponse;
      try {
        result = await postJson<ProjectionEngineResponse>(
          'engine',
          `${deps.engineUrl}/engine/v1/projection`,
          { inputs },
          {
            timeoutMs: PROJECTION_TIMEOUT_MS,
            record: { valuationId: valuation.id, name: 'engine projection' },
          },
        );
      } catch (err) {
        if (err instanceof InternalServiceError) {
          req.log.warn({ err }, 'projection failed');
          throw toProblem(err);
        }
        throw err;
      }

      const flows = Array.isArray(result.free_cash_flows)
        ? result.free_cash_flows.map(num).filter((n): n is number => n !== null)
        : [];
      if (flows.length === 0) {
        // The engine raises on every input it cannot project, so an empty
        // stream means it answered with something this route does not
        // understand. Storing it would put a run with no cash flows in front
        // of an analyst as though it were a forecast.
        throw problems.unprocessable('The projection produced no cash flows');
      }

      const rows = Array.isArray(result.projections) ? (result.projections as ProjectionYear[]) : [];
      const terminalMethod = result.terminal_method;
      const run = await insertProjection(deps.pool, {
        valuationId: valuation.id,
        method: result.method === 'driver' ? 'driver' : 'growth',
        years: num(result.years) ?? flows.length,
        taxRate: num(result.tax_rate) ?? 0,
        inputs,
        projections: rows,
        freeCashFlows: flows,
        terminalMethod:
          terminalMethod === 'gordon' || terminalMethod === 'exit_multiple' ? terminalMethod : null,
        terminalValue: num(result.terminal_value),
        createdBy: principal.id,
      });

      await audit(valuation, principal, 'projection_run', {
        projection_id: run.id,
        method: run.method,
        years: run.years,
      });

      reply.code(201);
      return { projection: present(run) };
    },
  );

  /**
   * Adopt a run's cash flows as the engagement's forecast.
   *
   * Writes through `applyEngineInputs` — the path the hand-entered form uses —
   * so the change lands in the audit trail exactly as a typed one would, and
   * the income section is merged rather than replaced: `discount_rate`,
   * `terminal_growth` and the two methodology choices are the analyst's and
   * are not this route's to clear.
   *
   * Three fields are written. `free_cash_flows` is the forecast. `revenues` is
   * stored alongside it because the report cites it. `terminal_metric` is the
   * terminal-year EBITDA, which is the figure an exit-multiple terminal value
   * is struck on — absent it `income_dcf` falls back to the final free cash
   * flow and records the basis as `fcff`, which is a multiple whose
   * denominator nobody can check.
   *
   * The run's own `terminal_value` is deliberately *not* written. `income_dcf`
   * computes its own from `terminal_growth`/`terminal_method`; adopting the
   * engine's figure as well would put the terminal value into the valuation
   * twice.
   */
  app.post(
    '/api/v1/valuations/:id/projection/:projectionId/apply',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, projectionId } = req.params as { id: string; projectionId: string };
      const valuation = await loadOps(id, principal);
      if (!isUlid(projectionId)) throw problems.notFound();

      const run = await findProjection(deps.pool, valuation.id, projectionId);
      if (!run) throw problems.notFound();

      const params = await findParams(deps.pool, valuation.id);
      if (!params) throw problems.notFound();
      const before = appliedFlows(params.engine_inputs);

      const engineInputs = (params.engine_inputs ?? {}) as Record<string, unknown>;
      const income =
        engineInputs.income && typeof engineInputs.income === 'object'
          ? { ...(engineInputs.income as Record<string, unknown>) }
          : {};

      const revenues = run.projections.map((p) => p.revenue).filter((r) => Number.isFinite(r));
      const terminalEbitda = run.projections.at(-1)?.ebitda ?? null;

      income.free_cash_flows = run.free_cash_flows;
      if (revenues.length === run.free_cash_flows.length) income.revenues = revenues;
      if (terminalEbitda !== null) {
        income.terminal_metric = terminalEbitda;
        income.terminal_metric_basis = 'ebitda';
      }

      await applyEngineInputs(
        deps.pool,
        valuation.id,
        { income },
        { actorType: 'human', actorId: principal.id, source: 'api' },
      );

      const applied = await markProjectionApplied(deps.pool, valuation.id, projectionId, principal.id);
      await audit(valuation, principal, 'projection_applied', {
        projection_id: projectionId,
        from: before,
        to: run.free_cash_flows,
      });

      return {
        projection: present(applied ?? run),
        applied_free_cash_flows: run.free_cash_flows,
        // The engagement's figures are now stale against its inputs. Saying so
        // is the route's job; recalculating on its own would be a second,
        // unasked-for change to a valuation somebody may be mid-review on.
        recalculation_required: !sameFlows(before, run.free_cash_flows),
      };
    },
  );
}
