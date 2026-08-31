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
  /**
   * Expected *annual* pre-vest forfeiture rate (0–1); compounds over the
   * vesting period to reduce the accrued cost. See expectedToVestFraction.
   */
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
 * Share of a grant still expected to be held at the end of the requisite
 * service period, given an *annual* pre-vest forfeiture rate.
 *
 * The rate is estimated and disclosed per year — "we expect 10% annual
 * turnover" — but it is survival over the whole vesting period that reduces the
 * cost, so it compounds: (1 − rate) ^ years. Applying the annual figure once
 * treats four years of turnover as one year of it. On the standard 4-year vest
 * that is 90% surviving where 65.6% is expected, and compensation cost is
 * overstated by more than a third — in the direction that inflates reported
 * expense, straight into the ASC 718 note and the client's income statement.
 *
 * A grant that vests immediately has no service period to leave during, so it
 * forfeits nothing; `Math.pow(x, 0) === 1` gives that for free, including for a
 * 100% rate.
 */
export function expectedToVestFraction(annualForfeitureRate: number, vestingMonths: number): number {
  const rate = Math.min(Math.max(annualForfeitureRate, 0), 1);
  const years = Math.max(0, vestingMonths) / 12;
  return Math.pow(1 - rate, years);
}

/**
 * Full ASC 718 measurement for one option grant: grant-date fair value per
 * option, the expected-to-vest compensation cost, and its straight-line
 * amortization schedule over the vesting period.
 */
export function asc718Grant(grant: Asc718Grant): Asc718Result {
  const fairValuePerOption = blackScholesMerton(grant.assumptions);
  const options = Math.max(0, grant.optionsGranted);
  const expectedToVest = options * expectedToVestFraction(grant.forfeitureRate ?? 0, grant.vestingMonths);
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

export interface Asc718YearExpense {
  /** The calendar year itself — 2027, not "year 2". */
  year: number;
  /** Expense recognized in that year, across every grant in the portfolio. */
  expense: number;
  /** Cumulative expense recognized through the end of that year. */
  cumulative: number;
}

export interface Asc718Portfolio {
  grants: Asc718Result[];
  /** Grant-date fair value across all grants (net of forfeitures). */
  totalCompensationCost: number;
  /**
   * Straight-line expense summed into the calendar years it is recognized in.
   *
   * See `asc718Portfolio` for why this is a calendar year rather than a
   * service year, and `periodByCalendarYear` for how a period that straddles
   * 31 December is divided.
   */
  expenseByCalendarYear: Asc718YearExpense[];
}

/**
 * One amortization period's expense, divided among the calendar years its
 * months fall in.
 *
 * Compensation cost accrues ratably over the requisite service period, and the
 * unit it accrues in is a **whole service month**, counted from the period's
 * own start date and attributed to the calendar year that month *begins* in.
 * An annual bucket running 15 July 2026 to 15 July 2027 is therefore six months
 * in each year: the sixth of them runs 15 December to 15 January and goes to
 * 2026 entire. Only a bucket starting on the first of a month divides on the
 * year boundary itself.
 *
 * Whole months rather than days, and it is a choice rather than an accident —
 * the frequency of the schedule is a disclosure granularity and not a
 * measurement, so monthly and annual buckets have to put the same cost in the
 * same year (`asc718Portfolio`'s own test asserts exactly that), and a monthly
 * bucket has no smaller piece to divide. The prose here used to describe a
 * half-month split the code has never performed, which is the kind of sentence
 * somebody reconciles a disclosure against.
 *
 * The last month absorbs the residual, so the pieces sum to the period exactly
 * and the year totals still sum to `totalCompensationCost`.
 *
 * The year is read from `addMonths`, which clamps the day of month rather than
 * overflowing it — but clamping only ever moves a date *within* its target
 * month, so it can never carry a month across a year boundary. The year is
 * whatever the month arithmetic says it is.
 */
function periodByCalendarYear(p: AmortizationPeriod): Array<[year: number, expense: number]> {
  // `endMonth === startMonth` only for the degenerate zero-month schedule,
  // whose single period is recognized whole on the grant date.
  const months = Math.max(1, p.endMonth - p.startMonth);
  const share = p.expense / months;
  const out: Array<[number, number]> = [];
  let assigned = 0;
  for (let k = 0; k < months; k++) {
    const slice = k === months - 1 ? round2(p.expense - assigned) : round2(share);
    assigned = round2(assigned + slice);
    out.push([Number(addMonths(p.startDate, k).slice(0, 4)), slice]);
  }
  return out;
}

/**
 * Aggregate several grants into a portfolio expense view.
 *
 * `expenseByCalendarYear` is keyed on the calendar year the expense lands in.
 * It used to be keyed on the service year — `Math.floor(startMonth / 12) + 1`,
 * counted from each grant's own grant date — which is right for one grant and
 * wrong for a portfolio, because the offsets are counted from different days.
 * A company that granted in 2021 and again in 2026 had both first years summed
 * into a row called "Service year 1", and the resulting four-row table implied
 * the whole programme was expensed over four years when recognition actually
 * ran from 2021 to 2030. Nothing in the table said which four. The ASC 718
 * note discloses expense by reporting period, and a reporting period is a
 * date range, not an offset.
 *
 * Years with no expense are omitted rather than filled with zeroes. Under
 * service-year keys a gap was invisible and misread as continuity; under
 * calendar-year keys every row names its own year, so a jump from 2024 to 2030
 * reads as the gap it is.
 */
export function asc718Portfolio(grants: Asc718Grant[]): Asc718Portfolio {
  const results = grants.map(asc718Grant);
  const totalCost = round2(results.reduce((sum, r) => sum + r.totalCompensationCost, 0));

  const byYear = new Map<number, number>();
  for (const r of results) {
    for (const p of r.schedule) {
      for (const [year, expense] of periodByCalendarYear(p)) {
        byYear.set(year, round2((byYear.get(year) ?? 0) + expense));
      }
    }
  }
  let cumulative = 0;
  const expenseByCalendarYear = [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const expense = round2(byYear.get(year) ?? 0);
      cumulative = round2(cumulative + expense);
      return { year, expense, cumulative };
    });

  return { grants: results, totalCompensationCost: totalCost, expenseByCalendarYear };
}
