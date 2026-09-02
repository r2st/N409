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

/**
 * A row as the pg driver actually hands it back: `tax_rate` and
 * `terminal_value` are `numeric` and arrive as strings, `years` is int4 and
 * arrives as a number.
 *
 * Naming that difference lets `hydrate` return a `ProjectionRow` without an
 * assertion, so a column added to the interface and not converted here is a
 * compile error rather than a string that reaches the DCF as a discount rate.
 */
type RawProjectionRow = Omit<ProjectionRow, 'tax_rate' | 'years' | 'terminal_value'> & {
  tax_rate: string | number;
  years: string | number;
  terminal_value: string | number | null;
};

function hydrate(row: RawProjectionRow): ProjectionRow {
  return {
    ...row,
    tax_rate: Number(row.tax_rate),
    years: Number(row.years),
    terminal_value: row.terminal_value === null ? null : Number(row.terminal_value),
  };
}

/**
 * The page of runs this panel reads, and whether there are more.
 *
 * THE CAP HAD NO WAY TO BE SEEN (R304). Twenty was a TypeScript default
 * parameter rather than a number in the SQL, so the statement said `LIMIT $2`
 * and `silentCapCensus` — which reads repo SQL for a literal cap with no flag
 * beside it — had nothing to match on. Every caller took the default, so the
 * cap was as hard as one written into the query and invisible to the test
 * written to find exactly this.
 *
 * What it hides is the answer to the question the panel exists for. These runs
 * are a history an analyst adopts *from*, and the one the calculation is
 * carrying can sit anywhere in it: adopting is a POST on any run by id, so an
 * engagement whose analyst went back to an early window has its adopted run at
 * the bottom of the list. Past twenty runs the panel then showed an applied
 * figure with no row behind it — the reviewer asking where the discounted stream
 * came from gets a list that does not contain the answer, and no sign that anything
 * was left out.
 */
export const PROJECTION_PAGE_LIMIT = 20;

export async function listProjections(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ runs: ProjectionRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? PROJECTION_PAGE_LIMIT, 1), PROJECTION_PAGE_LIMIT);
  const { rows } = await pool.query<RawProjectionRow>(
    `SELECT * FROM valuation_projections
      WHERE valuation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [valuationId, limit + 1],
  );
  return { runs: rows.slice(0, limit).map(hydrate), truncated: rows.length > limit };
}

/**
 * The run that counts.
 *
 * The most recently *adopted* run if there is one, and otherwise the newest
 * run of any kind — the same rule `findCurrentVolatilityEstimate` follows, for
 * the same reason: a report may only describe the forecast the calculation
 * actually ran on, and a run nobody adopted is not that. Callers that must
 * have an adopted run check `applied_at` on what comes back.
 *
 * And adopted *last*, not measured last — see the note beside
 * `findCurrentVolatilityEstimate`, where R304 found the same `created_at`
 * ordering and the same consequence. Here the consequence is Exhibit C-1's
 * adoption note: the exhibit compares the build it was handed against the
 * stream `income.free_cash_flows` actually discounts, so a superseded forecast
 * arrives as "the financial model was amended after the forecast was adopted"
 * — an amendment nobody made, on an engagement whose analyst simply went back
 * to an earlier projection.
 *
 * THE SPELLING IS 0200's, AND MEANS WHAT THE OLD ONE MEANT (R306, M8). See the
 * matching note on `findCurrentVolatilityEstimate`: the leading
 * `(applied_at IS NOT NULL) DESC` was a boolean no btree holds, so one row cost
 * a read and a sort of the engagement's whole history, and
 * `applied_at DESC NULLS LAST` is that term and the one after it exactly — a
 * btree DESC is stored NULLS FIRST. 0.95 ms over 300 rows -> 0.028 ms over one.
 */
export async function findCurrentProjection(
  pool: pg.Pool,
  valuationId: string,
): Promise<ProjectionRow | null> {
  const { rows } = await pool.query<RawProjectionRow>(
    `SELECT * FROM valuation_projections
      WHERE valuation_id = $1
      ORDER BY applied_at DESC NULLS LAST, created_at DESC, id DESC
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
  const { rows } = await pool.query<RawProjectionRow>(
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
  const { rows } = await pool.query<RawProjectionRow>(
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
 * `applied_at` IS WHEN THIS RUN WAS LAST ADOPTED, NOT WHEN IT WAS FIRST
 * (R388, M3). It used to be the first: `WHERE applied_at IS NULL` made a
 * second adoption of the same run a no-op, on the reasoning that the first is
 * when the stream the calculation runs on was chosen.
 *
 * That reading and R304's ordering rule cannot both hold. `findCurrent…`
 * answers "which run is the calculation carrying" by taking the newest
 * `applied_at`, and adopting is a POST on any run of the history by id — so
 * going back to a run already adopted once is an ordinary step, and it left
 * the override, `engine_inputs` and the timestamp disagreeing: adopt A, adopt
 * B, go back to A, and the calculation carries A while the lookup still named
 * B. That is the superseded row R304 stopped the exhibits from describing,
 * reachable again in one more click. Every adoption writes now, so the
 * ordering follows the engagement.
 *
 * No adoption is lost by it — each one records its own `…_applied` admin event
 * with its own timestamp and actor, which is where the history of the choice
 * lives.
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
      WHERE valuation_id = $1 AND id = $2`,
    [valuationId, id, appliedBy],
  );
  return findProjection(pool, valuationId, id);
}
