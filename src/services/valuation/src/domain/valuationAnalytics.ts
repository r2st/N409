/**
 * Valuation analytics (feature 5): time-series and benchmark statistics across
 * all of a company's calculations. Pure functions over the stored engine
 * `results` objects (same source the value bridge reads), so the route only
 * loads rows and hands them here.
 */

export interface AnalyticsPoint {
  calculation_id: string;
  valuation_id: string;
  as_of: string; // ISO date
  fmv_per_share: number | null;
  equity_value: number | null;
  dlom: number | null;
  volatility: number | null;
  market_multiple: number | null;
}

export interface TrendStat {
  first: number | null;
  last: number | null;
  change: number | null;
  pct_change: number | null;
}

export interface Benchmark {
  /** The comparable-company multiples used in the latest market approach. */
  comparable_multiples: number[];
  count: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  /**
   * The multiple the company's market approach applied — the engine's
   * `selected_multiple`, which is the median of the comparable set. See
   * {@link appliedMarketMultiple}.
   */
  company_multiple: number | null;
  /** Where company_multiple sits within the comparable set, 0–1. */
  percentile: number | null;
}

export interface ValuationAnalytics {
  series: AnalyticsPoint[];
  trends: {
    fmv_per_share: TrendStat;
    dlom: TrendStat;
    volatility: TrendStat;
    market_multiple: TrendStat;
  };
  benchmark: Benchmark;
  count: number;
}

type Results = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function marketApproach(r: Results): Results | undefined {
  const approaches = (r.approaches ?? {}) as Results;
  const market = approaches.market;
  return market !== null && typeof market === 'object' ? (market as Results) : undefined;
}

function marketMultiples(r: Results): number[] {
  const ms = marketApproach(r)?.multiples;
  if (!Array.isArray(ms)) return [];
  return ms.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** Median of a sample — `quantile(xs, 0.5)` by another name, kept explicit here. */
const median = (xs: number[]): number | null => quantile(xs, 0.5);

/**
 * The multiple the market approach actually applied.
 *
 * `approaches.market.selected_multiple` is the engine's own answer, and the
 * engine picks the **median** of the comparable set (`approaches.market_multiples`
 * in the engine-wrapper: `selected = statistics.median(clean)`). This module
 * used the **mean** instead, and
 * called it "the multiple the company's market approach applied" in the type it
 * returned. Comparable multiples are right-skewed almost by definition — one
 * richly-priced comp in a set of five is the normal shape — so the two are
 * routinely far apart: on `[4, 5, 6, 7, 28]` the engine values the company at
 * 6× and this reported 10×, then ranked that 10× against the same five comps
 * and put the company in the 90th percentile of a set it actually sits in the
 * middle of. Both the benchmark panel and the `market_multiple` trend line read
 * from here, so a valuation could be shown drifting up the comp range while the
 * multiple the opinion rests on had not moved.
 *
 * Falling back to the median rather than the mean, because that is the figure
 * the engine would have chosen for a calculation stored before it reported
 * `selected_multiple` — the point is to say what the run used, and guessing
 * with the engine's own rule is the closest available answer.
 */
export function appliedMarketMultiple(r: Results): number | null {
  const selected = num(marketApproach(r)?.selected_multiple);
  if (selected !== null && selected > 0) return selected;
  return median(marketMultiples(r));
}

/** Linear-interpolation percentile of a sorted-or-unsorted sample, q in [0,1]. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Fraction of `values` strictly below `x` (rank percentile in [0,1]). */
export function percentileRank(values: number[], x: number): number | null {
  if (values.length === 0) return null;
  const below = values.filter((v) => v < x).length;
  const equal = values.filter((v) => v === x).length;
  return (below + equal / 2) / values.length;
}

function trend(series: AnalyticsPoint[], key: keyof AnalyticsPoint): TrendStat {
  const vals = series.map((p) => p[key]).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return { first: null, last: null, change: null, pct_change: null };
  const first = vals[0]!;
  const last = vals[vals.length - 1]!;
  const change = last - first;
  return { first, last, change, pct_change: first !== 0 ? change / first : null };
}

export interface CalcInput {
  calculation_id: string;
  valuation_id: string;
  as_of: string;
  results: Results;
}

/**
 * Build the analytics bundle from a company's calculations. `calcs` should be
 * chronological (oldest → newest); the benchmark is drawn from the latest one.
 */
export function buildAnalytics(calcs: CalcInput[]): ValuationAnalytics {
  const series: AnalyticsPoint[] = calcs.map((c) => {
    const discounts = (c.results.discounts ?? {}) as Results;
    const assumptions = (c.results.assumptions ?? {}) as Results;
    return {
      calculation_id: c.calculation_id,
      valuation_id: c.valuation_id,
      as_of: c.as_of,
      fmv_per_share: num(c.results.fmv_per_share),
      equity_value: num(c.results.equity_value),
      dlom: num(discounts.dlom),
      volatility: num(assumptions.volatility),
      market_multiple: appliedMarketMultiple(c.results),
    };
  });

  const latest = calcs[calcs.length - 1];
  const comps = latest ? marketMultiples(latest.results) : [];
  const companyMultiple = latest ? appliedMarketMultiple(latest.results) : null;
  const benchmark: Benchmark = {
    comparable_multiples: comps,
    count: comps.length,
    min: comps.length ? Math.min(...comps) : null,
    p25: quantile(comps, 0.25),
    median: quantile(comps, 0.5),
    p75: quantile(comps, 0.75),
    max: comps.length ? Math.max(...comps) : null,
    company_multiple: companyMultiple,
    percentile: companyMultiple !== null ? percentileRank(comps, companyMultiple) : null,
  };

  return {
    series,
    trends: {
      fmv_per_share: trend(series, 'fmv_per_share'),
      dlom: trend(series, 'dlom'),
      volatility: trend(series, 'volatility'),
      market_multiple: trend(series, 'market_multiple'),
    },
    benchmark,
    count: series.length,
  };
}
