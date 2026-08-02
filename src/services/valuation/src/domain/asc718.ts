/**
 * ASC 718 stock-based-compensation expense (feature: dual-use reporting).
 *
 * A 409A engagement produces the fair market value of the common stock; ASC
 * 718 reuses that FMV as the grant-date underlying price to measure the
 * grant-date fair value of employee option awards and recognize it as
 * compensation expense over the requisite service (vesting) period.
 *
 * This module is pure — no I/O, no clock (callers pass grant dates and an
 * amortization frequency explicitly) — so the option fair value, the
 * expected-to-vest cost, and the straight-line amortization schedule are all
 * deterministic and unit-testable.
 *
 * Grant-date fair value: Black-Scholes-Merton with a continuous dividend
 * yield (ASC 718-10-55). A Monte-Carlo estimator is provided as an
 * independent cross-check (and the basis for path-dependent awards).
 */

import { normCdf } from './sensitivity.js';
// Shared with the vesting timeline: an amortization bucket and a vesting
// cadence point have to land on the same date, or the expense schedule and the
// vesting schedule disagree about which period a tranche belongs to.
import { addMonths } from './vesting.js';

export type Asc718CompanyType = 'private' | 'public';

export interface Asc718Assumptions {
  /**
   * Issuer type. 'private' resolves the underlying to the concluded 409A FMV
   * (the default); 'public' resolves it to the issuer's observable market price
   * with its own historical volatility (domain/asc718Public.ts). The flag is
   * carried through the result for disclosure; the measurement core is shared.
   */
  companyType?: Asc718CompanyType;
  /** Underlying common-stock fair value at grant (the 409A FMV). */
  grantDateFairValue: number;
  /** Option exercise (strike) price. */
  exercisePrice: number;
  /** Expected term to exercise, in years (SAB 107 simplified or a lattice). */
  expectedTermYears: number;
  /** Annualized expected volatility, e.g. 0.6 for 60%. */
  volatility: number;
  /** Annualized risk-free rate (matched to the expected term). */
  riskFreeRate: number;
  /** Annualized continuous dividend yield; 0 for non-dividend-paying issuers. */
  dividendYield?: number;
}

/**
 * Black-Scholes-Merton call fair value with a continuous dividend yield.
 * Degenerates to intrinsic value as term or volatility → 0.
 */
export function blackScholesMerton(a: Asc718Assumptions): number {
  const {
    grantDateFairValue: s,
    exercisePrice: k,
    expectedTermYears: t,
    volatility: sigma,
    riskFreeRate: r,
  } = a;
  const q = a.dividendYield ?? 0;
  if (s <= 0) return 0;
  if (t <= 0 || sigma <= 0) {
    return Math.max(0, s * Math.exp(-q * Math.max(t, 0)) - k * Math.exp(-r * Math.max(t, 0)));
  }
  if (k <= 0) return s * Math.exp(-q * t);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + (sigma * sigma) / 2) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return s * Math.exp(-q * t) * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2);
}

/**
 * Monte-Carlo grant-date fair value under geometric Brownian motion — an
 * independent check on blackScholesMerton and the hook for path-dependent
 * awards. Deterministic: a small LCG seeded from the assumptions replaces
 * Math.random so the estimate is reproducible.
 */
export function monteCarloFairValue(
  a: Asc718Assumptions,
  opts: { paths?: number; seed?: number } = {},
): number {
  const {
    grantDateFairValue: s,
    exercisePrice: k,
    expectedTermYears: t,
    volatility: sigma,
    riskFreeRate: r,
  } = a;
  const q = a.dividendYield ?? 0;
  if (s <= 0) return 0;
  if (t <= 0 || sigma <= 0) return blackScholesMerton(a);
  const paths = Math.max(1000, Math.min(opts.paths ?? 20000, 200000));
  // Deterministic LCG (Numerical Recipes) + Box-Muller for standard normals.
  let state = (opts.seed ?? 0x9e3779b1) >>> 0;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 4294967297; // (0, 1)
  };
  const drift = (r - q - (sigma * sigma) / 2) * t;
  const vol = sigma * Math.sqrt(t);
  const disc = Math.exp(-r * t);
  let sum = 0;
  for (let i = 0; i < paths; i += 2) {
    const u1 = next();
    const u2 = next();
    const rad = Math.sqrt(-2 * Math.log(u1));
    const z1 = rad * Math.cos(2 * Math.PI * u2);
    const z2 = rad * Math.sin(2 * Math.PI * u2);
    for (const z of [z1, z2]) {
      const sT = s * Math.exp(drift + vol * z);
      sum += Math.max(0, sT - k);
    }
  }
  return disc * (sum / paths);
}

export interface AmortizationPeriod {
  index: number;
  startMonth: number;
  endMonth: number;
  startDate: string;
  endDate: string;
  /** Expense recognized in this period. */
  expense: number;
  /** Cumulative expense recognized through this period. */
  cumulative: number;
  /** Unrecognized cost remaining after this period. */
  remaining: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Straight-line amortization of `totalCost` over `vestingMonths`, bucketed at
 * `frequencyMonths` (12 = annual, 1 = monthly). Compensation cost accrues
 * ratably; the final bucket absorbs any rounding so the schedule sums exactly
 * to `totalCost`.
 */
export function amortizationSchedule(
  totalCost: number,
  grantDate: string,
  vestingMonths: number,
  frequencyMonths = 12,
): AmortizationPeriod[] {
  if (vestingMonths <= 0) {
    return [
      {
        index: 0,
        startMonth: 0,
        endMonth: 0,
        startDate: grantDate.slice(0, 10),
        endDate: grantDate.slice(0, 10),
        expense: round2(totalCost),
        cumulative: round2(totalCost),
        remaining: 0,
      },
    ];
  }
  const freq = Math.max(1, Math.floor(frequencyMonths));
  const perMonth = totalCost / vestingMonths;
  const periods: AmortizationPeriod[] = [];
  let cumulative = 0;
  let index = 0;
  for (let start = 0; start < vestingMonths; start += freq) {
    const end = Math.min(start + freq, vestingMonths);
    const isLast = end >= vestingMonths;
    const months = end - start;
    // The last period absorbs residual rounding so Σ expense == totalCost.
    const expense = isLast ? round2(totalCost - cumulative) : round2(perMonth * months);
    cumulative = round2(cumulative + expense);
    periods.push({
      index,
      startMonth: start,
      endMonth: end,
      startDate: addMonths(grantDate, start),
      endDate: addMonths(grantDate, end),
      expense,
      cumulative,
      remaining: round2(totalCost - cumulative),
    });
    index += 1;
  }
  return periods;
}

export interface Asc718Grant {
  /** Optional label carried through to the result. */
  label?: string;
  /** Options granted. */
  optionsGranted: number;
  grantDate: string;
  vestingMonths: number;
  assumptions: Asc718Assumptions;
  /** Expected annual pre-vest forfeiture rate (0–1); reduces the accrued cost. */
  forfeitureRate?: number;
  /** Amortization bucket size in months (default 12 = annual). */
  amortizationFrequencyMonths?: number;
}

export interface Asc718Result {
  label: string | null;
  fairValuePerOption: number;
  optionsGranted: number;
  /** Options expected to vest after applying the forfeiture rate. */
  expectedToVestOptions: number;
  /** Grant-date fair value of all options granted (gross). */
  grossFairValue: number;
  /** Compensation cost to recognize (net of expected forfeitures). */
  totalCompensationCost: number;
  schedule: AmortizationPeriod[];
  assumptions: Asc718Assumptions & { dividendYield: number };
}

/**
 * Full ASC 718 measurement for one option grant: grant-date fair value per
 * option, the expected-to-vest compensation cost, and its straight-line
 * amortization schedule over the vesting period.
 */
export function asc718Grant(grant: Asc718Grant): Asc718Result {
  const forfeiture = Math.min(Math.max(grant.forfeitureRate ?? 0, 0), 1);
  const fairValuePerOption = blackScholesMerton(grant.assumptions);
  const options = Math.max(0, grant.optionsGranted);
  const expectedToVest = options * (1 - forfeiture);
  const grossFairValue = round2(fairValuePerOption * options);
  const totalCost = round2(fairValuePerOption * expectedToVest);
  return {
    label: grant.label ?? null,
    fairValuePerOption: Math.round(fairValuePerOption * 10000) / 10000,
    optionsGranted: options,
    expectedToVestOptions: Math.round(expectedToVest),
    grossFairValue,
    totalCompensationCost: totalCost,
    schedule: amortizationSchedule(
      totalCost,
      grant.grantDate,
      grant.vestingMonths,
      grant.amortizationFrequencyMonths ?? 12,
    ),
    assumptions: { ...grant.assumptions, dividendYield: grant.assumptions.dividendYield ?? 0 },
  };
}

export interface Asc718Portfolio {
  grants: Asc718Result[];
  /** Grant-date fair value across all grants (net of forfeitures). */
  totalCompensationCost: number;
  /** Straight-line expense aggregated by fiscal year offset from each grant. */
  expenseByYear: Array<{ year: number; expense: number; cumulative: number }>;
}

/**
 * Aggregate several grants into a portfolio expense view. `expenseByYear`
 * sums each grant's annual expense into year-from-grant buckets (year 1 = the
 * first twelve months of service), which is what the ASC 718 report note
 * tabulates.
 */
export function asc718Portfolio(grants: Asc718Grant[]): Asc718Portfolio {
  const results = grants.map(asc718Grant);
  const totalCost = round2(results.reduce((sum, r) => sum + r.totalCompensationCost, 0));

  const byYear = new Map<number, number>();
  for (const r of results) {
    for (const p of r.schedule) {
      // Bucket by the service year the period falls in (month 0–11 → year 1).
      const year = Math.floor(p.startMonth / 12) + 1;
      byYear.set(year, (byYear.get(year) ?? 0) + p.expense);
    }
  }
  let cumulative = 0;
  const expenseByYear = [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const expense = round2(byYear.get(year) ?? 0);
      cumulative = round2(cumulative + expense);
      return { year, expense, cumulative };
    });

  return { grants: results, totalCompensationCost: totalCost, expenseByYear };
}
