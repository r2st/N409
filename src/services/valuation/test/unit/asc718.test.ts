import { describe, expect, it } from 'vitest';
import {
  amortizationSchedule,
  asc718Grant,
  asc718Portfolio,
  blackScholesMerton,
  expectedToVestFraction,
  monteCarloFairValue,
  type Asc718Assumptions,
} from '../../src/domain/asc718.js';

describe('ASC 718 grant-date fair value', () => {
  const textbook = {
    grantDateFairValue: 100,
    exercisePrice: 100,
    expectedTermYears: 1,
    volatility: 0.2,
    riskFreeRate: 0.05,
  };

  it('Black-Scholes-Merton matches the Hull reference (no dividend)', () => {
    // S=100, K=100, σ=20%, T=1y, r=5%, q=0 → C ≈ 10.4506.
    expect(blackScholesMerton(textbook)).toBeCloseTo(10.4506, 3);
  });

  it('a dividend yield lowers the option value', () => {
    const withDiv = blackScholesMerton({ ...textbook, dividendYield: 0.03 });
    expect(withDiv).toBeLessThan(blackScholesMerton(textbook));
    expect(withDiv).toBeGreaterThan(0);
  });

  it('degenerates to intrinsic value at zero term / zero volatility', () => {
    expect(
      blackScholesMerton({ ...textbook, expectedTermYears: 0, volatility: 0, grantDateFairValue: 120 }),
    ).toBeCloseTo(20, 6);
    expect(blackScholesMerton({ ...textbook, expectedTermYears: 0, volatility: 0 })).toBeCloseTo(0, 6);
  });

  it('Monte-Carlo estimate agrees with Black-Scholes and is deterministic', () => {
    const mc1 = monteCarloFairValue(textbook, { paths: 40000, seed: 7 });
    const mc2 = monteCarloFairValue(textbook, { paths: 40000, seed: 7 });
    expect(mc1).toBe(mc2); // reproducible
    expect(mc1).toBeCloseTo(blackScholesMerton(textbook), 0); // within ~$1
  });
});

describe('straight-line amortization schedule', () => {
  it('spreads cost evenly and sums exactly to the total', () => {
    const schedule = amortizationSchedule(10000, '2026-01-01', 48, 12);
    expect(schedule).toHaveLength(4);
    for (const p of schedule) expect(p.expense).toBeCloseTo(2500, 2);
    expect(schedule[3]!.cumulative).toBeCloseTo(10000, 2);
    expect(schedule[3]!.remaining).toBeCloseTo(0, 2);
    expect(schedule[0]!.startDate).toBe('2026-01-01');
    expect(schedule[3]!.endDate).toBe('2030-01-01');
  });

  it('handles a partial final period and absorbs rounding', () => {
    const schedule = amortizationSchedule(10000, '2026-01-01', 30, 12);
    // 30 months annual → 12 + 12 + 6.
    expect(schedule).toHaveLength(3);
    expect(schedule[2]!.startMonth).toBe(24);
    expect(schedule[2]!.endMonth).toBe(30);
    const total = schedule.reduce((s, p) => s + p.expense, 0);
    expect(total).toBeCloseTo(10000, 2);
  });

  it('supports monthly buckets', () => {
    const schedule = amortizationSchedule(1200, '2026-01-01', 12, 1);
    expect(schedule).toHaveLength(12);
    expect(schedule[0]!.expense).toBeCloseTo(100, 2);
  });

  it('buckets a month-end grant into one period per calendar month', () => {
    // Overflowing month arithmetic ended period 0 on 3 March and period 1 on
    // 31 March: February carried no expense and March carried two periods,
    // which is not something an auditor can tie to a monthly GL close.
    const schedule = amortizationSchedule(1200, '2026-01-31', 12, 1);
    expect(schedule).toHaveLength(12);
    expect(schedule.map((p) => p.endDate.slice(0, 7))).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
    // Each period picks up where the previous one left off, with no gap.
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!.startDate).toBe(schedule[i - 1]!.endDate);
    }
  });
});

describe('asc718Grant', () => {
  const grant = {
    label: 'Q1 new hires',
    optionsGranted: 100000,
    grantDate: '2026-01-01',
    vestingMonths: 48,
    forfeitureRate: 0.1,
    assumptions: {
      grantDateFairValue: 2,
      exercisePrice: 2,
      expectedTermYears: 6,
      volatility: 0.6,
      riskFreeRate: 0.04,
    },
  };

  it('measures fair value, expected-to-vest cost, and the schedule', () => {
    const r = asc718Grant(grant);
    // The stated fair value: the Black-Scholes double at the precision the
    // result reports it, which is also the precision every reader multiplies.
    const fv = Math.round(blackScholesMerton(grant.assumptions) * 10000) / 10000;
    expect(r.fairValuePerOption).toBe(fv);
    expect(r.fairValuePerOption).toBeGreaterThan(0);
    // 10% *annual* turnover across a 4-year vest: 100k × 0.9⁴ = 65,610.
    expect(r.expectedToVestOptions).toBe(65610);
    // Total cost is net of forfeitures; gross uses all options.
    expect(r.totalCompensationCost).toBeCloseTo(fv * 65610, 2);
    expect(r.grossFairValue).toBeCloseTo(fv * 100000, 2);
    expect(r.schedule).toHaveLength(4);
    const total = r.schedule.reduce((s, p) => s + p.expense, 0);
    expect(total).toBeCloseTo(r.totalCompensationCost, 2);
    expect(r.assumptions.dividendYield).toBe(0);
  });

  /*
   * The grants table and the exhibit both print FV/option, Expected to vest
   * and Total cost on one row, and a reader reconciles the note by multiplying
   * the first two. The cost used to be struck on the unrounded double and the
   * unrounded expected-to-vest fraction, so the product of the printed figures
   * was not the printed total — a discrepancy that grows with the grant size
   * and is invisible in the row itself. Asserted exactly, not closely: the
   * point is that the three numbers are one arithmetic statement.
   */
  it('states a cost that is the product of the two figures beside it', () => {
    for (const [months, rate, options] of [
      [48, 0.1, 100_000],
      [72, 0.1, 100_000], // 0.9⁶ × 100k = 53,144.1 — a fractional expectation
      [30, 0.17, 37_513], // nothing here divides evenly
      [12, 0, 1_000_000],
    ] as const) {
      const r = asc718Grant({
        ...grant,
        vestingMonths: months,
        forfeitureRate: rate,
        optionsGranted: options,
      });
      expect(r.totalCompensationCost).toBe(
        Math.round(r.fairValuePerOption * r.expectedToVestOptions * 100) / 100,
      );
      expect(r.grossFairValue).toBe(
        Math.round(r.fairValuePerOption * r.optionsGranted * 100) / 100,
      );
      // Four decimals, always — the precision the tab and the exhibit print.
      expect(r.fairValuePerOption).toBe(Math.round(r.fairValuePerOption * 10000) / 10000);
      expect(Number.isInteger(r.expectedToVestOptions)).toBe(true);
    }
  });

  /*
   * The other half of the same rounding: a count rounded to zero beside a
   * positive cost. One option with a 60% expected forfeiture over a year is a
   * real grant, and the row said "0 expected to vest — $0.44".
   */
  it('a grant whose expectation rounds to no options costs nothing', () => {
    const r = asc718Grant({ ...grant, optionsGranted: 1, vestingMonths: 12, forfeitureRate: 0.6 });
    expect(r.expectedToVestOptions).toBe(0);
    expect(r.totalCompensationCost).toBe(0);
  });

  it('vesting of 0 months expenses immediately', () => {
    const r = asc718Grant({ ...grant, vestingMonths: 0, forfeitureRate: 0 });
    expect(r.schedule).toHaveLength(1);
    expect(r.schedule[0]!.expense).toBeCloseTo(r.totalCompensationCost, 2);
  });

  it('forfeits more over a longer requisite service period', () => {
    // The same annual rate, two vesting terms. Applied once — the bug — both
    // would land on 90,000 and the length of the service period would not
    // reach the compensation cost at all.
    const twoYear = asc718Grant({ ...grant, vestingMonths: 24 });
    const sixYear = asc718Grant({ ...grant, vestingMonths: 72 });
    expect(twoYear.expectedToVestOptions).toBe(81000); // 0.9²
    expect(sixYear.expectedToVestOptions).toBe(53144); // 0.9⁶
    expect(sixYear.totalCompensationCost).toBeLessThan(twoYear.totalCompensationCost);
  });

  it('a zero forfeiture rate expenses every option granted', () => {
    const r = asc718Grant({ ...grant, forfeitureRate: 0 });
    expect(r.expectedToVestOptions).toBe(100000);
    expect(r.totalCompensationCost).toBeCloseTo(r.grossFairValue, 2);
  });
});

describe('expectedToVestFraction', () => {
  it('compounds the annual rate over the service period', () => {
    expect(expectedToVestFraction(0.1, 48)).toBeCloseTo(0.9 ** 4, 10);
    expect(expectedToVestFraction(0.05, 36)).toBeCloseTo(0.95 ** 3, 10);
    // Partial years too: an 18-month vest is 1.5 years of turnover.
    expect(expectedToVestFraction(0.2, 18)).toBeCloseTo(0.8 ** 1.5, 10);
  });

  it('forfeits nothing when there is no rate or no service period', () => {
    expect(expectedToVestFraction(0, 48)).toBe(1);
    expect(expectedToVestFraction(0.1, 0)).toBe(1);
    // No service period to leave during, even at a 100% annual rate.
    expect(expectedToVestFraction(1, 0)).toBe(1);
  });

  it('clamps a rate outside 0–1 and a negative term', () => {
    expect(expectedToVestFraction(1, 48)).toBe(0);
    expect(expectedToVestFraction(1.5, 48)).toBe(0);
    expect(expectedToVestFraction(-0.5, 48)).toBe(1);
    expect(expectedToVestFraction(0.1, -12)).toBe(1);
  });
});

describe('asc718Portfolio', () => {
  it('aggregates cost and expense-by-year across grants', () => {
    const grants = [
      {
        optionsGranted: 50000,
        grantDate: '2026-01-01',
        vestingMonths: 48,
        assumptions: {
          grantDateFairValue: 2,
          exercisePrice: 2,
          expectedTermYears: 6,
          volatility: 0.6,
          riskFreeRate: 0.04,
        },
      },
      {
        optionsGranted: 30000,
        grantDate: '2026-06-01',
        vestingMonths: 24,
        assumptions: {
          grantDateFairValue: 2,
          exercisePrice: 2,
          expectedTermYears: 5,
          volatility: 0.6,
          riskFreeRate: 0.04,
        },
      },
    ];
    const p = asc718Portfolio(grants);
    expect(p.grants).toHaveLength(2);
    const sum = p.grants.reduce((s, g) => s + g.totalCompensationCost, 0);
    expect(p.totalCompensationCost).toBeCloseTo(sum, 2);
    const yearTotal = p.expenseByCalendarYear.reduce((s, y) => s + y.expense, 0);
    expect(yearTotal).toBeCloseTo(p.totalCompensationCost, 1);
    // Cumulative is monotonically increasing.
    for (let i = 1; i < p.expenseByCalendarYear.length; i++) {
      expect(p.expenseByCalendarYear[i]!.cumulative).toBeGreaterThanOrEqual(
        p.expenseByCalendarYear[i - 1]!.cumulative,
      );
    }
  });

  /**
   * The bucket key used to be `Math.floor(startMonth / 12) + 1` — a service
   * year counted from each grant's own grant date. That is right for one grant
   * and wrong for a portfolio: two awards granted five years apart both put
   * their first twelve months into a row called "Service year 1", and the
   * table came out four rows long for a programme expensed over ten.
   */
  const spacedGrants = [
    {
      label: 'old',
      optionsGranted: 10_000,
      grantDate: '2021-01-01',
      vestingMonths: 48,
      assumptions: {
        grantDateFairValue: 2,
        exercisePrice: 2,
        expectedTermYears: 6,
        volatility: 0.6,
        riskFreeRate: 0.04,
      },
    },
    {
      label: 'new',
      optionsGranted: 10_000,
      grantDate: '2026-01-01',
      vestingMonths: 48,
      assumptions: {
        grantDateFairValue: 2,
        exercisePrice: 2,
        expectedTermYears: 6,
        volatility: 0.6,
        riskFreeRate: 0.04,
      },
    },
  ];

  it('keys the schedule on the calendar year, not on an offset from each grant', () => {
    const p = asc718Portfolio(spacedGrants);
    const years = p.expenseByCalendarYear.map((y) => y.year);
    // Every key is a year, not a 1-based ordinal.
    expect(years.every((y) => y > 1900)).toBe(true);
    expect(years[0]).toBe(2021);
    expect(years[years.length - 1]).toBe(2029);
    // Recognition runs 2021→2024 and 2026→2029; 2025 has no expense at all and
    // is omitted rather than filled, because every row names its own year.
    expect(years).not.toContain(2025);
    expect(years).toEqual([2021, 2022, 2023, 2024, 2026, 2027, 2028, 2029]);
  });

  it('still totals to the compensation cost once the years are apart', () => {
    const p = asc718Portfolio(spacedGrants);
    const yearTotal = p.expenseByCalendarYear.reduce((s, y) => s + y.expense, 0);
    expect(yearTotal).toBeCloseTo(p.totalCompensationCost, 2);
    expect(p.expenseByCalendarYear[p.expenseByCalendarYear.length - 1]!.cumulative).toBeCloseTo(
      p.totalCompensationCost,
      2,
    );
  });

  /**
   * An annual bucket only lines up with a calendar year when the grant is
   * dated 1 January. Every other grant date leaves cost accruing across 31
   * December, and it belongs to the year it was earned in.
   */
  it('apportions a bucket that straddles a year end between both years', () => {
    const p = asc718Portfolio([
      {
        optionsGranted: 12_000,
        grantDate: '2026-07-01',
        vestingMonths: 12,
        amortizationFrequencyMonths: 12,
        assumptions: {
          grantDateFairValue: 2,
          exercisePrice: 2,
          expectedTermYears: 6,
          volatility: 0.6,
          riskFreeRate: 0.04,
        },
      },
    ]);
    // One annual bucket, 2026-07-01 → 2027-07-01: six months each side.
    expect(p.expenseByCalendarYear.map((y) => y.year)).toEqual([2026, 2027]);
    const half = p.totalCompensationCost / 2;
    expect(p.expenseByCalendarYear[0]!.expense).toBeCloseTo(half, 1);
    expect(p.expenseByCalendarYear[1]!.expense).toBeCloseTo(half, 1);
  });

  /*
   * The case the suite above avoids by granting on the first of a month, and
   * the one the module's own prose used to describe wrongly (round 269).
   *
   * A whole service month is the unit and it lands in the year it *begins* in,
   * so the month running 15 December to 15 January is 2026's entire. Six and
   * six, not five and a half and six and a half — which matters because these
   * are the rows of a disclosure somebody reconciles against a general ledger,
   * and "half a month of expense" is a difference that has to be explained.
   *
   * Pinned rather than left to the comment: nothing else in this file grants
   * mid-month, so the convention was stated in prose and enforced nowhere.
   */
  it('gives a mid-month grant whole months, in the year each month begins in', () => {
    const p = asc718Portfolio([
      {
        optionsGranted: 12_000,
        grantDate: '2026-07-15',
        vestingMonths: 12,
        amortizationFrequencyMonths: 12,
        assumptions: {
          grantDateFairValue: 2,
          exercisePrice: 2,
          expectedTermYears: 6,
          volatility: 0.6,
          riskFreeRate: 0.04,
        },
      },
    ]);
    expect(p.expenseByCalendarYear.map((y) => y.year)).toEqual([2026, 2027]);
    const half = p.totalCompensationCost / 2;
    expect(p.expenseByCalendarYear[0]!.expense).toBeCloseTo(half, 1);
    expect(p.expenseByCalendarYear[1]!.expense).toBeCloseTo(half, 1);
    // And the split is still exact — the last month absorbs the residual.
    expect(p.expenseByCalendarYear[1]!.cumulative).toBeCloseTo(p.totalCompensationCost, 2);
  });

  /**
   * The same accrual at monthly granularity has to agree, because the mid-month
   * boundary is exactly where a day-based split and a whole-month one diverge:
   * a monthly bucket has no smaller piece to divide, so if the annual one split
   * December in half the two frequencies would disclose different years.
   */
  it('agrees with the monthly schedule on a mid-month grant', () => {
    const grant = (freq: number) => ({
      optionsGranted: 12_000,
      grantDate: '2026-07-15',
      vestingMonths: 12,
      amortizationFrequencyMonths: freq,
      assumptions: {
        grantDateFairValue: 2,
        exercisePrice: 2,
        expectedTermYears: 6,
        volatility: 0.6,
        riskFreeRate: 0.04,
      },
    });
    const annual = asc718Portfolio([grant(12)]).expenseByCalendarYear;
    const monthly = asc718Portfolio([grant(1)]).expenseByCalendarYear;
    expect(monthly.map((y) => y.year)).toEqual(annual.map((y) => y.year));
    for (const [i, year] of annual.entries()) {
      expect(monthly[i]!.expense).toBeCloseTo(year.expense, 1);
    }
  });

  it('recognizes a zero-month schedule in the year of the grant', () => {
    const p = asc718Portfolio([
      {
        optionsGranted: 1_000,
        grantDate: '2026-03-09',
        vestingMonths: 0,
        assumptions: {
          grantDateFairValue: 2,
          exercisePrice: 2,
          expectedTermYears: 6,
          volatility: 0.6,
          riskFreeRate: 0.04,
        },
      },
    ]);
    expect(p.expenseByCalendarYear).toHaveLength(1);
    expect(p.expenseByCalendarYear[0]!.year).toBe(2026);
    expect(p.expenseByCalendarYear[0]!.expense).toBeCloseTo(p.totalCompensationCost, 2);
  });

  /**
   * Monthly buckets and annual buckets describe the same accrual, so they have
   * to agree on what each calendar year holds — the frequency is a disclosure
   * granularity, not a measurement choice.
   */
  it('reaches the same calendar-year totals at every amortization frequency', () => {
    const base = {
      optionsGranted: 30_000,
      grantDate: '2026-05-20',
      vestingMonths: 36,
      assumptions: {
        grantDateFairValue: 3,
        exercisePrice: 2.5,
        expectedTermYears: 6,
        volatility: 0.55,
        riskFreeRate: 0.04,
      },
    };
    const annual = asc718Portfolio([{ ...base, amortizationFrequencyMonths: 12 }]);
    for (const freq of [1, 3, 6] as const) {
      const other = asc718Portfolio([{ ...base, amortizationFrequencyMonths: freq }]);
      expect(other.expenseByCalendarYear.map((y) => y.year)).toEqual(
        annual.expenseByCalendarYear.map((y) => y.year),
      );
      other.expenseByCalendarYear.forEach((y, i) => {
        // Within rounding, not to the cent: each schedule's final period
        // absorbs its own residual, and where that lands moves with the
        // bucket size. A currency unit on a five-figure year is the artifact;
        // a different measurement would be a different number.
        expect(Math.abs(y.expense - annual.expenseByCalendarYear[i]!.expense)).toBeLessThan(1);
      });
    }
  });
});

describe('monteCarloFairValue draw bookkeeping', () => {
  const textbook: Asc718Assumptions = {
    grantDateFairValue: 10,
    exercisePrice: 10,
    expectedTermYears: 6,
    volatility: 0.6,
    riskFreeRate: 0.04,
  };

  it('averages over the draws it actually made when `paths` is odd', () => {
    // Draws come in antithetic pairs, so an odd request is rounded up to the
    // next even number. Asking for 2001 and 2002 therefore has to be the same
    // sample and the same estimate; before, 2001 divided 2002 payoffs by 2001.
    const odd = monteCarloFairValue(textbook, { paths: 2001, seed: 3 });
    const even = monteCarloFairValue(textbook, { paths: 2002, seed: 3 });
    expect(odd).toBe(even);
  });

  it('does not bias the estimate upward at odd sample sizes', () => {
    // The old arithmetic scaled the answer by (paths + 1) / paths — about
    // +0.05% at 2000 paths, which is the same order as the sampling error the
    // estimate is quoted at.
    const bs = blackScholesMerton(textbook);
    const mc = monteCarloFairValue(textbook, { paths: 20001, seed: 11 });
    expect(Math.abs(mc / bs - 1)).toBeLessThan(0.03);
  });

  it('still clamps the request into its own bounds', () => {
    // Below the floor and above the ceiling both round to an even count, so the
    // clamped ends stay reproducible rather than depending on parity.
    expect(monteCarloFairValue(textbook, { paths: 1, seed: 5 })).toBe(
      monteCarloFairValue(textbook, { paths: 1000, seed: 5 }),
    );
    expect(monteCarloFairValue(textbook, { paths: 1e9, seed: 5 })).toBe(
      monteCarloFairValue(textbook, { paths: 200000, seed: 5 }),
    );
  });
});
