/**
 * The free, public, no-signup common-stock FMV estimator behind
 * `/tools/409a-valuation-calculator`.
 *
 * This is emphatically **not** a valuation, and the shape of the code is meant
 * to keep it from being mistaken for one. A real appraisal establishes total
 * equity value from the market/income/asset approaches, allocates it across the
 * share classes through an OPM or PWERM over the actual liquidation waterfall,
 * and applies a DLOM supported by option models or restricted-stock studies.
 * The engine in this platform does all three against a company's real cap
 * table. What follows compresses the same three steps into a stage-calibrated
 * statistical range, because the only inputs it has are the four scraps of
 * evidence a founder can type in a minute.
 *
 * So every figure it returns is an interval, never a point, and
 * `SAFE_HARBOR_DISCLAIMER` travels with the result rather than living in the
 * page template — a caller that renders the number is holding the caveat too.
 *
 * The method, in three steps that mirror the appraisal:
 *
 *   1. **Equity value.** Each piece of evidence the caller supplied becomes an
 *      independent lognormal opinion about total equity value: a priced round
 *      is the strongest, revenue and profit multiples are stage-calibrated
 *      bands, and total capital raised is weak corroboration of scale rather
 *      than a price. They are pooled in log space by weight, and the pooled
 *      spread follows the law of total variance — so when two sources disagree
 *      the band widens, which is the honest response to contradictory evidence.
 *
 *   2. **Allocation.** The common share of equity value is a stage band, wide
 *      at pre-seed (little or no preference stack ahead of common) and narrow
 *      and low at late stage (a deep stack, participation, and a large pool).
 *      This stands in for the waterfall the estimator cannot see.
 *
 *   3. **Marketability.** A stage DLOM band is applied to the allocated
 *      common. Per-share divides by fully diluted shares when they are given.
 *
 * Steps 1-3 are reported separately rather than collapsed, so a reader can see
 * which of the three moved the number — and, in particular, see the preference
 * stack rather than only its effect.
 */

/** z at the 90th percentile of the standard normal: the band edge. */
const Z90 = 1.2815515655446004;

/**
 * The interval every figure is quoted as. `p10`/`p90` bracket the central 80
 * percent — the shaded region on the chart — with `median` marked inside it.
 */
export interface Range {
  p10: number;
  median: number;
  p90: number;
}

/** A lognormal opinion: `mu`/`sigma` are the mean and sd of the natural log. */
interface LogNormal {
  mu: number;
  sigma: number;
}

export const ESTIMATOR_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'pre_ipo'] as const;
export type EstimatorStage = (typeof ESTIMATOR_STAGES)[number];

/**
 * How long ago the last priced round closed. A round is the best evidence of
 * equity value there is, and it decays: not by drifting the median, because
 * nothing here knows which way the company went since, but by widening the
 * band and counting for less against the other evidence.
 */
export const ESTIMATOR_ROUND_AGES = ['never', 'under_6m', '6_to_12m', '1_to_2y', 'over_2y'] as const;
export type EstimatorRoundAge = (typeof ESTIMATOR_ROUND_AGES)[number];

export interface EstimatorInput {
  stage: EstimatorStage;
  round_age: EstimatorRoundAge;
  /** Post-money of the last priced round, in whole currency units. */
  post_money?: number;
  /** All capital in, including SAFEs and notes. Scale evidence, not a price. */
  capital_raised?: number;
  /** Revenue over the last twelve months. */
  revenue_ltm?: number;
  /** EBITDA or pre-tax profit over the last twelve months. */
  profit_ltm?: number;
  /** Fully diluted share count, if a per-share figure is wanted. */
  fully_diluted_shares?: number;
}

/** One piece of evidence, and what it implied on its own. */
export interface EvidenceContribution {
  source: 'priced_round' | 'revenue_multiple' | 'profit_multiple' | 'capital_raised';
  label: string;
  /** Share of the pooled log-mean this source accounted for, 0-1. */
  weight: number;
  /** Equity value this source implied by itself. */
  implied: Range;
  /** Why it carries the weight it does. */
  note: string;
}

export interface EstimatorResult {
  stage: EstimatorStage;
  /** Step 1 — total equity value. */
  equity_value: Range;
  /** Step 2 — common's share of it, before any marketability discount. */
  common_allocation: Range;
  /** The stage band used for step 2, as decimals. */
  common_share_band: { low: number; high: number };
  /** Step 3 — indicative common FMV after the marketability discount. */
  common_fmv: Range;
  /** The DLOM applied in step 3, as a decimal. */
  dlom: number;
  /** `common_fmv` per fully diluted share, when a share count was supplied. */
  per_share: Range | null;
  /** What each supplied input contributed, strongest first. */
  evidence: EvidenceContribution[];
  /** Points for plotting the equity-value density. */
  curve: { value: number; density: number }[];
  disclaimer: string;
}

export const SAFE_HARBOR_DISCLAIMER =
  'This is an estimate, not a valuation. It blends the market evidence you enter into a ' +
  'statistical range and does not model your actual cap table, liquidation preferences, ' +
  'option pool, or company-specific facts. It carries no IRS safe-harbor protection and ' +
  'must not be used to set option strike prices. For that you need an independent appraisal.';

/**
 * Revenue multiples applied to trailing revenue, as p10/p90 of equity value
 * per unit of revenue. They fall with stage because the growth rate that earns
 * an early multiple is not still in the numbers by pre-IPO.
 */
const REVENUE_MULTIPLE: Record<EstimatorStage, [number, number]> = {
  pre_seed: [8, 30],
  seed: [7, 25],
  series_a: [5, 18],
  series_b: [4, 14],
  series_c: [3, 10],
  pre_ipo: [2, 8],
};

/** Earnings multiples. Flatter across stage than revenue multiples are. */
const PROFIT_MULTIPLE: Record<EstimatorStage, [number, number]> = {
  pre_seed: [10, 35],
  seed: [10, 30],
  series_a: [9, 26],
  series_b: [8, 22],
  series_c: [7, 18],
  pre_ipo: [6, 16],
};

/**
 * Equity value per unit of total capital raised. The widest band of the four
 * and the lowest weight: money in is a fact about the past, and a company can
 * raise a great deal without being worth a multiple of it.
 */
const CAPITAL_MULTIPLE: Record<EstimatorStage, [number, number]> = {
  pre_seed: [1.5, 6],
  seed: [1.5, 6],
  series_a: [1.2, 5],
  series_b: [1.2, 4.5],
  series_c: [1.0, 4],
  pre_ipo: [1.0, 3.5],
};

/**
 * Common's share of equity value by stage — the stand-in for the waterfall.
 *
 * At pre-seed there is usually no preferred ahead of common at all, so the
 * band sits near one. Each round adds preference, and at late stage a deep
 * non-participating stack plus a grown option pool leaves common a minority of
 * the whole. A Series A company at a $25M post lands at $6.25M-$10M of common
 * on this band, which is the worked example the tool page states.
 */
const COMMON_SHARE: Record<EstimatorStage, [number, number]> = {
  pre_seed: [0.75, 0.92],
  seed: [0.5, 0.75],
  series_a: [0.25, 0.4],
  series_b: [0.2, 0.35],
  series_c: [0.15, 0.3],
  pre_ipo: [0.12, 0.25],
};

/**
 * Stage DLOM. Falls as an exit gets closer and the holding period shortens,
 * which is the variable both Finnerty and Chaffe are most sensitive to.
 */
const STAGE_DLOM: Record<EstimatorStage, number> = {
  pre_seed: 0.35,
  seed: 0.32,
  series_a: 0.28,
  series_b: 0.25,
  series_c: 0.2,
  pre_ipo: 0.15,
};

/** Weight and added log-spread for a priced round, by how stale it is. */
const ROUND_AGE_DECAY: Record<EstimatorRoundAge, { weight: number; addedSigma: number; note: string }> = {
  never: { weight: 0, addedSigma: 0, note: 'No priced round to draw on.' },
  under_6m: {
    weight: 1,
    addedSigma: 0.05,
    note: 'A round inside six months is the strongest evidence of value there is.',
  },
  '6_to_12m': {
    weight: 0.85,
    addedSigma: 0.15,
    note: 'Still recent, but two quarters of trading have happened since the price was struck.',
  },
  '1_to_2y': {
    weight: 0.6,
    addedSigma: 0.3,
    note: 'A year or more of drift the round price cannot see, in either direction.',
  },
  over_2y: {
    weight: 0.35,
    addedSigma: 0.5,
    note: 'Over two years old — corroborating evidence now, not a current price.',
  },
};

/** Base log-spread of each source before stage or staleness widen it. */
const BASE_SIGMA = {
  priced_round: 0.12,
  revenue_multiple: 0,
  profit_multiple: 0,
  capital_raised: 0,
} as const;

const WEIGHT = {
  priced_round: 1,
  revenue_multiple: 0.5,
  profit_multiple: 0.5,
  capital_raised: 0.25,
} as const;

/** A p10/p90 pair, read as the 10th and 90th percentiles of a lognormal. */
function fromBand(low: number, high: number): LogNormal {
  const lo = Math.log(low);
  const hi = Math.log(high);
  return { mu: (lo + hi) / 2, sigma: (hi - lo) / (2 * Z90) };
}

function rangeOf(d: LogNormal): Range {
  return {
    p10: Math.exp(d.mu - Z90 * d.sigma),
    median: Math.exp(d.mu),
    p90: Math.exp(d.mu + Z90 * d.sigma),
  };
}

function scale(d: LogNormal, factor: number): LogNormal {
  return { mu: d.mu + Math.log(factor), sigma: d.sigma };
}

/**
 * Pool independent opinions in log space.
 *
 * The pooled spread is the law of total variance: the weighted mean of each
 * source's own variance, plus the variance *between* their medians. The second
 * term is the point — two sources that disagree produce a wider band than
 * either did alone, rather than a confident average sitting between two
 * numbers that cannot both be right.
 */
function pool(parts: { d: LogNormal; weight: number }[]): LogNormal {
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const mu = parts.reduce((s, p) => s + p.weight * p.d.mu, 0) / total;
  const within = parts.reduce((s, p) => s + p.weight * p.d.sigma ** 2, 0) / total;
  const between = parts.reduce((s, p) => s + p.weight * (p.d.mu - mu) ** 2, 0) / total;
  return { mu, sigma: Math.sqrt(within + between) };
}

/** Multiply two independent lognormals — allocation and DLOM onto value. */
function times(a: LogNormal, b: LogNormal): LogNormal {
  return { mu: a.mu + b.mu, sigma: Math.sqrt(a.sigma ** 2 + b.sigma ** 2) };
}

/** Lognormal density, sampled across the plotted span. */
function densityCurve(d: LogNormal, points = 80): { value: number; density: number }[] {
  const from = d.mu - 3 * d.sigma;
  const to = d.mu + 3 * d.sigma;
  const out: { value: number; density: number }[] = [];
  for (let i = 0; i < points; i++) {
    const x = from + ((to - from) * i) / (points - 1);
    const value = Math.exp(x);
    // Density in log space, which is what a log-scaled x-axis plots.
    const density = Math.exp(-((x - d.mu) ** 2) / (2 * d.sigma ** 2)) / (d.sigma * Math.sqrt(2 * Math.PI));
    out.push({ value, density });
  }
  return out;
}

/** Thrown when nothing usable was supplied — the caller has no evidence. */
export class NoEvidenceError extends Error {
  constructor() {
    super('Enter a round price, profit, revenue, or capital raised.');
    this.name = 'NoEvidenceError';
  }
}

/**
 * Run the estimator. Throws {@link NoEvidenceError} when none of the four
 * evidence fields carries a usable positive figure — an estimate built on the
 * stage alone would be a guess wearing a band, and the caller is told to enter
 * something rather than shown one.
 */
export function estimateFmv(input: EstimatorInput): EstimatorResult {
  const { stage } = input;
  const parts: { d: LogNormal; weight: number; contribution: Omit<EvidenceContribution, 'weight'> }[] = [];

  const positive = (n: number | undefined): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;

  // 1. A priced round: an equity-value observation directly, decayed by age.
  const postMoney = positive(input.post_money);
  const decay = ROUND_AGE_DECAY[input.round_age];
  if (postMoney !== null && input.round_age !== 'never') {
    const d: LogNormal = {
      mu: Math.log(postMoney),
      sigma: BASE_SIGMA.priced_round + decay.addedSigma,
    };
    parts.push({
      d,
      weight: WEIGHT.priced_round * decay.weight,
      contribution: {
        source: 'priced_round',
        label: 'Last priced round',
        implied: rangeOf(d),
        note: decay.note,
      },
    });
  }

  // 2. Trailing revenue against a stage multiple band.
  const revenue = positive(input.revenue_ltm);
  if (revenue !== null) {
    const [lo, hi] = REVENUE_MULTIPLE[stage];
    const d = scale(fromBand(lo, hi), revenue);
    parts.push({
      d,
      weight: WEIGHT.revenue_multiple,
      contribution: {
        source: 'revenue_multiple',
        label: 'Revenue multiple',
        implied: rangeOf(d),
        note: `Trailing revenue at a ${lo}x-${hi}x band for this stage.`,
      },
    });
  }

  // 3. Trailing profit against an earnings multiple band.
  const profit = positive(input.profit_ltm);
  if (profit !== null) {
    const [lo, hi] = PROFIT_MULTIPLE[stage];
    const d = scale(fromBand(lo, hi), profit);
    parts.push({
      d,
      weight: WEIGHT.profit_multiple,
      contribution: {
        source: 'profit_multiple',
        label: 'Earnings multiple',
        implied: rangeOf(d),
        note: `Trailing profit at a ${lo}x-${hi}x band for this stage.`,
      },
    });
  }

  // 4. Capital raised — scale, never a price.
  const raised = positive(input.capital_raised);
  if (raised !== null) {
    const [lo, hi] = CAPITAL_MULTIPLE[stage];
    const d = scale(fromBand(lo, hi), raised);
    parts.push({
      d,
      weight: WEIGHT.capital_raised,
      contribution: {
        source: 'capital_raised',
        label: 'Capital raised',
        implied: rangeOf(d),
        note: 'Supporting evidence of scale, never treated as a market price.',
      },
    });
  }

  if (parts.length === 0) throw new NoEvidenceError();

  const equity = pool(parts);

  // Step 2 — allocation. The stage band is read as a p10/p90 the same way the
  // multiple bands are, so an uncertain waterfall widens the result too.
  const [shareLo, shareHi] = COMMON_SHARE[stage];
  const allocation = times(equity, fromBand(shareLo, shareHi));

  // Step 3 — marketability. A point discount at this resolution; the spread
  // already carried by the two steps above is what a DLOM band would add to.
  const dlom = STAGE_DLOM[stage];
  const fmv = scale(allocation, 1 - dlom);

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const evidence = parts
    .map((p) => ({ ...p.contribution, weight: p.weight / totalWeight }))
    .sort((a, b) => b.weight - a.weight);

  const shares = positive(input.fully_diluted_shares);

  return {
    stage,
    equity_value: rangeOf(equity),
    common_allocation: rangeOf(allocation),
    common_share_band: { low: shareLo, high: shareHi },
    common_fmv: rangeOf(fmv),
    dlom,
    per_share: shares === null ? null : rangeOf(scale(fmv, 1 / shares)),
    evidence,
    curve: densityCurve(equity),
    disclaimer: SAFE_HARBOR_DISCLAIMER,
  };
}
