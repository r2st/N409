import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction, type Queryable } from '../db/pool.js';
import { lockPublishGate } from './publishLock.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

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
const CALCULATION_COLUMNS = `id, valuation_id, engine_version, status, inputs, results,
  equity_value, fmv_per_share, error, diagnostics, created_by, created_at`;

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

/** Baseline for per-approach recalculation: the newest full successful run. */
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
 * Batch form of {@link latestSucceededCalculation}: the newest succeeded
 * calculation for each of `valuationIds`, keyed by valuation id. `DISTINCT ON`
 * collapses to one row per valuation, so this stays a single round trip no
 * matter how many valuations are asked for.
 */
export async function latestSucceededCalculationsByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, CalculationRow>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<CalculationRow>(
    `SELECT DISTINCT ON (valuation_id) ${CALCULATION_COLUMNS}
       FROM calculations
      WHERE valuation_id = ANY($1) AND status = 'succeeded'
      ORDER BY valuation_id, created_at DESC`,
    [[...new Set(valuationIds)]],
  );
  return new Map(rows.map((row) => [row.valuation_id, row]));
}

export async function listCalculations(
  pool: pg.Pool,
  valuationId: string,
): Promise<Array<CalculationRow & { has_trace: boolean }>> {
  const { rows } = await pool.query<CalculationRow & { has_trace: boolean }>(
    `SELECT ${CALCULATION_COLUMNS}, trace IS NOT NULL AS has_trace
       FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [valuationId],
  );
  return rows;
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
           FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT 20
       ) recent
      WHERE trace IS NOT NULL
      ORDER BY created_at DESC`,
    [valuationId],
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
