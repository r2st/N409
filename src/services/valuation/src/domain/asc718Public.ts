/**
 * ASC 718 public-company extensions (feature: ASC 718 Public).
 *
 * The private-company core (domain/asc718.ts) measures option grants off the
 * concluded 409A FMV with a SAB 107 simplified term and peer-derived
 * volatility. A public issuer differs in ways that this module adds *without*
 * forking the measurement core:
 *
 *   - the underlying is the issuer's own observable market price;
 *   - expected volatility is the issuer's own historical volatility;
 *   - expected term can come from a lattice (exercise-behaviour) model or from
 *     the issuer's actual historical exercise data, not only SAB 107;
 *   - public issuers grant award types private companies do not — ESPPs (with a
 *     lookback discount), RSUs at market, and performance / market-condition
 *     and relative-TSR awards that require Monte-Carlo.
 *
 * Everything here is pure and deterministic (Monte-Carlo paths run off a seeded
 * LCG) so the fair values are reproducible and unit-testable, exactly like the
 * private core it complements.
 */

import { blackScholesMerton, type Asc718Assumptions } from './asc718.js';

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Per-request simulation budget ───────────────────────────────────────────

/** Default path counts, so a caller can price the work before spending it. */
export const DEFAULT_MC_PATHS = {
  performanceRsu: 20_000,
  marketConditionRsu: 40_000,
  relativeTsr: 30_000,
} as const;

/** Below this a Monte-Carlo estimate stops being worth reporting. */
export const MIN_MC_PATHS = 1_000;

/**
 * Standard normals one ASC 718 compute may draw.
 *
 * Every estimator here is a synchronous `for` loop, so its cost is charged to
 * the event loop of a single-threaded process and no request timeout can
 * interrupt it: while it runs, *every other* request on the box — including
 * /health — waits. That makes the total work one request can ask for a shared
 * resource rather than its own problem.
 *
 * The route's own schema caps award counts, but those caps multiply: 20 TSR
 * awards × 50 peers × 30,000 paths is 30.6 million normal draws, measured at
 * 1.9 seconds of uninterruptible CPU for one ops request. The per-award caps
 * cannot see each other, so no combination of them expresses "and not all at
 * once".
 *
 * 4 million draws is ~250 ms on the same measurement — under a quarter second
 * of stall in the worst case, and far above what any single award asks for, so
 * an ordinary request is scaled by exactly 1 and its numbers do not move.
 */
export const MC_DRAW_BUDGET = 4_000_000;

/**
 * How far to scale every award's path count so the request fits the budget.
 *
 * Scaling rather than refusing: the estimators converge as 1/√paths, so a
 * request asking for eight times the budget gets a still-usable estimate at a
 * third of the standard error it would have had, instead of a 422 telling an
 * analyst their perfectly legal batch is too big. The effective path count is
 * reported back so a reviewer can see what the number rests on.
 */
export function monteCarloScale(requestedDraws: number, budget: number = MC_DRAW_BUDGET): number {
  if (!Number.isFinite(requestedDraws) || requestedDraws <= 0) return 1;
  return requestedDraws <= budget ? 1 : budget / requestedDraws;
}

/** Apply a scale to one award's path count, never below MIN_MC_PATHS. */
export function scaleMonteCarloPaths(paths: number, scale: number): number {
  if (scale >= 1) return paths;
  return Math.max(MIN_MC_PATHS, Math.floor(paths * scale));
}

// ── Deterministic standard-normal generator ─────────────────────────────────

/**
 * A seeded generator of standard normals (Numerical-Recipes LCG + Box-Muller),
 * matching the estimator in domain/asc718.ts. Returns a closure so callers pull
 * one z at a time; reproducible for a given seed.
 */
export function standardNormals(seed = 0x9e3779b1): () => number {
  let state = seed >>> 0;
  let spare: number | null = null;
  const nextUniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 4294967297; // (0, 1)
  };
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u1 = nextUniform();
    const u2 = nextUniform();
    const rad = Math.sqrt(-2 * Math.log(u1));
    spare = rad * Math.sin(2 * Math.PI * u2);
    return rad * Math.cos(2 * Math.PI * u2);
  };
}

// ── Expected-term methods ───────────────────────────────────────────────────

/**
 * SAB 107 / SAB 110 simplified expected term: the midpoint of the vesting
 * period and the full contractual term, ((vesting + contractual) / 2). Valid
 * for "plain-vanilla" service-vesting options only.
 */
export function simplifiedExpectedTerm(vestingYears: number, contractualYears: number): number {
  const v = Math.max(0, vestingYears);
  const c = Math.max(v, contractualYears);
  return round4((v + c) / 2);
}

/**
 * Expected term from the issuer's actual exercise history: the share-weighted
 * average time from grant to exercise. `exercises` pairs a time-to-exercise (in
 * years) with the number of options exercised at that time.
 */
export function historicalExpectedTerm(exercises: Array<{ years: number; options: number }>): number {
  let wsum = 0;
  let w = 0;
  for (const e of exercises) {
    const options = Math.max(0, e.options);
    wsum += Math.max(0, e.years) * options;
    w += options;
  }
  if (w <= 0) throw new Error('historicalExpectedTerm needs at least one exercised option');
  return round4(wsum / w);
}

export interface LatticeResult {
  fairValue: number;
  /** Probability-weighted time (years) to exercise or expiry. */
  expectedTermYears: number;
}

/**
 * Cox-Ross-Rubinstein binomial lattice with employee sub-optimal early
 * exercise (Hull-White style): once vested, an employee exercises as soon as
 * the stock reaches `exerciseMultiple × strike`. Returns both the grant-date
 * fair value and the probability-weighted expected term the lattice implies —
 * the exercise-behaviour term public issuers disclose in place of SAB 107.
 *
 * A constant annual post-vesting exit rate optionally forfeits still-unexercised
 * options each step (they lapse worthless once out-of-the-money, or are exercised
 * if in-the-money), which pulls the expected term in as issuers observe.
 */
export function binomialLattice(args: {
  underlying: number;
  strike: number;
  contractualTermYears: number;
  vestingYears: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield?: number;
  exerciseMultiple?: number;
  steps?: number;
  postVestExitRate?: number;
}): LatticeResult {
  const s0 = args.underlying;
  const k = args.strike;
  const T = args.contractualTermYears;
  const sigma = args.volatility;
  const r = args.riskFreeRate;
  const q = args.dividendYield ?? 0;
  const m = args.exerciseMultiple ?? 2.0;
  const N = Math.max(10, Math.min(Math.floor(args.steps ?? 200), 2000));
  if (s0 <= 0) return { fairValue: 0, expectedTermYears: 0 };
  if (T <= 0 || sigma <= 0) {
    return { fairValue: Math.max(0, s0 - k), expectedTermYears: round4(Math.max(0, T)) };
  }
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  const pClamped = Math.min(Math.max(p, 0), 1);
  const vestStep = Math.min(N, Math.ceil((args.vestingYears / T) * N));
  const exitPerStep = Math.min(Math.max(args.postVestExitRate ?? 0, 0), 1) * dt;

  // Backward induction for value; forward sweep for the expected term.
  let value = new Array<number>(N + 1).fill(0);
  const price = (i: number, j: number) => s0 * u ** j * d ** (i - j);
  for (let j = 0; j <= N; j++) value[j] = Math.max(0, price(N, j) - k);
  // Record, per step, whether an exercisable node triggers exercise, so the
  // forward pass can attribute probability mass to an exercise time.
  const exercisesAt: boolean[][] = [];
  for (let i = N - 1; i >= 0; i--) {
    const next = new Array<number>(i + 1).fill(0);
    const flags = new Array<boolean>(i + 1).fill(false);
    for (let j = 0; j <= i; j++) {
      const cont = disc * (pClamped * (value[j + 1] ?? 0) + (1 - pClamped) * (value[j] ?? 0));
      const s = price(i, j);
      const vested = i >= vestStep;
      // Hull-White sub-optimal exercise: once vested, the employee exercises as
      // soon as the barrier is reached, *even when continuation is worth more*.
      // That forced early exercise (not an optimality test) is what lowers the
      // grant-date fair value relative to a freely-traded option.
      if (vested && s >= m * k) {
        next[j] = s - k;
        flags[j] = true;
      } else {
        next[j] = cont;
        flags[j] = false;
      }
    }
    exercisesAt[i] = flags;
    value = next;
  }
  const fairValue = value[0] ?? 0;

  // Forward probability sweep: propagate mass down the tree, absorbing it at
  // exercise nodes (and at maturity) to build the expected exit time.
  let prob = [1];
  let expTerm = 0;
  let absorbed = 0;
  for (let i = 0; i < N; i++) {
    const nextProb = new Array<number>(i + 2).fill(0);
    const flags = exercisesAt[i] ?? [];
    for (let j = 0; j <= i; j++) {
      const mass = prob[j] ?? 0;
      if (mass <= 0) continue;
      if (flags[j]) {
        expTerm += mass * i * dt;
        absorbed += mass;
      } else {
        nextProb[j + 1] = (nextProb[j + 1] ?? 0) + mass * pClamped;
        nextProb[j] = (nextProb[j] ?? 0) + mass * (1 - pClamped);
      }
    }
    // Constant post-vest exit hazard: a slice of surviving in-the-money mass
    // exercises early each step once vested.
    if (i + 1 >= vestStep && exitPerStep > 0) {
      for (let j = 0; j <= i + 1; j++) {
        const s = price(i + 1, j);
        const here = nextProb[j] ?? 0;
        if (s > k && here > 0) {
          const leave = here * exitPerStep;
          nextProb[j] = here - leave;
          expTerm += leave * (i + 1) * dt;
          absorbed += leave;
        }
      }
    }
    prob = nextProb;
  }
  // Remaining mass reaches maturity.
  for (let j = 0; j < prob.length; j++) {
    const mass = prob[j] ?? 0;
    if (mass > 0) {
      expTerm += mass * T;
      absorbed += mass;
    }
  }
  const expectedTermYears = absorbed > 0 ? expTerm / absorbed : T;
  return { fairValue: round4(fairValue), expectedTermYears: round4(expectedTermYears) };
}

// ── Historical volatility (issuer's own stock) ──────────────────────────────

/**
 * Annualised historical volatility from a close-price series — the public
 * issuer's own expected volatility, replacing the peer-derived input the
 * private module uses. Std-dev of log returns × √(periods per year); daily
 * closes → 252, monthly → 12.
 */
export function historicalVolatility(closes: number[], periodsPerYear = 252): number {
  const usable = closes.filter((c) => c > 0);
  // Three closes, not two.
  //
  // The statistic is a *sample* standard deviation, so it needs two returns and
  // therefore three prices. Two closes cleared this check, produced one return,
  // and divided by `returns.length - 1` === 0 — and the numerator is zero too,
  // so the answer was `NaN` rather than an error or an Infinity. NaN is not
  // nullish and is not caught by any `> 0` refusal, so it flowed into
  // Black-Scholes and landed a `null` fair value on a 200.
  //
  // `routes/asc718.ts` already refuses a two-close series before calling in,
  // and has since R305 — but the guard belongs to the statistic, not to one of
  // its callers, and the engine's own `volatility.historical_volatility` has
  // asked for three prices since it was written. This is the two halves
  // agreeing rather than a second opinion about the same question.
  if (usable.length < 3) {
    throw new Error('historicalVolatility needs at least three positive closes (two returns)');
  }
  const returns: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const cur = usable[i]!;
    const prev = usable[i - 1]!;
    returns.push(Math.log(cur / prev));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return round4(Math.sqrt(variance) * Math.sqrt(periodsPerYear));
}

// ── ESPP (§423 plan with lookback + purchase discount) ──────────────────────

export interface EsppAssumptions {
  /** Enrolment-date (grant-date) market price per share. */
  grantDatePrice: number;
  /** Purchase discount, e.g. 0.15 for 15%. */
  discountPct: number;
  /** Look-back / offering period in months. */
  lookbackMonths: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield?: number;
}

export interface EsppFairValue {
  fairValuePerShare: number;
  /** ASC 718-50 component decomposition, per enrolled share. */
  components: {
    /** discount% of the grant-date price — the value of the built-in discount. */
    purchaseDiscount: number;
    /** (1 − discount%) of an at-the-money call — the look-back's upside. */
    callComponent: number;
    /** discount% of an at-the-money put — the look-back's downside protection. */
    putComponent: number;
  };
}

/**
 * Grant-date fair value of one share purchasable under a §423 ESPP with a
 * look-back provision (ASC 718-50 illustration): the built-in discount plus a
 * fraction of a call and of a put struck at the grant-date price over the
 * offering period.
 *
 *   FV = d·S + (1 − d)·Call(S, K=S, T) + d·Put(S, K=S, T)
 */
export function esppFairValue(a: EsppAssumptions): EsppFairValue {
  const s = a.grantDatePrice;
  const d = Math.min(Math.max(a.discountPct, 0), 1);
  const t = Math.max(0, a.lookbackMonths) / 12;
  const assumptions: Asc718Assumptions = {
    grantDateFairValue: s,
    exercisePrice: s,
    expectedTermYears: t,
    volatility: a.volatility,
    riskFreeRate: a.riskFreeRate,
    dividendYield: a.dividendYield,
  };
  const call = blackScholesMerton(assumptions);
  // Put via put-call parity with a continuous dividend yield.
  const q = a.dividendYield ?? 0;
  const put = t <= 0 ? Math.max(0, s - s) : call - s * Math.exp(-q * t) + s * Math.exp(-a.riskFreeRate * t);
  const purchaseDiscount = d * s;
  const callComponent = (1 - d) * call;
  const putComponent = d * Math.max(0, put);
  // The stated fair value is the sum of the *stated* components, not a
  // separately rounded sum of the unrounded ones.
  //
  // The ASC 718-50 decomposition is published as an addition — the tab draws
  // "FV/share | Discount | Call | Put" on one row and the reader checks the
  // first against the other three — and each of the four is stated to four
  // decimals. Rounding each component and the total independently leaves a
  // residual of up to 1.5e-4, so the row could print a discount, a call and a
  // put that add to one figure beside a fair value of another: three numbers
  // each individually right and an addition that is visibly wrong, on the
  // schedule whose whole content is that addition. (It was invisible while the
  // tab printed all four at two decimals, which is not the same as absent.)
  //
  // Closed by making the components the authority rather than by pushing the
  // residual into one of them: each is a figure a reviewer recomputes directly
  // — d·S, (1−d)·Call, d·Put — and a component carrying somebody else's
  // rounding is no longer that. The conclusion moves by at most $0.00015 a
  // share, and `total_fair_value` follows it.
  const components = {
    purchaseDiscount: round4(purchaseDiscount),
    callComponent: round4(callComponent),
    putComponent: round4(putComponent),
  };
  return {
    fairValuePerShare: round4(
      components.purchaseDiscount + components.callComponent + components.putComponent,
    ),
    components,
  };
}

// ── RSUs ────────────────────────────────────────────────────────────────────

/**
 * Service-only RSU grant-date fair value: simply the market price at grant,
 * less the present value of dividends forgone during vesting when the holder is
 * not entitled to them (ASC 718 — no option pricing required).
 */
export function rsuMarketFairValue(
  marketPrice: number,
  opts: { vestingYears?: number; dividendYield?: number; dividendProtected?: boolean } = {},
): number {
  const q = opts.dividendYield ?? 0;
  const t = opts.vestingYears ?? 0;
  if (opts.dividendProtected || q <= 0 || t <= 0) return round4(Math.max(0, marketPrice));
  return round4(marketPrice * Math.exp(-q * t));
}

/**
 * Performance-condition RSU: under ASC 718 a *performance* (non-market)
 * condition does not enter the grant-date fair value — it governs how many
 * units are expected to vest. We Monte-Carlo the performance outcome against
 * its target to derive an expected achievement (and hence payout ratio), then
 * value the expected-to-vest units at the market price. Achievement is modelled
 * as a lognormal draw of the metric around `expectedAttainment` with
 * `attainmentVolatility`, capped by `maxPayoutRatio`.
 */
export function performanceRsuMonteCarlo(args: {
  marketPrice: number;
  targetUnits: number;
  expectedAttainment: number;
  attainmentVolatility: number;
  maxPayoutRatio?: number;
  paths?: number;
  seed?: number;
}): {
  fairValuePerUnit: number;
  expectedPayoutRatio: number;
  expectedToVestUnits: number;
  totalFairValue: number;
} {
  const paths = Math.max(1000, Math.min(args.paths ?? 20000, 200000));
  const cap = args.maxPayoutRatio ?? 2;
  const z = standardNormals(args.seed ?? 0x51ed270b);
  const sigma = Math.max(0, args.attainmentVolatility);
  const mu = Math.log(Math.max(args.expectedAttainment, 1e-9)) - (sigma * sigma) / 2;
  let sum = 0;
  for (let i = 0; i < paths; i++) {
    const attainment = Math.exp(mu + sigma * z());
    sum += Math.min(Math.max(attainment, 0), cap);
  }
  const expectedPayoutRatio = round4(sum / paths);
  const fairValuePerUnit = round4(Math.max(0, args.marketPrice));
  const expectedToVestUnits = Math.round(args.targetUnits * expectedPayoutRatio);
  return {
    fairValuePerUnit,
    expectedPayoutRatio,
    expectedToVestUnits,
    totalFairValue: round2(fairValuePerUnit * expectedToVestUnits),
  };
}

/**
 * Market-condition RSU (e.g. a stock-price hurdle): a *market* condition IS
 * reflected in the grant-date fair value, so we Monte-Carlo the issuer's stock
 * path and value the payoff conditional on the hurdle being met at vesting.
 * Payout = units if the terminal price ≥ hurdle, discounted at the risk-free
 * rate; the resulting per-unit value already embeds the probability of meeting
 * the condition (no separate probability weighting of expense).
 */
export function marketConditionRsuMonteCarlo(args: {
  underlying: number;
  hurdlePrice: number;
  vestingYears: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield?: number;
  paths?: number;
  seed?: number;
}): { fairValuePerUnit: number; probabilityMet: number } {
  const s0 = args.underlying;
  const t = args.vestingYears;
  const sigma = args.volatility;
  const r = args.riskFreeRate;
  const q = args.dividendYield ?? 0;
  if (s0 <= 0 || t <= 0 || sigma <= 0) {
    const met = s0 >= args.hurdlePrice ? 1 : 0;
    return { fairValuePerUnit: round4(met * s0), probabilityMet: met };
  }
  const paths = Math.max(1000, Math.min(args.paths ?? 40000, 400000));
  const z = standardNormals(args.seed ?? 0x2f8b1c33);
  const drift = (r - q - (sigma * sigma) / 2) * t;
  const vol = sigma * Math.sqrt(t);
  const disc = Math.exp(-r * t);
  let payoff = 0;
  let met = 0;
  for (let i = 0; i < paths; i++) {
    const sT = s0 * Math.exp(drift + vol * z());
    if (sT >= args.hurdlePrice) {
      payoff += sT; // one unit delivers one share worth sT
      met += 1;
    }
  }
  return {
    fairValuePerUnit: round4(disc * (payoff / paths)),
    probabilityMet: round4(met / paths),
  };
}

// ── Relative TSR (peer-basket Monte-Carlo) ──────────────────────────────────

export interface TsrPeer {
  name: string;
  /** Annualised volatility of this peer's total return. */
  volatility: number;
  /** Average pairwise correlation of this peer with the others (0–1). */
  correlation?: number;
  dividendYield?: number;
}

export interface TsrPayoutTier {
  /** Inclusive lower percentile rank (0–100) for this tier. */
  percentile: number;
  /** Payout ratio of target units at/above this percentile. */
  payoutRatio: number;
}

/**
 * Relative TSR award (market condition): Monte-Carlo of correlated total-return
 * paths for the subject and a peer basket. Each path ranks the subject's TSR
 * against its peers, maps the percentile rank to a payout ratio via a step
 * schedule, and delivers that many shares at the terminal price. The discounted
 * average is the grant-date fair value per target unit.
 *
 * Correlation is modelled with a single-factor structure: each peer's shock is
 * √ρ · common + √(1−ρ) · idiosyncratic, with ρ its supplied correlation
 * (default 0.3) — enough to capture co-movement without a full covariance
 * matrix.
 */
export function relativeTsrMonteCarlo(args: {
  subject: { underlying: number; volatility: number; dividendYield?: number };
  peers: TsrPeer[];
  performancePeriodYears: number;
  riskFreeRate: number;
  payoutSchedule: TsrPayoutTier[];
  paths?: number;
  seed?: number;
}): { fairValuePerUnit: number; expectedPayoutRatio: number; expectedPercentile: number } {
  const { subject, peers } = args;
  const t = args.performancePeriodYears;
  const r = args.riskFreeRate;
  if (subject.underlying <= 0 || t <= 0 || peers.length === 0) {
    return {
      fairValuePerUnit: round4(Math.max(0, subject.underlying)),
      expectedPayoutRatio: 0,
      expectedPercentile: 0,
    };
  }
  const paths = Math.max(1000, Math.min(args.paths ?? 30000, 300000));
  const z = standardNormals(args.seed ?? 0x6d2b79f5);
  const disc = Math.exp(-r * t);
  const sqrtT = Math.sqrt(t);
  const schedule = [...args.payoutSchedule].sort((a, b) => b.percentile - a.percentile);

  // Total return over the period from a GBM shock (risk-neutral drift so the
  // subject's own delivered value is consistent with market-condition pricing).
  const totalReturn = (vol: number, q: number, shock: number) =>
    Math.exp((r - q - (vol * vol) / 2) * t + vol * sqrtT * shock) - 1;

  let payoutSum = 0;
  let percentileSum = 0;
  let valueSum = 0;
  const subjRho = 0.3;
  for (let i = 0; i < paths; i++) {
    const common = z();
    const subjShock = Math.sqrt(subjRho) * common + Math.sqrt(1 - subjRho) * z();
    const subjTsr = totalReturn(subject.volatility, subject.dividendYield ?? 0, subjShock);
    let below = 0;
    for (const peer of peers) {
      const rho = Math.min(Math.max(peer.correlation ?? 0.3, 0), 0.99);
      const shock = Math.sqrt(rho) * common + Math.sqrt(1 - rho) * z();
      const peerTsr = totalReturn(peer.volatility, peer.dividendYield ?? 0, shock);
      if (peerTsr < subjTsr) below += 1;
    }
    // Percentile rank of the subject within the full basket (subject + peers).
    const percentile = (below / peers.length) * 100;
    percentileSum += percentile;
    let payout = 0;
    for (const tier of schedule) {
      if (percentile >= tier.percentile) {
        payout = tier.payoutRatio;
        break;
      }
    }
    payoutSum += payout;
    const subjTerminal = subject.underlying * (1 + subjTsr);
    valueSum += payout * subjTerminal;
  }
  return {
    fairValuePerUnit: round4(disc * (valueSum / paths)),
    expectedPayoutRatio: round4(payoutSum / paths),
    expectedPercentile: round4(percentileSum / paths),
  };
}
