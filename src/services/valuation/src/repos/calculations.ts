import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction, type Queryable } from '../db/pool.js';
import { lockPublishGate } from './publishLock.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { isSpecialtyKind, specialtyRunKindOf, type SpecialtyKind } from '../domain/specialty.js';
import type { ValuationKind } from '../domain/valuation.js';

export interface CalculationRow {
  id: string;
  valuation_id: string;
  engine_version: string;
  status: 'succeeded' | 'failed';
  inputs: Record<string, unknown>;
  results: Record<string, unknown> | null;
  equity_value: string | null;
  fmv_per_share: string | null;
  error: string | null;
  /** Engine pre-flight findings: blocking errors on a failed run, review
   *  warnings on a successful one. Always an array. */
  diagnostics: CalculationDiagnostic[];
  created_by: string | null;
  created_at: Date;
  /**
   * Ordered engine pipeline steps, for the inspector. Present only on the
   * by-id fetch — every other query omits the column (see
   * `CALCULATION_COLUMNS`). `null` on runs that predate migration 0126.
   */
  trace?: CalculationStep[] | null;
}

export interface CalculationDiagnostic {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  hint: string | null;
}

/**
 * One engine pipeline stage, as the engine recorded it (`engine/trace.py`).
 *
 * `status` is the field neither `inputs` nor `results` can express. An approach
 * with zero weight and an approach carried over from a previous per-approach
 * recalculation are both absent from `results.approaches` in exactly the same
 * way, and they mean opposite things: `skipped` was excluded on purpose,
 * `reused` is a number older than the inputs beside it.
 */
export interface CalculationStep {
  seq: number;
  key: string;
  label: string;
  status: 'computed' | 'reused' | 'skipped';
  inputs: unknown;
  outputs: unknown;
  note: string | null;
  elapsed_ms: number;
}

/**
 * Every column except `trace`.
 *
 * The trace is the engine's whole working state for one run — every approach's
 * inputs, the cap table, the waterfall — and it is read by exactly one endpoint.
 * Selecting it into the list view, the pipeline's baseline lookup, or the batch
 * that fetches the latest run for a page of valuations would carry all of it
 * across the wire every time, for nobody. `SELECT *` is what made that the
 * default, so the column list is written out once here instead.
 */
/** The two facts the monitoring snapshot reads off a run; see the reader below. */
export interface CalculationHead {
  fmv_per_share: string | null;
  run_kind: SpecialtyKind | null;
}

const CALCULATION_COLUMNS = `id, valuation_id, engine_version, status, inputs, results,
  equity_value, fmv_per_share, error, diagnostics, created_by, created_at`;

/**
 * The 409 a superseded per-approach recalculation is refused with.
 *
 * Refusal rather than repair, and the difference is not stylistic. The reused
 * approaches are not text that can be re-merged after the fact the way a report
 * chapter is: the run's `equity_value` and `fmv_per_share` are the *weighted*
 * combination the engine formed from all four, so grafting the newer baseline's
 * figures onto this result would mean re-deriving the conclusion here, in
 * TypeScript, from a document the engine already summed. The honest answer is
 * that this recalculation was computed against a valuation that has since
 * moved, and it takes one more press of the same button to compute it against
 * the one that stands.
 *
 * Nothing is lost by refusing: the approach being recomputed is recomputed from
 * the current inputs either way, and the run that overtook this one is already
 * in the history with its own numbers.
 */
function staleBaseline(): never {
  throw problems.conflict(
    'Another calculation landed while this recalculation was running, so its ' +
      'reused approaches are out of date. Recalculate again to compute against ' +
      'the run that now stands.',
  );
}

export async function createCalculation(
  pool: pg.Pool,
  args: {
    valuationId: string;
    engineVersion: string;
    status: 'succeeded' | 'failed';
    inputs: Record<string, unknown>;
    results?: Record<string, unknown> | null;
    equityValue?: number | null;
    fmvPerShare?: number | null;
    error?: string | null;
    diagnostics?: CalculationDiagnostic[];
    /** Engine pipeline steps; omitted on a run the engine never reached. */
    trace?: CalculationStep[] | null;
    createdBy: string;
    /**
     * The baseline row whose approaches this run *quotes* rather than computes.
     *
     * Only a per-approach recalculation passes it. That run is a read-modify-
     * write whose modify step is a thirty-second HTTP call: the route reads
     * `latestApproachBaseline`, ships its `results.approaches` to the engine as
     * `prior_approaches`, and the engine copies every approach it was not asked
     * to recompute into the new results verbatim (`_reused_prior`). So the row
     * about to be inserted states a value for all four approaches and three of
     * them are quotations of a document that may have been superseded while the
     * engine was thinking.
     *
     * Checked here, under the gate lock, rather than in the route: the failure
     * this guards *is* another run landing between the route's read and this
     * insert, so a check against the caller's own copy would be blind to the
     * only case it exists for. Same reasoning as `saveVersion`'s
     * `expectedVersion`, one table over.
     */
    expectedBaselineId?: string | null;
  },
  actor: EventActor,
): Promise<CalculationRow> {
  return withTransaction(pool, async (client) => {
    // A new calculation retires whatever QA review the publish gate is looking
    // at — the review is keyed to the calculation it examined, so landing this
    // row is what makes the gate's answer wrong. Taking the gate lock makes a
    // publish in flight either see this calculation or finish before it exists,
    // never straddle it. See repos/publishLock.ts.
    await lockPublishGate(client, args.valuationId);
    if (args.expectedBaselineId !== undefined) {
      const current = await latestSucceededCalculationWith(client, args.valuationId, 'approaches');
      if ((current?.id ?? null) !== args.expectedBaselineId) staleBaseline();
    }
    const { rows } = await client.query<CalculationRow>(
      `INSERT INTO calculations
         (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share, error, diagnostics, trace, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       RETURNING ${CALCULATION_COLUMNS}`,
      [
        newUlid(),
        args.valuationId,
        args.engineVersion,
        args.status,
        JSON.stringify(args.inputs),
        args.results ? JSON.stringify(args.results) : null,
        args.equityValue ?? null,
        args.fmvPerShare ?? null,
        args.error ?? null,
        JSON.stringify(args.diagnostics ?? []),
        // NULL, not '[]': a run the engine rejected before starting produced no
        // steps, and an empty array would claim it ran none.
        args.trace && args.trace.length > 0 ? JSON.stringify(args.trace) : null,
        args.createdBy,
      ],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: PIPELINE_EVENT_TYPES.calculationCompleted,
      actor,
      payload: {
        calculation_id: rows[0]!.id,
        status: args.status,
        engine_version: args.engineVersion,
        fmv_per_share: args.fmvPerShare ?? null,
      },
    });
    return rows[0]!;
  });
}

/**
 * The newest succeeded run whose result document carries `resultsKey`.
 *
 * One valuation's `calculations` table holds runs of two different shapes. The
 * 409A pipeline writes `results = { approaches, discounts, assumptions, ... }`;
 * a specialty engine writes `results = { kind, specialty }` (`routes/specialty.ts`).
 * Nothing stops an EMI engagement from also running the ordinary compute — the
 * Calculations tab offers the button on every kind — so the two interleave in
 * one `created_at DESC` ordering.
 *
 * That makes {@link latestSucceededCalculation} the wrong question for any
 * caller that goes on to read a *shape-specific* key: the newest row of the
 * wrong shape shadows the newest row of the right one, and the caller reports
 * the absence as a fact about the engagement. Ask for the shape you are about
 * to read instead.
 */
async function latestSucceededCalculationWith(
  db: Queryable,
  valuationId: string,
  resultsKey: 'approaches' | 'specialty',
): Promise<CalculationRow | null> {
  const { rows } = await db.query<CalculationRow>(
    // `jsonb_exists(results, $2)` rather than the `?` operator: the operator is
    // spelled the same as a placeholder in several pg tooling layers, and the
    // function form is the same index-eligible test without that hazard.
    `SELECT ${CALCULATION_COLUMNS} FROM calculations
     WHERE valuation_id = $1 AND status = 'succeeded' AND jsonb_exists(results, $2)
     ORDER BY created_at DESC LIMIT 1`,
    [valuationId, resultsKey],
  );
  return rows[0] ?? null;
}

/**
 * Baseline for per-approach recalculation: the newest run that actually carries
 * approaches to reuse. A specialty run carries none, and is not a baseline for
 * one — nor evidence that no full calculation has been run.
 */
export function latestApproachBaseline(db: Queryable, valuationId: string): Promise<CalculationRow | null> {
  return latestSucceededCalculationWith(db, valuationId, 'approaches');
}

/**
 * The newest specialty-engine run, for surfaces that render `results.specialty`.
 * Matches the predicate the specialty tab's run history already filters on.
 */
export function latestSucceededSpecialtyCalculation(
  db: Queryable,
  valuationId: string,
): Promise<CalculationRow | null> {
  return latestSucceededCalculationWith(db, valuationId, 'specialty');
}

/**
 * The newest run of the shape this engagement's *kind* is reported in.
 *
 * Three things about a valuation are fixed by its kind and not by its run
 * history: the report skeleton (`templateForKind`), the exhibit set the render
 * dispatches to, and the caption over the headline columns
 * (`headlineLabels` — `equity_value` and `fmv_per_share` are 409A columns by
 * name that every engine writes into). The newest calculation is fixed by
 * neither: the Calculations tab offers the ordinary 409A compute on every kind,
 * so on a specialty engagement both shapes interleave in one `created_at DESC`
 * ordering and the top row is whichever button was pressed last.
 *
 * Reading that top row put a §409A equity value under "Total expense", and the
 * 409A schedules A–H into a deliverable whose narrative is an EMI report. So
 * the kind picks the run, rather than the run quietly redefining the kind.
 *
 * On a 409A-family kind there is no second shape to confuse — the specialty
 * pipeline refuses every other kind — and this is the plain newest run.
 */
export function latestCalculationForKind(
  db: Queryable,
  valuationId: string,
  kind: string,
): Promise<CalculationRow | null> {
  return isSpecialtyKind(kind as ValuationKind)
    ? latestSucceededSpecialtyCalculation(db, valuationId)
    : latestSucceededCalculation(db, valuationId);
}

/** The newest successful run of any shape. */
export async function latestSucceededCalculation(
  db: Queryable,
  valuationId: string,
): Promise<CalculationRow | null> {
  const { rows } = await db.query<CalculationRow>(
    `SELECT ${CALCULATION_COLUMNS} FROM calculations
     WHERE valuation_id = $1 AND status = 'succeeded'
     ORDER BY created_at DESC LIMIT 1`,
    [valuationId],
  );
  return rows[0] ?? null;
}

/**
 * What the monitoring snapshot reads off the newest succeeded run, for a whole
 * list of valuations: the headline figure, and which engine wrote it.
 *
 * A LATERAL AND NOT A `DISTINCT ON`, for the reason `funds.latestMarks` is one
 * (R283): the two read different amounts of the table to give the same answer.
 * `DISTINCT ON` is a sort with a filter on top, and a sort cannot stop at the
 * first row of a group — so it must read *every* succeeded run of every
 * valuation on the page and order the lot to keep one row each. This makes one
 * stopping index scan per valuation against `calculations_latest_succeeded_idx`,
 * whose leading columns are exactly `(valuation_id, created_at DESC)`.
 *
 * WHICH IS THE DIFFERENCE BETWEEN A PAGE AND A HISTORY. The cost of the old
 * spelling was the *run history* of the page, not the page: an engagement
 * re-runs the engine many times a day (see `CALCULATION_PAGE_LIMIT`, which
 * exists because of it), so the rows read grew with how long the platform had
 * been running while the answer stayed one row per valuation. Measured on 200k
 * calculations, a 500-valuation page 100 runs deep: 50,000 rows read, an
 * external merge sort spilling 9.5 MB to disk, 246 ms — against 500 rows, no
 * sort, 22 ms.
 *
 * AND NARROW, BECAUSE THE DOCUMENT IS THE OTHER HALF OF THE COST.
 * `assembleSnapshot` (`routes/monitoring.ts`) touches exactly two things on this
 * row — `fmv_per_share`, and `specialtyRunKind(results)`, which itself reads
 * only `results.kind` and whether `results.specialty` is an object. Everything
 * else was fetched, detoasted, sent and parsed to be thrown away, and `results`
 * is an engine result document: approaches, discounts, assumptions, waterfall.
 * At 500 valuations with ~11 kB documents that was 5.45 MB on the wire per page,
 * 44-52 ms against 12-27 ms — before the driver parses those 5.45 MB into
 * JavaScript objects, which this measurement does not include and the scan does
 * pay.
 *
 * Both callers make the page the shape that matters. `GET /api/v1/monitors` asks
 * for a `MONITOR_PAGE_LIMIT` page; `POST /api/v1/monitors/scan` asks once per
 * page while paging the entire enabled book, so at 20k monitors that is forty
 * pages of it per scan.
 *
 * THE `specialty` PROBE IS `IN ('object', 'array')`, DELIBERATELY. The rule it
 * stands in for is `typeof specialty === 'object'` (see
 * {@link specialtyRunKindOf}), and in JavaScript an array satisfies that.
 * `jsonb_typeof` separates the two, so testing `= 'object'` alone would make
 * this reader answer `null` where the document reader answers a kind. The parity
 * test over both spellings is what keeps that honest rather than this comment.
 *
 * There is no wide batch form. A caller that needs whole runs for a list of
 * valuations should add one and say why, rather than find one lying about
 * pre-fetched for a path that reads two fields.
 */
export async function latestSucceededCalculationHeadsByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, CalculationHead>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<{
    valuation_id: string;
    fmv_per_share: string | null;
    results_kind: string | null;
    specialty_is_object: boolean | null;
  }>(
    // `unnest(...) AS v(id)` rather than `= ANY($1)`: the LATERAL needs a row
    // per requested id to correlate against, and `ANY` is a predicate rather
    // than a relation.
    `SELECT c.valuation_id,
            c.fmv_per_share,
            c.results->>'kind' AS results_kind,
            jsonb_typeof(c.results->'specialty') IN ('object', 'array') AS specialty_is_object
       FROM unnest($1::ulid[]) AS v(id)
       CROSS JOIN LATERAL (
         SELECT c.valuation_id, c.fmv_per_share, c.results
           FROM calculations c
          WHERE c.valuation_id = v.id AND c.status = 'succeeded'
          ORDER BY c.created_at DESC
          LIMIT 1
       ) c`,
    [[...new Set(valuationIds)]],
  );
  return new Map(
    rows.map((row) => [
      row.valuation_id,
      {
        fmv_per_share: row.fmv_per_share,
        run_kind: specialtyRunKindOf(row.results_kind, {
          specialtyIsObject: row.specialty_is_object === true,
        }),
      },
    ]),
  );
}

/**
 * Ceiling on one page of the run history.
 *
 * Twenty is a deliberately short window — a working engagement re-runs the
 * engine many times a day — and two callers do arithmetic over it rather than
 * merely drawing it. `routes/qa.ts` collects the *superseded* figures from
 * this list to warn a reviewer that the number they are approving has moved,
 * and `routes/specialty.ts` reads the history for the run shapes a surface may
 * show. Both of those answer "no, nothing was superseded" when the answer is
 * really "not in the last twenty", which is the one shape of wrong a reviewer
 * cannot see. `listCalculationTraces` shares the window on purpose; see below.
 */
export const CALCULATION_PAGE_LIMIT = 20;

export async function listCalculations(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ calculations: Array<CalculationRow & { has_trace: boolean }>; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? CALCULATION_PAGE_LIMIT, 1), CALCULATION_PAGE_LIMIT);
  const { rows } = await pool.query<CalculationRow & { has_trace: boolean }>(
    `SELECT ${CALCULATION_COLUMNS}, trace IS NOT NULL AS has_trace
       FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [valuationId, limit + 1],
  );
  return { calculations: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * The same window, for the two surfaces that read a run's *headline* and throw
 * the documents away.
 *
 * `listCalculations` carries `inputs` and `results` because the calculation
 * history and the evidence bundle read them. Two of its callers do not:
 * `packageView` maps the page down to seven scalar columns under a comment
 * saying so ("Calculations without result payloads — the explorer shows
 * summaries"), and `routes/specialty.ts` maps to the same seven after filtering
 * on one key of `inputs`. Both were narrowing *after* the documents had been
 * read out of the table, shipped over the socket and parsed into JS objects by
 * the driver. A 409A `results` document is 11 kB on a ten-class cap table, 67 kB
 * at fifty and 613 kB at the 200-class cap — times twenty-one runs, to render a
 * list of dates and figures.
 *
 * `input_endpoint` is the one key of `inputs` that survives, because the
 * specialty tab's filter is the reason the column was being read at all. Probed
 * with `jsonb_typeof` rather than taken from `->>` alone: `->>` renders a number
 * or a boolean as text too, and the filter's own rule is `typeof === 'string'`.
 * Null for a run whose `inputs` has no `endpoint` — the ordinary 409A compute,
 * which is exactly what that filter drops.
 *
 * Same cap, same `+ 1` probe and same `truncated` as `listCalculations`, because
 * both callers report the window rather than the filtered list.
 */
export interface CalculationSummaryRow {
  id: string;
  valuation_id: string;
  engine_version: string;
  status: string;
  equity_value: string | null;
  fmv_per_share: string | null;
  error: string | null;
  created_at: Date;
  /** `inputs.endpoint`, when it is a string. Null on a 409A run. */
  input_endpoint: string | null;
}

export async function listCalculationSummaries(
  pool: pg.Pool,
  valuationId: string,
): Promise<{ calculations: CalculationSummaryRow[]; truncated: boolean }> {
  const limit = CALCULATION_PAGE_LIMIT;
  const { rows } = await pool.query<CalculationSummaryRow>(
    `SELECT id, valuation_id, engine_version, status, equity_value, fmv_per_share, error, created_at,
            CASE WHEN jsonb_typeof(inputs -> 'endpoint') = 'string'
                 THEN inputs ->> 'endpoint' END AS input_endpoint
       FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [valuationId, limit + 1],
  );
  return { calculations: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * The window's *results* documents, without the payload nobody opens beside them.
 *
 * WHY THIS EXISTS (round 330, methodology M8). `routes/qa.ts` reads this same
 * twenty-run window to collect the figures a report may still be quoting after
 * they were superseded, and it does one thing with each row: hand it to
 * `reportFigures`. It was taking the full row, so every QA review pulled twenty
 * `inputs` documents — the whole engine request per run, cap table and all — out
 * of the table, across the socket and through the driver's JSON parse, for no
 * reader. That is the defect `listCalculationSummaries` was written for, in the
 * one caller that genuinely needs `results` and so could not use it.
 *
 * `inputs` is not simply dropped, because `reportFigures` has one path into it:
 * `incomeAssumptions` falls back to `inputs.inputs.income` on runs that predate
 * the engine recording those assumptions on the result. Dropping the column
 * would quietly stop the stale-figure check seeing the income assumptions of
 * *older* runs — which is exactly the history it exists to look at. So the
 * column is projected down to that one path and rebuilt in the shape its reader
 * expects: same values, none of the cap table. A run with nothing there yields
 * `{"income": null}`, which that reader already treats as absent.
 *
 * Same `LIMIT 20`, same ordering and the same `+ 1` probe as `listCalculations`,
 * because the window has to be the one a reviewer can see — that is
 * `CALCULATION_PAGE_LIMIT`'s whole argument. The status filter stays with the
 * caller for the same reason: filtering in SQL would give the twenty most recent
 * *succeeded* runs rather than the succeeded ones among the twenty most recent,
 * which is a different and longer history.
 */
export type CalculationResultRow = Pick<CalculationRow, 'id' | 'status' | 'results' | 'inputs'>;

export async function listCalculationResults(
  pool: pg.Pool,
  valuationId: string,
): Promise<{ calculations: CalculationResultRow[]; truncated: boolean }> {
  const limit = CALCULATION_PAGE_LIMIT;
  const { rows } = await pool.query<CalculationResultRow>(
    `SELECT id, status, results,
            jsonb_build_object('inputs', jsonb_build_object('income', inputs #> '{inputs,income}')) AS inputs
       FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [valuationId, limit + 1],
  );
  return { calculations: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Every trace this valuation still holds, for the evidence bundle.
 *
 * The comment on `CALCULATION_COLUMNS` explains why no list query carries the
 * column: it is the engine's whole working state per run, and pulling it across
 * the wire for a list view would be all of that for nobody. An audit-defense
 * export is the one caller for which it is exactly the point — "how did you get
 * this number" is what the trace answers, step by step, including the two
 * things a results document structurally cannot say (an approach that was
 * *skipped* and one whose figure was *reused* from an earlier run are both
 * simply absent from `results.approaches`). So it is a second, deliberate
 * query rather than a widening of the shared column list.
 *
 * Same `LIMIT 20` and same ordering as `listCalculations`, so the traces in a
 * bundle describe the runs in the same bundle rather than a longer or shorter
 * history nobody can line up against `calculations.json`.
 */
export async function listCalculationTraces(
  pool: pg.Pool,
  valuationId: string,
): Promise<Array<{ id: string; created_at: Date; engine_version: string; trace: CalculationStep[] }>> {
  const { rows } = await pool.query<{
    id: string;
    created_at: Date;
    engine_version: string;
    trace: CalculationStep[];
  }>(
    `SELECT id, created_at, engine_version, trace
       FROM (
         SELECT id, created_at, engine_version, trace
           FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2
       ) recent
      WHERE trace IS NOT NULL
      ORDER BY created_at DESC`,
    [valuationId, CALCULATION_PAGE_LIMIT],
  );
  return rows;
}

/**
 * One run with its trace — the inspector's only reader of the column.
 *
 * Scoped by valuation as well as by id so a calculation id from one engagement
 * cannot be used to read another's working state. The id alone is unguessable,
 * but "unguessable" is not an access rule.
 */
export async function findCalculationWithTrace(
  pool: pg.Pool,
  valuationId: string,
  calculationId: string,
): Promise<CalculationRow | null> {
  const { rows } = await pool.query<CalculationRow>(
    'SELECT * FROM calculations WHERE id = $1 AND valuation_id = $2',
    [calculationId, valuationId],
  );
  return rows[0] ?? null;
}
