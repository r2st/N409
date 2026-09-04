import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { withTransaction } from '../db/pool.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { PROJECTION_TERMINAL_VALUE, requireStorableFigure } from '../domain/numericColumn.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { applyEngineInputsWithin, findParams, lockParams } from '../repos/params.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  findProjection,
  insertProjection,
  listProjections,
  PROJECTION_PAGE_LIMIT,
  markProjectionApplied,
  type ProjectionRow,
  type ProjectionYear,
} from '../repos/projections.js';
import { refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { unstorableEngineInputs } from './engineInputs.js';

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

/**
 * A finite figure, or null for anything that is not one.
 *
 * The guard used to be `Number(v)` filtered through `Number.isFinite`, and
 * `Number(null)` is `0`. So every absent figure read as a present zero, in
 * three places that each meant something different by it:
 *
 *   * `terminal_value` is null on a run struck with no terminal method — the
 *     `terminal_method: 'none'` case the body explicitly offers. It was stored
 *     as 0.00 and presented as a terminal value of zero, which is a claim
 *     about the horizon rather than the absence of one.
 *   * `num(result.years) ?? flows.length` never reached its fallback, because
 *     a null `years` produced 0 rather than null; 0 then fails the table's
 *     `years >= 1` check as a 500 instead of falling back to the stream length.
 *   * `sameNumber` compared an absent `terminal_metric` (undefined → null)
 *     against a cleared one (null → 0) and called them different, so
 *     `recalculation_required` came back true for an adoption that moved
 *     nothing.
 *
 * Only numbers and numeric strings count — `numeric` arrives from pg as a
 * string, which is the one non-number worth reading. `true`, `''` and `[]` are
 * all `Number`-coercible to a figure nobody wrote, and are absent here.
 */
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
  return adoptedIncome(engineInputs).flows;
}

/** Two streams agree when they are the same length and figure for figure equal. */
function sameFlows(a: number[] | null, b: number[]): boolean {
  if (a === null || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 1e-6);
}

/** One figure against another, either of which may be absent. */
function sameNumber(a: unknown, b: unknown): boolean {
  const x = num(a);
  const y = num(b);
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) < 1e-6;
}

/**
 * The three fields adoption writes, as the calculation would read them.
 *
 * Adoption writes `free_cash_flows`, `revenues` and `terminal_metric` (with its
 * basis), and `recalculation_required` compared only the first of them. So
 * adopting a run onto an engagement already carrying that exact cash-flow
 * column — the ordinary case, because the column was usually typed *from* the
 * run — answered "the calculation already ran on these cash flows" while
 * `terminal_metric` had just been written for the first time. That figure is
 * what an exit-multiple terminal value is struck on (`approaches.income_dcf`
 * falls back to the final free cash flow and records the basis as `fcff`
 * without it), so the concluded value had moved and the panel said it had not.
 */
interface AdoptedIncome {
  flows: number[] | null;
  revenues: number[] | null;
  terminalMetric: unknown;
  terminalMetricBasis: unknown;
}

function adoptedIncome(engineInputs: unknown): AdoptedIncome {
  const income =
    engineInputs && typeof engineInputs === 'object'
      ? (engineInputs as Record<string, unknown>).income
      : null;
  const section = income && typeof income === 'object' ? (income as Record<string, unknown>) : {};
  return {
    flows: numberList(section.free_cash_flows),
    revenues: numberList(section.revenues),
    terminalMetric: section.terminal_metric,
    terminalMetricBasis: section.terminal_metric_basis,
  };
}

function numberList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map(num);
  return out.every((n): n is number => n !== null) ? out : null;
}

/**
 * The fields adoption is about to write, checked against the schema that owns
 * the document they land in.
 *
 * Adoption writes through `applyEngineInputsWithin` — the repo call, not the
 * route — so `EngineInputsBody` never sees it. That is the same gap the
 * terminal-metric block below already names ("a value into `engine_inputs` by
 * the one path that did not check it"), and `terminal_metric` was closed one
 * field at a time. Two of the other three written fields are still outside it,
 * and the two schemas disagree about both:
 *
 *   * `revenues` is `nonNeg` in `EngineInputsBody`, and the `Line` a
 *     driver-mode run supplies its revenue on is signed — signed on purpose,
 *     because `cogs`, `capex` and `nwc` share that type and a negative capex is
 *     a disposal. So a driver run carrying a revenue year of -100 stores
 *     cleanly, adopts cleanly, and writes a revenue line the model form then
 *     refuses. Growth mode cannot produce one: `base_revenue` is positive and
 *     `_check_growth` floors the rate at -1 for exactly this reason — a rate
 *     below -100% "flips the sign of the projected revenue every year", which
 *     the engine calls "a complete, plausible-looking, entirely fictional
 *     forecast on a 200". Typing the same line by hand was the one way in.
 *   * `free_cash_flows` is `boundedSigned()` — bounded at `MAX_QUANTITY`,
 *     above which a double cannot add exactly. `Line` stops at 1e15 and
 *     `base_revenue` at 1e15, but growth mode *compounds*: `Ratio` runs to 20
 *     (a bound written for the expense ratios that share the type, where 20x
 *     revenue is ordinary), and a base of 1e9 grown at a mistyped `2` — 200% a
 *     year, for the 2% that was meant — reaches 2e23 by year 30. `_finite`
 *     passes it, because it is finite.
 *
 * Either way the run itself is fine and the adoption returns 200. What breaks
 * is the *next* save of the financial model: `FinancialModelPanel` loads the
 * whole income section into its form and posts the whole thing back, so
 * `PATCH /engine-inputs` comes back 422 on `income.revenues` or
 * `income.free_cash_flows` — an array the analyst never touched, on a form
 * with no way to correct it. The engagement's model is stuck.
 *
 * Refused at adoption instead, naming the field: the analyst is told at the
 * moment they adopt, about the run they are adopting, and the engagement's
 * document is left as it was. Only the fields this route writes are checked —
 * the section it merges into is the analyst's and may hold whatever it held.
 */
export function unstorableAdoption(written: Record<string, unknown>): string | null {
  return unstorableEngineInputs({ income: written });
}

/** Would the calculation read different figures than it did before adoption? */
function movedTheInputs(before: AdoptedIncome, after: AdoptedIncome): boolean {
  const listsAgree = (a: number[] | null, b: number[] | null) =>
    a === null || b === null ? a === b : sameFlows(a, b);
  return !(
    listsAgree(before.flows, after.flows) &&
    listsAgree(before.revenues, after.revenues) &&
    sameNumber(before.terminalMetric, after.terminalMetric) &&
    (before.terminalMetricBasis ?? null) === (after.terminalMetricBasis ?? null)
  );
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
    type: AdminEventType,
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

    const [runPage, params] = await Promise.all([
      listProjections(deps.pool, valuation.id),
      findParams(deps.pool, valuation.id),
    ]);
    const { runs, truncated } = runPage;
    const applied = appliedFlows(params?.engine_inputs);
    const matched = runs.some((r) => sameFlows(applied, r.free_cash_flows));

    return {
      projections: runs.map(present),
      // The forecast history is a page, and the adopted run can be anywhere in
      // it — adopting is a POST on any run by id.
      projections_truncated: truncated,
      projections_page_limit: PROJECTION_PAGE_LIMIT,
      applied_free_cash_flows: applied,
      /*
       * Whether the stream the calculation reads is one of these runs. A
       * hand-typed column is the state this feature exists to replace, and a
       * panel that could not say which one it was looking at would not.
       *
       * Three-valued since R304, because it was derived from a page and stated
       * as a fact. `runs.some(...)` over twenty rows answers "not one of these
       * runs" for a stream adopted from the twenty-first, and the panel draws
       * that as the disagreement it exists to surface — "the engagement is
       * discounting a stream that is not one of these runs" — about an
       * engagement where nothing is wrong. `null` is "the history is capped and
       * this cannot be answered from it", which is the honest third state.
       */
      applied_matches_run: matched ? true : truncated ? null : false,
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
  app.post('/api/v1/valuations/:id/projection/run', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadOps(id, principal);
    refuseIfRetired(valuation, 'accepting projection runs');

    const parsed = ProjectionRunBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid projection assumptions', parsed.error);
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
        req.log.warn({ err, valuationId: valuation.id }, 'projection failed');
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
    // The engagement as it stands now — see the guard on the compute in
    // `calculations.ts`. The stored run is what the DCF approach reads.
    await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting projection runs');
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
      // Checked against the column for the reason funds, debt and the
      // roll-forward all check theirs — see domain/numericColumn.ts. A Gordon
      // terminal value divides by `r - g`, so two ordinary fractions a caller
      // is allowed to send produce a quotient `numeric(20, 2)` cannot hold, and
      // the driver's 22003 is a 500 that names neither rate.
      terminalValue: requireStorableFigure(
        num(result.terminal_value),
        'Terminal value',
        PROJECTION_TERMINAL_VALUE,
      ),
      createdBy: principal.id,
    });

    await audit(valuation, principal, 'projection_run', {
      projection_id: run.id,
      method: run.method,
      years: run.years,
    });

    reply.code(201);
    return { projection: present(run) };
  });

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
      refuseIfRetired(valuation, 'applying results');
      if (!isUlid(projectionId)) throw problems.notFound();

      const run = await findProjection(deps.pool, valuation.id, projectionId);
      if (!run) throw problems.notFound();

      const revenues = run.projections.map((p) => p.revenue).filter((r) => Number.isFinite(r));
      const terminalEbitda = run.projections.at(-1)?.ebitda ?? null;
      const wroteRevenues = revenues.length === run.free_cash_flows.length;

      /*
       * A terminal-year EBITDA of zero or less is not a figure an exit multiple
       * can be struck against, and both of the other writers of this document
       * say so: `PATCH /engine-inputs` refuses to store it, and
       * `approaches.income_dcf` refuses to price against it. Adoption wrote it
       * anyway, so a loss-making forecast could put a value into `engine_inputs`
       * by the one path that did not check it — and the 422 then arrived on
       * whoever next pressed Calculate, naming a field they had not touched.
       *
       * Leaving the previous run's metric in place instead would be worse: the
       * multiple would be struck on the terminal year of a forecast this
       * engagement no longer uses, which computes cleanly and is wrong. So it is
       * cleared, and `terminal_metric` on the response says what was adopted —
       * null meaning the DCF will fall back to the final free cash flow and
       * record the basis as `fcff`, which is at least a denominator it names.
       */
      const adoptedMetric = terminalEbitda !== null && terminalEbitda > 0 ? terminalEbitda : null;

      /*
       * BOTH WRITES OR NEITHER (R404, methodology M5).
       *
       * These were two statements on the pool, each committing on its own, and
       * the second is the only writer of the column that says which forecast
       * the engagement is carrying. A failure between them leaves
       * `engine_inputs.income` holding this run's cash flows — and, where the
       * terminal-year EBITDA is not positive, holding a `terminal_metric` this
       * adoption *cleared* — while `applied_at` still names the previously
       * adopted run, or names nothing at all. The history then reports a
       * forecast the DCF is not running, which is the disagreement
       * `markProjectionApplied`'s sibling on the volatility side documents at
       * length.
       *
       * And the caller is told the adoption failed, which is not true of that
       * state: the engagement's forecast really did move, the cleared terminal
       * metric really is gone, and nothing revisits an adoption. The response
       * fields below — `adopted_terminal_metric`, `terminal_metric_warning`,
       * `recalculation_required` — are the only place any of it is ever said,
       * and a 500 carries none of them.
       *
       * The `projection_applied` admin event stays outside, with the estate's
       * other `recordAdminEvent` call sites; see `routes/volatility.ts`.
       */
      const { applied, beforeIncome, afterIncome } = await withTransaction(deps.pool, async (client) => {
        /*
         * THE SECTION THIS ADOPTION MERGES INTO, READ UNDER THE ROW LOCK
         * (R411, methodology M4).
         *
         * `applyEngineInputs` merges with jsonb `||`, which replaces a
         * top-level key wholesale, so writing `{ income: {…} }` would drop
         * every other field of the section — `discount_rate`,
         * `terminal_growth`, `terminal_multiple`, the figures an analyst
         * chose. It does not, because the adoption copies the stored section
         * forward and writes its four fields into the copy. That copy is a
         * read-modify-write, and it used to be read on the pool before the
         * transaction was even opened: `withTransaction` waits for a
         * connection, and a pool under contention is exactly the condition in
         * which a second writer exists. A `PATCH /engine-inputs` landing in
         * that gap was reverted whole, silently, by an adoption that never
         * mentions a discount rate — and the DCF then concluded on a rate
         * nobody had chosen.
         *
         * `lockParams` is `findParams` under the same `FOR UPDATE`
         * `patchParamsWithin` takes, inside the transaction that writes. A
         * concurrent editor either committed before this read or waits behind
         * it. The refusals below move in with it, which is where they belong —
         * both are about the document as it will actually be written, and a
         * rolled-back transaction leaves the forecast exactly as the messages
         * promise.
         */
        const params = await lockParams(client, valuation.id);
        if (!params) throw problems.notFound();
        const beforeIncome = adoptedIncome(params.engine_inputs);

        const engineInputs = (params.engine_inputs ?? {}) as Record<string, unknown>;
        const income =
          engineInputs.income && typeof engineInputs.income === 'object'
            ? { ...(engineInputs.income as Record<string, unknown>) }
            : {};
        income.free_cash_flows = run.free_cash_flows;
        if (wroteRevenues) income.revenues = revenues;
        income.terminal_metric = adoptedMetric;
        income.terminal_metric_basis = adoptedMetric === null ? null : 'ebitda';

        /*
         * The four fields just written, against the schema that owns the
         * document — see `unstorableAdoption`. Checked after `terminal_metric`
         * has been settled above, so the one field this route already guards is
         * guarded once and the other three are guarded at all.
         */
        const unstorable = unstorableAdoption({
          free_cash_flows: income.free_cash_flows,
          // Only when this adoption set it. A revenue line the *analyst* left in
          // the section is not this route's to refuse a run over.
          ...(wroteRevenues ? { revenues: income.revenues } : {}),
          terminal_metric: income.terminal_metric,
          terminal_metric_basis: income.terminal_metric_basis,
        });
        if (unstorable) {
          throw problems.unprocessable(
            `This run cannot be adopted: ${unstorable}. The engagement's forecast is unchanged.`,
          );
        }

        await applyEngineInputsWithin(
          client,
          valuation.id,
          { income },
          { actorType: 'human', actorId: principal.id, source: 'api' },
        );
        return {
          applied: await markProjectionApplied(client, valuation.id, projectionId, principal.id),
          beforeIncome,
          afterIncome: adoptedIncome({ income }),
        };
      });
      const before = beforeIncome.flows;
      await audit(valuation, principal, 'projection_applied', {
        projection_id: projectionId,
        from: before,
        to: run.free_cash_flows,
      });

      return {
        projection: present(applied ?? run),
        applied_free_cash_flows: run.free_cash_flows,
        // What an exit-multiple terminal value will now be struck on, and null
        // when this forecast offers nothing to strike one against. Reported
        // rather than left for the caller to infer, because the alternative is
        // discovering it on the next Calculate.
        adopted_terminal_metric: adoptedMetric,
        terminal_metric_warning:
          adoptedMetric === null && terminalEbitda !== null
            ? `The terminal year's EBITDA is ${terminalEbitda}, which an exit multiple cannot be struck against. ` +
              `Any previously adopted terminal metric has been cleared; a Gordon terminal value is the method this forecast supports.`
            : null,
        // The engagement's figures are now stale against its inputs. Saying so
        // is the route's job; recalculating on its own would be a second,
        // unasked-for change to a valuation somebody may be mid-review on.
        //
        // Every field adoption wrote is compared, not just the cash flows —
        // see `movedTheInputs`. A run whose terminal-year EBITDA differs from
        // what the engagement carried moves the exit-multiple terminal value,
        // and so the concluded value, with the cash-flow column untouched.
        recalculation_required: movedTheInputs(beforeIncome, afterIncome),
      };
    },
  );
}
