/**
 * Expected volatility, derived rather than typed.
 *
 * `valuation_params.volatility` has always described itself as "Equity
 * volatility from guideline companies". Nothing derived it from guideline
 * companies: it defaulted to 0.65 and was whatever an analyst typed over that,
 * and it then fed the OPM allocation, every option-based DLOM (Chaffee,
 * Finnerty, Ghaidarov, Longstaff) and the ASC 718 assumptions table. It is the
 * input a reviewer questions second, after the multiple, and the report had no
 * answer beyond the number itself.
 *
 * `engine/v1/volatility` has produced the answer since it was written — three
 * estimators over comparable price series, a per-company breakdown, and a
 * confidence graded on comp count and cross-sectional dispersion — and had no
 * caller anywhere on the platform. This module is the shaping layer between
 * that engine and the two things that consume it: the route that stores a run,
 * and the exhibit that prints one.
 *
 * Two rules the shapes below follow from:
 *
 *   * A measurement that is not the whole set is not the set's median. The
 *     engine drops a comp whose window shows no measurable movement, and the
 *     price feed can fail to serve a ticker at all. Both are "considered and
 *     not counted", both are named, and the count the recommendation rests on
 *     is stated separately from the count of the peer set.
 *   * An estimate is not a conclusion until somebody adopts it. `applied_at`
 *     on the row is what lets the exhibit say the derivation belongs to the
 *     sigma the calculation ran on, rather than to a number in a panel.
 */

import type {
  VolatilityCompany,
  VolatilityConfidence,
  VolatilityEstimateRow,
  VolatilityExclusion,
  VolatilityMethod,
} from '../repos/volatilityEstimates.js';
import { isIsoCalendarDate } from '@n409/shared';
import { calendarDate, calendarDateOf } from './calendarDate.js';

export class VolatilityInputError extends Error {}

/** The estimators `engine/v1/volatility` implements. */
export const VOLATILITY_METHODS = ['historical', 'ewma', 'parkinson'] as const;
export type RequestedVolatilityMethod = (typeof VOLATILITY_METHODS)[number];

/** How each estimator describes itself in the exhibit and the panel. */
export const VOLATILITY_METHOD_LABELS: Record<VolatilityMethod, string> = {
  historical: 'Close-to-close (annualized sample standard deviation of daily log returns)',
  ewma: 'Exponentially weighted moving average (RiskMetrics, λ = 0.94)',
  parkinson: 'Parkinson (1980) high-low range estimator',
  manual: 'Analyst-selected',
};

/** Short form, for a table cell that has no room for the sentence above. */
export const VOLATILITY_METHOD_SHORT: Record<VolatilityMethod, string> = {
  historical: 'Close-to-close',
  ewma: 'EWMA',
  parkinson: 'Parkinson',
  manual: 'Analyst-selected',
};

/**
 * What each confidence grade means, in the words the report uses.
 *
 * The engine grades on two things only — how many comps survived, and how
 * widely they disagreed — so the sentence says both. A grade printed without
 * its basis is an adjective; with it, a reviewer can decide whether they agree.
 */
export const VOLATILITY_CONFIDENCE_NOTES: Record<VolatilityConfidence, string> = {
  high: 'five or more measured peers, closely clustered',
  medium: 'three or more measured peers, moderately dispersed',
  low: 'few measured peers, or widely dispersed measurements',
  manual: 'selected by the analyst rather than estimated from the peer set',
};

/**
 * The default observation window: the calendar year to the valuation date.
 *
 * Matching the window to the term the sigma is used over is the ideal, and for
 * an OPM with a three-year horizon that would mean three years of daily closes.
 * One year is the default rather than the term because it is what a reader
 * expects of "historical volatility" absent a statement otherwise, and because
 * a window long enough to span a peer's own regime change measures the change
 * rather than the risk. The window is a request parameter, so an analyst who
 * wants the term-matched measurement asks for it and the exhibit reports what
 * they asked for.
 */
export const DEFAULT_WINDOW_DAYS = 365;

/**
 * `YYYY-MM-DD`, which is what the price feed takes and the row stores.
 *
 * Formatted from the local parts. The Dates reaching this are anchored on a
 * `date` column — `resolveWindow` below builds the window from the engagement's
 * valuation date, and `clientIntake` and `rollforward` hand it their own — and
 * such a Date is midnight *local*, so reading it as an instant dates it a day
 * early east of UTC. See domain/calendarDate.ts.
 */
export function isoDate(d: Date): string {
  return calendarDate(d);
}

/**
 * The window to measure over, from the valuation date and a requested length.
 *
 * Anchored on the valuation date rather than on today, because a sigma
 * supporting a 409A as of a past date must not be measured over price history
 * the subject could not have known about. An engagement with no valuation date
 * set falls back to today, which is the only other defensible anchor.
 *
 * The anchor is resolved to a calendar day *before* any arithmetic, because it
 * arrives in three forms that do not agree about what a day is: a `date` column
 * off the driver (midnight local), a `YYYY-MM-DD` string from a request body,
 * and — on the fallback — a real instant. Subtracting from whichever Date those
 * happened to produce and formatting the result was how the two ends could
 * disagree by a day with each other, in opposite directions, depending on the
 * server's zone and which form the caller had.
 *
 * Once it is a day, the arithmetic runs in UTC — anchored at `T00:00:00Z`, as
 * `vesting.ts` does — so the window is exactly `days` long and the same in
 * every zone. That is why the ends are formatted through `toISOString()` here
 * and not through `isoDate` above: by this point they are Dates this function
 * built in UTC, not days the driver handed it. See domain/calendarDate.ts.
 */
export function resolveWindow(
  valuationDate: Date | string | null | undefined,
  days: number,
  now: Date,
): { start: string; end: string } {
  if (!Number.isFinite(days) || days < 30) {
    throw new VolatilityInputError('The observation window must be at least 30 days');
  }
  const anchorDay = valuationDate ? calendarDateOf(valuationDate) : '';
  // An unparseable or absent anchor falls back to today, as before. `now` is an
  // instant, so its day is its UTC one.
  //
  // The check is the calendar's, not the shape's: `2026-02-31` matches
  // `\d{4}-\d{2}-\d{2}` and is not a day, and it would be returned as `end`
  // while `new Date` rolled it three days forward to compute `start` — a window
  // whose two ends disagree about which day it closed on.
  const endDay = isIsoCalendarDate(anchorDay) ? anchorDay : now.toISOString().slice(0, 10);
  const end = new Date(`${endDay}T00:00:00Z`);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end: endDay };
}

/** One peer's price series, as `engine/v1/volatility` takes it. */
export interface VolatilitySeries {
  ticker: string;
  prices: number[];
  highs?: number[];
  lows?: number[];
}

/** One row of `engine/v1/market-feed` `kind: "prices"`. */
interface FeedBar {
  date?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
}

function fin(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Closes (and the high/low legs) out of one feed response.
 *
 * A bar missing any leg the requested estimator needs drops the whole bar, not
 * just the leg: the three series are positionally paired inside the engine, and
 * a highs array one element shorter than its lows would silently pair each
 * day's high with the next day's low. Two closes is the engine's own floor for
 * a measurable series, and fewer than that is reported as an unusable ticker
 * rather than sent to be rejected.
 */
export function seriesFromBars(
  ticker: string,
  bars: unknown,
  method: RequestedVolatilityMethod,
): VolatilitySeries | null {
  if (!Array.isArray(bars)) return null;
  const prices: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (const raw of bars as FeedBar[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const close = fin(raw.close);
    const high = fin(raw.high);
    const low = fin(raw.low);
    if (method === 'parkinson') {
      // The range estimator reads highs and lows only, but a bar with no close
      // is a bar the feed did not really have; keeping the three legs aligned
      // costs nothing and keeps one code path.
      if (close === null || high === null || low === null || high <= 0 || low <= 0) continue;
    } else if (close === null || close <= 0) {
      continue;
    }
    prices.push(close as number);
    if (high !== null) highs.push(high);
    if (low !== null) lows.push(low);
  }
  if (prices.length < 2) return null;
  if (method === 'parkinson') {
    if (highs.length !== prices.length || lows.length !== prices.length) return null;
    return { ticker, prices, highs, lows };
  }
  return { ticker, prices };
}

/** The `engine/v1/volatility` response, as far as this module reads it. */
export interface VolatilityEngineResponse {
  method?: unknown;
  recommended_volatility?: unknown;
  median_volatility?: unknown;
  mean_volatility?: unknown;
  min_volatility?: unknown;
  max_volatility?: unknown;
  coefficient_of_variation?: unknown;
  confidence?: unknown;
  manual_override?: unknown;
  company_count?: unknown;
  companies?: unknown;
  excluded_companies?: unknown;
}

function asMethod(value: unknown): VolatilityMethod {
  const s = typeof value === 'string' ? value : '';
  return s === 'historical' || s === 'ewma' || s === 'parkinson' || s === 'manual' ? s : 'historical';
}

function asConfidence(value: unknown): VolatilityConfidence {
  const s = typeof value === 'string' ? value : '';
  return s === 'high' || s === 'medium' || s === 'low' || s === 'manual' ? s : 'low';
}

/**
 * The engine's answer, as the row stores it.
 *
 * `observations` is grafted on from the series that were sent rather than read
 * out of the response, because the engine reports what it measured and not how
 * much of it there was — and "64% off eleven closes" is a materially different
 * disclosure from "64% off two hundred and fifty".
 *
 * Feed failures are folded into the same `excluded` list the engine's own
 * degenerate-series drops land in. To a reader of the exhibit they are the same
 * fact — a peer that is in the set and not in the measurement — and splitting
 * them across two lists would invite the reading that one list is complete.
 */
export function shapeEstimate(
  response: VolatilityEngineResponse,
  args: {
    series: readonly VolatilitySeries[];
    feedFailures: readonly VolatilityExclusion[];
  },
): {
  method: VolatilityMethod;
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
} {
  const recommended = fin(response.recommended_volatility);
  if (recommended === null || recommended <= 0) {
    throw new VolatilityInputError('The estimator returned no usable volatility');
  }
  const observations = new Map(args.series.map((s) => [s.ticker, s.prices.length]));
  const companies: VolatilityCompany[] = (Array.isArray(response.companies) ? response.companies : [])
    .map((raw) => {
      const c = raw as { ticker?: unknown; volatility?: unknown; used?: unknown };
      const ticker = typeof c.ticker === 'string' ? c.ticker : null;
      const vol = fin(c.volatility);
      if (ticker === null || vol === null) return null;
      const n = observations.get(ticker);
      return {
        ticker,
        volatility: vol,
        used: c.used !== false,
        ...(n === undefined ? {} : { observations: n }),
      } satisfies VolatilityCompany;
    })
    .filter((c): c is VolatilityCompany => c !== null);

  const engineExcluded: VolatilityExclusion[] = (
    Array.isArray(response.excluded_companies) ? response.excluded_companies : []
  )
    .map((raw) => {
      const e = raw as { ticker?: unknown; reason?: unknown };
      const ticker = typeof e.ticker === 'string' ? e.ticker : null;
      if (ticker === null) return null;
      return {
        ticker,
        reason:
          typeof e.reason === 'string' && e.reason.trim() !== ''
            ? e.reason.trim()
            : 'excluded by the estimator',
      } satisfies VolatilityExclusion;
    })
    .filter((e): e is VolatilityExclusion => e !== null);

  return {
    method: asMethod(response.method),
    recommended,
    medianVol: fin(response.median_volatility),
    meanVol: fin(response.mean_volatility),
    minVol: fin(response.min_volatility),
    maxVol: fin(response.max_volatility),
    coefficientOfVariation: fin(response.coefficient_of_variation),
    confidence: asConfidence(response.confidence),
    manualOverride: fin(response.manual_override),
    companies,
    excluded: [...args.feedFailures, ...engineExcluded],
  };
}

/**
 * How many peers the recommendation actually rests on.
 *
 * Derived from `companies` rather than trusting the engine's `company_count`,
 * so the number in the exhibit and the rows under it can never disagree.
 */
export function measuredCount(row: Pick<VolatilityEstimateRow, 'companies'>): number {
  return row.companies.filter((c) => c.used).length;
}

/**
 * The sentence the DLOM and allocation chapters carry about where sigma came
 * from, or null when nothing has been derived.
 *
 * Deliberately says whether the estimate was adopted. A run sitting unapplied
 * beside a hand-typed sigma is the situation this whole feature exists to make
 * visible, and a narrative that described the derivation without saying the
 * calculation ignored it would be worse than the silence it replaced.
 */
export function volatilityNarrative(
  row: VolatilityEstimateRow | null,
  appliedVolatility: number | null,
): string | null {
  if (!row) return null;
  const n = measuredCount(row);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const basis =
    row.method === 'manual'
      ? `The expected volatility of ${pct(row.recommended)} was selected by the analyst.`
      : `The expected volatility of ${pct(row.recommended)} is the median of ${n} guideline ` +
        `${n === 1 ? 'company' : 'companies'} measured over the ${isoDate(row.window_start)} ` +
        `to ${isoDate(row.window_end)} window on a ${VOLATILITY_METHOD_SHORT[row.method].toLowerCase()} basis.`;

  if (row.applied_at === null) {
    return `${basis} This estimate has not been adopted as the valuation assumption; the allocation was run on the analyst’s own selection.`;
  }
  if (appliedVolatility !== null && Math.abs(appliedVolatility - row.recommended) > 0.0001) {
    return (
      `${basis} The valuation applies ${pct(appliedVolatility)}, which differs from the derived ` +
      'figure; the basis for the departure is stated in the analysis.'
    );
  }
  return basis;
}
