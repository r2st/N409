import { RECALC_APPROACH_KEYS, type RecalcApproach } from './approaches.js';

/**
 * The workspace header counters (design §4.6 and §7.3, P2-17 and P2-18).
 *
 * 409.ai's detail header carries four numbers — pending files, my tasks, all
 * tasks, chat — and its sidebar carries a fifth as an `n/m` badge on
 * Calculations. All five answer the same question in different words: what is
 * outstanding on this engagement, without opening five tabs to find out.
 *
 * They ship as one object on `GET /valuations/:id` rather than five endpoints.
 * Five requests to render one header is five chances for the header to
 * disagree with itself, and the counters are read together or not at all.
 *
 * Every count here is *outstanding work*, never a total. "12 documents" is a
 * fact about the past; "3 pending" is a thing to do. A counter that never
 * reaches zero is a badge people learn to stop seeing.
 */

export interface ValuationCounters {
  /** Live documents nobody has marked reviewed. */
  pending_files: number;
  /** Open review tasks assigned to the caller. */
  my_tasks: number;
  /** Open review tasks on the engagement, whoever holds them. */
  all_tasks: number;
  /** Comments on the thread since the caller last read it. */
  unread_comments: number;
  /** The Calculations `n/m` badge — §7.3. */
  calculations: CalculationCoverage;
}

export interface CalculationCoverage {
  /** Approaches with a result in the latest calculation. */
  done: number;
  /** Approaches the engagement's weighting says should be computed. */
  total: number;
  /** Which of `total` are still missing — what the badge is really saying. */
  missing: RecalcApproach[];
}

/** A weight row, as numeric-as-string off the database. */
export interface ApproachWeights {
  weight_asset: string | number | null;
  weight_opm: string | number | null;
  weight_income: string | number | null;
  weight_market: string | number | null;
}

function enabled(weight: string | number | null | undefined): boolean {
  if (weight === null || weight === undefined) return false;
  const n = Number(weight);
  // A zero weight is an approach the analyst considered and excluded. It is
  // not outstanding work, and counting it would leave the badge permanently
  // short of its denominator on every engagement that weighted three of four.
  return Number.isFinite(n) && n > 0;
}

/**
 * Which approaches this engagement has actually asked for.
 *
 * Params with no weights set at all mean the analyst has not weighted yet, and
 * an engine run computes every approach it has inputs for. Reporting `0/0`
 * there would say "nothing to do" on the engagement where the most is; the
 * denominator falls back to all four, which is what an unweighted run produces.
 */
export function enabledApproaches(weights: ApproachWeights | null): RecalcApproach[] {
  if (!weights) return [...RECALC_APPROACH_KEYS];
  const chosen = RECALC_APPROACH_KEYS.filter((key) => enabled(weights[WEIGHT_FIELD[key]]));
  return chosen.length > 0 ? chosen : [...RECALC_APPROACH_KEYS];
}

const WEIGHT_FIELD: Record<RecalcApproach, keyof ApproachWeights> = {
  asset: 'weight_asset',
  opm: 'weight_opm',
  income: 'weight_income',
  market: 'weight_market',
};

const ENGINE_KEY: Record<RecalcApproach, string> = {
  asset: 'asset',
  opm: 'opm_backsolve',
  income: 'income',
  market: 'market',
};

/**
 * `n/m` for the Calculations nav badge.
 *
 * `m` is the approaches the weighting asks for; `n` is those the latest
 * calculation actually produced a value for. A present-but-null entry counts
 * as missing: the engine writes a key for an approach it attempted and could
 * not complete, and treating that as done is how a badge reads 4/4 on a run
 * whose income approach failed for want of a forecast.
 */
export function calculationCoverage(weights: ApproachWeights | null, approaches: unknown): CalculationCoverage {
  const wanted = enabledApproaches(weights);
  if (!approaches || typeof approaches !== 'object') {
    return { done: 0, total: wanted.length, missing: wanted };
  }
  const bag = approaches as Record<string, unknown>;
  const missing = wanted.filter((key) => !hasValue(bag[ENGINE_KEY[key]]));
  return { done: wanted.length - missing.length, total: wanted.length, missing };
}

function hasValue(entry: unknown): boolean {
  if (entry === null || entry === undefined) return false;
  if (typeof entry === 'number') return Number.isFinite(entry);
  if (typeof entry !== 'object') return false;
  const value = (entry as { equity_value?: unknown }).equity_value;
  // An approach block with no equity value is an approach that was attempted.
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}
