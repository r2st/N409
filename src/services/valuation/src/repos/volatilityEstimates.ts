import type pg from 'pg';
import { newUlid } from '@n409/shared';

/**
 * Persisted volatility estimation runs (migration 0134).
 *
 * Append-only: `insertVolatilityEstimate` never updates a prior row, and the
 * only mutation is `markVolatilityEstimateApplied`, which records that a run's
 * recommendation was adopted as the engagement's sigma.
 *
 * As everywhere else in this layer, `numeric` arrives from pg as a string and
 * is mapped to a number once, at the boundary.
 */

export type VolatilityMethod = 'historical' | 'ewma' | 'parkinson' | 'manual';
export type VolatilityConfidence = 'high' | 'medium' | 'low' | 'manual';

/** One peer's measured volatility, as the engine reported it. */
export interface VolatilityCompany {
  ticker: string;
  volatility: number;
  used: boolean;
  /** Closes the measurement rests on. Absent for a run recorded before it was carried. */
  observations?: number;
}

/** A peer considered and not counted, with the reason it was dropped. */
export interface VolatilityExclusion {
  ticker: string;
  reason: string;
}

export interface VolatilityEstimateRow {
  id: string;
  valuation_id: string;
  method: VolatilityMethod;
  periods_per_year: number;
  window_start: Date;
  window_end: Date;
  time_to_exit_years: number | null;
  recommended: number;
  median_vol: number | null;
  mean_vol: number | null;
  min_vol: number | null;
  max_vol: number | null;
  coefficient_of_variation: number | null;
  confidence: VolatilityConfidence;
  manual_override: number | null;
  companies: VolatilityCompany[];
  excluded: VolatilityExclusion[];
  applied_at: Date | null;
  applied_by: string | null;
  created_by: string | null;
  created_at: Date;
}

/** The nullable `numeric` columns — the ones the driver hands back as strings. */
type NumericColumn =
  | 'time_to_exit_years'
  | 'median_vol'
  | 'mean_vol'
  | 'min_vol'
  | 'max_vol'
  | 'coefficient_of_variation'
  | 'manual_override';

/**
 * A row as the pg driver actually hands it back: `numeric` arrives as a string,
 * and `periods_per_year` is int4, which arrives as a number already.
 * `recommended` is the one NOT NULL numeric, so it is never null on the way in.
 *
 * Stating that difference is what lets `hydrate` return a
 * `VolatilityEstimateRow` without an assertion. The previous version converted
 * columns inside a `Record<string, unknown>` and cast the result, so a column
 * added to the interface and forgotten in the loop would still have compiled —
 * and a volatility left as `'0.62'` reaches the OPM as a string.
 */
type RawVolatilityEstimateRow = Omit<VolatilityEstimateRow, NumericColumn | 'recommended'> &
  Record<NumericColumn, string | number | null> & { recommended: string | number };

const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

function hydrate(row: RawVolatilityEstimateRow): VolatilityEstimateRow {
  return {
    ...row,
    recommended: Number(row.recommended),
    time_to_exit_years: num(row.time_to_exit_years),
    median_vol: num(row.median_vol),
    mean_vol: num(row.mean_vol),
    min_vol: num(row.min_vol),
    max_vol: num(row.max_vol),
    coefficient_of_variation: num(row.coefficient_of_variation),
    manual_override: num(row.manual_override),
    periods_per_year: Number(row.periods_per_year),
  };
}

/** Every run for one engagement, newest first — the order the panel reads in. */
export async function listVolatilityEstimates(
  pool: pg.Pool,
  valuationId: string,
  limit = 20,
): Promise<VolatilityEstimateRow[]> {
  const { rows } = await pool.query<RawVolatilityEstimateRow>(
    `SELECT * FROM volatility_estimates
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
 * any kind. The distinction matters to the exhibit: a report may only describe
 * the derivation the calculation actually ran on, and an estimate nobody
 * adopted is not that. Callers that must have an adopted run check
 * `applied_at` on what comes back.
 */
export async function findCurrentVolatilityEstimate(
  pool: pg.Pool,
  valuationId: string,
): Promise<VolatilityEstimateRow | null> {
  const { rows } = await pool.query<RawVolatilityEstimateRow>(
    `SELECT * FROM volatility_estimates
      WHERE valuation_id = $1
      ORDER BY (applied_at IS NOT NULL) DESC, created_at DESC, id DESC
      LIMIT 1`,
    [valuationId],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function findVolatilityEstimate(
  pool: pg.Pool,
  valuationId: string,
  id: string,
): Promise<VolatilityEstimateRow | null> {
  const { rows } = await pool.query<RawVolatilityEstimateRow>(
    'SELECT * FROM volatility_estimates WHERE valuation_id = $1 AND id = $2',
    [valuationId, id],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export interface NewVolatilityEstimate {
  valuationId: string;
  method: VolatilityMethod;
  periodsPerYear: number;
  windowStart: string;
  windowEnd: string;
  timeToExitYears: number | null;
  recommended: number;
  medianVol: number | null;
  meanVol: number | null;
  minVol: number | null;
  maxVol: number | null;
  coefficientOfVariation: number | null;
  confidence: VolatilityConfidence;
  manualOverride: number | null;
  companies: VolatilityCompany[];
  excluded: VolatilityExclusion[];
  createdBy: string | null;
}

export async function insertVolatilityEstimate(
  pool: pg.Pool,
  args: NewVolatilityEstimate,
): Promise<VolatilityEstimateRow> {
  const { rows } = await pool.query<RawVolatilityEstimateRow>(
    `INSERT INTO volatility_estimates (
       id, valuation_id, method, periods_per_year, window_start, window_end,
       time_to_exit_years, recommended, median_vol, mean_vol, min_vol, max_vol,
       coefficient_of_variation, confidence, manual_override, companies, excluded, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)
     RETURNING *`,
    [
      newUlid(),
      args.valuationId,
      args.method,
      args.periodsPerYear,
      args.windowStart,
      args.windowEnd,
      args.timeToExitYears,
      args.recommended,
      args.medianVol,
      args.meanVol,
      args.minVol,
      args.maxVol,
      args.coefficientOfVariation,
      args.confidence,
      args.manualOverride,
      JSON.stringify(args.companies),
      JSON.stringify(args.excluded),
      args.createdBy,
    ],
  );
  return hydrate(rows[0]!);
}

/**
 * Record that this run's recommendation is the engagement's sigma.
 *
 * Idempotent by design — re-applying the same run keeps the first adoption's
 * timestamp, because that is when the number the calculation ran on was
 * chosen. `WHERE applied_at IS NULL` makes the second call a no-op rather than
 * a rewrite, and the row comes back either way.
 */
export async function markVolatilityEstimateApplied(
  pool: pg.Pool,
  valuationId: string,
  id: string,
  appliedBy: string | null,
): Promise<VolatilityEstimateRow | null> {
  await pool.query(
    `UPDATE volatility_estimates
        SET applied_at = now(), applied_by = $3
      WHERE valuation_id = $1 AND id = $2 AND applied_at IS NULL`,
    [valuationId, id, appliedBy],
  );
  return findVolatilityEstimate(pool, valuationId, id);
}
