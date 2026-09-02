import type pg from 'pg';
import { newUlid } from '@n409/shared';

/**
 * Persisted roll-forward runs (migration 0150).
 *
 * Append-only: `insertRollforwardRun` never updates a prior row, and the only
 * mutation is `markRollforwardRunApplied`, which records that a run's rolled
 * value was adopted as the engagement's backsolve anchor.
 *
 * As everywhere else in this layer, `numeric` arrives from pg as a string and
 * is mapped to a number once, at the boundary.
 */

/** One step of the calibration trail, as `engine/v1/rollforward` reports it. */
export interface CalibrationStep {
  step: string;
  value: number;
  /** Present on the `time_accretion` step only. */
  annual_rate?: number;
  years?: number;
  factor?: number;
  /** Present on an `adjustment` step only. */
  label?: string;
}

/** One detected difference between the prior engagement's inputs and this one's. */
export interface MaterialChange {
  field: string;
  material: boolean;
  detail: string;
  delta_pct?: number;
}

export interface RollforwardRunRow {
  id: string;
  valuation_id: string;
  prior_valuation_id: string | null;
  prior_calculation_id: string | null;
  prior_valuation_number: string | null;
  prior_valuation_date: Date;
  new_valuation_date: Date;
  years_elapsed: number;
  prior_equity_value: number;
  rolled_equity_value: number;
  annual_accretion: number;
  new_round_post_money: number | null;
  calibration_steps: CalibrationStep[];
  material_changes: MaterialChange[];
  requires_full_revaluation: boolean;
  pre_populated_inputs: Record<string, unknown>;
  applied_at: Date | null;
  applied_by: string | null;
  created_by: string | null;
  created_at: Date;
}

/** The one nullable `numeric`; the rest are NOT NULL and never arrive as null. */
type NullableNumeric = 'new_round_post_money';
type RequiredNumeric = 'years_elapsed' | 'prior_equity_value' | 'rolled_equity_value' | 'annual_accretion';

/**
 * A row as the pg driver actually hands it back: every `numeric` is a string.
 *
 * Split into required and nullable rather than converted inside a
 * `Record<string, unknown>` and cast, for the reason volatilityEstimates.ts
 * gives: a column added to the interface and forgotten in the mapping would
 * still compile, and a rolled equity value left as `'52500000.00'` reaches the
 * exhibit as a string that formats as `$NaN`.
 */
type RawRollforwardRunRow = Omit<RollforwardRunRow, NullableNumeric | RequiredNumeric> &
  Record<NullableNumeric, string | number | null> &
  Record<RequiredNumeric, string | number>;

function hydrate(row: RawRollforwardRunRow): RollforwardRunRow {
  return {
    ...row,
    years_elapsed: Number(row.years_elapsed),
    prior_equity_value: Number(row.prior_equity_value),
    rolled_equity_value: Number(row.rolled_equity_value),
    annual_accretion: Number(row.annual_accretion),
    new_round_post_money: row.new_round_post_money === null ? null : Number(row.new_round_post_money),
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
 * figure with no row behind it — the reviewer asking where the anchor came
 * from gets a list that does not contain the answer, and no sign that anything
 * was left out.
 */
export const ROLLFORWARD_RUN_PAGE_LIMIT = 20;

export async function listRollforwardRuns(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ runs: RollforwardRunRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? ROLLFORWARD_RUN_PAGE_LIMIT, 1), ROLLFORWARD_RUN_PAGE_LIMIT);
  const { rows } = await pool.query<RawRollforwardRunRow>(
    `SELECT * FROM rollforward_runs
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
 * The newest *applied* run if there is one, and otherwise nothing. Unlike the
 * volatility estimate — where the newest run of any kind is still the best
 * available description of where sigma came from — an unadopted roll-forward
 * describes an anchor the calculation did not use, and Exhibit B-2's whole
 * claim is that the concluded value bridges from the prior one. A proposal
 * nobody adopted is working material, so the exhibit does not see it.
 */
/**
 * The anchor the allocation ran on, or null if nobody adopted one.
 *
 * Unlike its two siblings this has always ordered by adoption and filtered on
 * it, so R304 left it alone — but it was reading the engagement's whole history
 * to answer, because nothing indexed `(valuation_id, applied_at)` and the
 * `applied_at IS NOT NULL` in the WHERE is a filter, not an ordering. 0200's
 * partial index is that predicate and this ordering, so the scan stops at the
 * first row: 300 index rows and 305 blocks on a 300-run engagement, against 1
 * and 4 (R306, M8).
 *
 * The predicate belongs in the index here and cannot be in the other two's,
 * which is the whole difference between this reader and them: a null
 * `applied_at` is an answer there — the newest run of any kind, when nobody has
 * adopted — and is no answer at all here.
 */
export async function findAppliedRollforwardRun(
  pool: pg.Pool,
  valuationId: string,
): Promise<RollforwardRunRow | null> {
  const { rows } = await pool.query<RawRollforwardRunRow>(
    `SELECT * FROM rollforward_runs
      WHERE valuation_id = $1 AND applied_at IS NOT NULL
      ORDER BY applied_at DESC, id DESC
      LIMIT 1`,
    [valuationId],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function findRollforwardRun(
  pool: pg.Pool,
  valuationId: string,
  id: string,
): Promise<RollforwardRunRow | null> {
  const { rows } = await pool.query<RawRollforwardRunRow>(
    'SELECT * FROM rollforward_runs WHERE valuation_id = $1 AND id = $2',
    [valuationId, id],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export interface NewRollforwardRun {
  valuationId: string;
  priorValuationId: string;
  priorCalculationId: string | null;
  priorValuationNumber: string | null;
  priorValuationDate: string;
  newValuationDate: string;
  yearsElapsed: number;
  priorEquityValue: number;
  rolledEquityValue: number;
  annualAccretion: number;
  newRoundPostMoney: number | null;
  calibrationSteps: CalibrationStep[];
  materialChanges: MaterialChange[];
  requiresFullRevaluation: boolean;
  prePopulatedInputs: Record<string, unknown>;
  createdBy: string | null;
}

export async function insertRollforwardRun(
  pool: pg.Pool,
  args: NewRollforwardRun,
): Promise<RollforwardRunRow> {
  const { rows } = await pool.query<RawRollforwardRunRow>(
    `INSERT INTO rollforward_runs (
       id, valuation_id, prior_valuation_id, prior_calculation_id, prior_valuation_number,
       prior_valuation_date, new_valuation_date, years_elapsed, prior_equity_value,
       rolled_equity_value, annual_accretion, new_round_post_money, calibration_steps,
       material_changes, requires_full_revaluation, pre_populated_inputs, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17)
     RETURNING *`,
    [
      newUlid(),
      args.valuationId,
      args.priorValuationId,
      args.priorCalculationId,
      args.priorValuationNumber,
      args.priorValuationDate,
      args.newValuationDate,
      args.yearsElapsed,
      args.priorEquityValue,
      args.rolledEquityValue,
      args.annualAccretion,
      args.newRoundPostMoney,
      JSON.stringify(args.calibrationSteps),
      JSON.stringify(args.materialChanges),
      args.requiresFullRevaluation,
      JSON.stringify(args.prePopulatedInputs),
      args.createdBy,
    ],
  );
  return hydrate(rows[0]!);
}

/**
 * Record that this run's rolled value is the engagement's backsolve anchor.
 *
 * `applied_at` IS WHEN THIS RUN WAS LAST ADOPTED, NOT WHEN IT WAS FIRST
 * (R388, M3). It used to be the first: `WHERE applied_at IS NULL` made a
 * second adoption of the same run a no-op, on the reasoning that the first is
 * when the anchor the calculation ran on was chosen.
 *
 * That reading and R304's ordering rule cannot both hold.
 * `findAppliedRollforwardRun` answers "which run is the calculation carrying"
 * by taking the newest `applied_at`, and adopting is a POST on any run of the
 * history by id — so going back to a run already adopted once is an ordinary
 * step, and it left
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
export async function markRollforwardRunApplied(
  pool: pg.Pool,
  valuationId: string,
  id: string,
  appliedBy: string | null,
): Promise<RollforwardRunRow | null> {
  await pool.query(
    `UPDATE rollforward_runs
        SET applied_at = now(), applied_by = $3
      WHERE valuation_id = $1 AND id = $2`,
    [valuationId, id, appliedBy],
  );
  return findRollforwardRun(pool, valuationId, id);
}
