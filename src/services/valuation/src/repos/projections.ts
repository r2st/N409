import type pg from 'pg';
import { newUlid } from '@n409/shared';

/**
 * Persisted financial-projection runs (migration 0136).
 *
 * Append-only, on the same terms as `volatilityEstimates`: `insertProjection`
 * never updates a prior row, and the only mutation is `markProjectionApplied`,
 * which records that a run's cash flows were written into the financial model.
 *
 * As everywhere else in this layer, `numeric` arrives from pg as a string and
 * is mapped to a number once, at the boundary.
 */

export type ProjectionMethod = 'growth' | 'driver';
export type TerminalMethod = 'gordon' | 'exit_multiple';

/** One forecast year, as engine/projection.py built it. */
export interface ProjectionYear {
  year: number;
  revenue: number;
  cogs: number;
  opex: number;
  ebitda: number;
  da: number;
  ebit: number;
  nopat: number;
  capex: number;
  delta_nwc: number;
  fcff: number;
}

export interface ProjectionRow {
  id: string;
  valuation_id: string;
  method: ProjectionMethod;
  years: number;
  tax_rate: number;
  inputs: Record<string, unknown>;
  projections: ProjectionYear[];
  free_cash_flows: number[];
  terminal_method: TerminalMethod | null;
  terminal_value: number | null;
  applied_at: Date | null;
  applied_by: string | null;
  created_by: string | null;
  created_at: Date;
}

function hydrate(row: Record<string, unknown>): ProjectionRow {
  const out = { ...row } as Record<string, unknown>;
  out.tax_rate = Number(out.tax_rate);
  out.years = Number(out.years);
  out.terminal_value =
    out.terminal_value === null || out.terminal_value === undefined ? null : Number(out.terminal_value);
  return out as unknown as ProjectionRow;
}

/** Every run for one engagement, newest first — the order the panel reads in. */
export async function listProjections(
  pool: pg.Pool,
  valuationId: string,
  limit = 20,
): Promise<ProjectionRow[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM valuation_projections
      WHERE valuation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [valuationId, limit],
  );
  return rows.map(hydrate);
}

/**
 * The run that counts.
 *
 * The newest *applied* run if there is one, and otherwise the newest run of
 * any kind — the same rule `findCurrentVolatilityEstimate` follows, for the
 * same reason: a report may only describe the forecast the calculation
 * actually ran on, and a run nobody adopted is not that. Callers that must
 * have an adopted run check `applied_at` on what comes back.
 */
export async function findCurrentProjection(
  pool: pg.Pool,
  valuationId: string,
): Promise<ProjectionRow | null> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM valuation_projections
      WHERE valuation_id = $1
      ORDER BY (applied_at IS NOT NULL) DESC, created_at DESC, id DESC
      LIMIT 1`,
    [valuationId],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function findProjection(
  pool: pg.Pool,
  valuationId: string,
  id: string,
): Promise<ProjectionRow | null> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM valuation_projections WHERE valuation_id = $1 AND id = $2',
    [valuationId, id],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export interface NewProjection {
  valuationId: string;
  method: ProjectionMethod;
  years: number;
  taxRate: number;
  inputs: Record<string, unknown>;
  projections: ProjectionYear[];
  freeCashFlows: number[];
  terminalMethod: TerminalMethod | null;
  terminalValue: number | null;
  createdBy: string | null;
}

export async function insertProjection(pool: pg.Pool, args: NewProjection): Promise<ProjectionRow> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `INSERT INTO valuation_projections (
       id, valuation_id, method, years, tax_rate, inputs, projections,
       free_cash_flows, terminal_method, terminal_value, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
     RETURNING *`,
    [
      newUlid(),
      args.valuationId,
      args.method,
      args.years,
      args.taxRate,
      JSON.stringify(args.inputs),
      JSON.stringify(args.projections),
      JSON.stringify(args.freeCashFlows),
      args.terminalMethod,
      args.terminalValue,
      args.createdBy,
    ],
  );
  return hydrate(rows[0]!);
}

/**
 * Record that this run's flows are the engagement's forecast.
 *
 * Idempotent by design — re-applying the same run keeps the first adoption's
 * timestamp, because that is when the stream the calculation runs on was
 * chosen. `WHERE applied_at IS NULL` makes the second call a no-op rather than
 * a rewrite, and the row comes back either way.
 */
export async function markProjectionApplied(
  pool: pg.Pool,
  valuationId: string,
  id: string,
  appliedBy: string | null,
): Promise<ProjectionRow | null> {
  await pool.query(
    `UPDATE valuation_projections
        SET applied_at = now(), applied_by = $3
      WHERE valuation_id = $1 AND id = $2 AND applied_at IS NULL`,
    [valuationId, id, appliedBy],
  );
  return findProjection(pool, valuationId, id);
}
