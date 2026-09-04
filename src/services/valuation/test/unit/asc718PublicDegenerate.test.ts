import { describe, expect, it } from 'vitest';
import {
  binomialLattice,
  esppFairValue,
  marketConditionRsuMonteCarlo,
  monteCarloScale,
  performanceRsuMonteCarlo,
  relativeTsrMonteCarlo,
  rsuMarketFairValue,
  scaleMonteCarloPaths,
} from '../../src/domain/asc718Public.js';

/**
 * The public-company ASC 718 models against inputs that are degenerate rather
 * than merely unusual: a zero price, a zero term, a zero volatility, an empty
 * peer basket, a path count out of range.
 *
 * `asc718Public.test.ts` values these models on realistic assumptions. It never
 * hands one a zero, which left the file at 75.6% branch coverage — the lowest of
 * any domain file — with every early-return guard untested. Those guards are
 * the only thing standing between a half-filled assumptions form and a NaN, and
 * a NaN here does not stay local: it propagates into a per-share figure, then a
 * total, then a signed expense schedule. Every assertion below therefore checks
 * the number is finite as well as correct.
 */

const finite = (x: number) => Number.isFinite(x);

describe('ASC 718 public models — degenerate inputs', () => {
  describe('binomial lattice', () => {
    const base = {
      underlying: 10,
      strike: 10,
      contractualTermYears: 10,
      vestingYears: 4,
      volatility: 0.6,
      riskFreeRate: 0.04,
    };

    it('returns zero for a worthless underlying without running the tree', () => {
      const res = binomialLattice({ ...base, underlying: 0 });
      expect(res).toEqual({ fairValue: 0, expectedTermYears: 0 });
    });

    it('collapses to intrinsic value when the term or the volatility is zero', () => {
      // With no time and no diffusion there is nothing to model — the option is
      // worth what it is worth today, and the expected term is zero. Returning
      // intrinsic rather than throwing matters because both fields are routinely
      // blank on a half-filled assumptions form.
      for (const over of [{ contractualTermYears: 0 }, { volatility: 0 }]) {
        const itm = binomialLattice({ ...base, underlying: 15, strike: 10, ...over });
        expect(itm.fairValue).toBe(5);
        expect(finite(itm.expectedTermYears)).toBe(true);

        const otm = binomialLattice({ ...base, underlying: 5, strike: 10, ...over });
        expect(otm.fairValue).toBe(0);
      }
    });

    it('reports a non-negative expected term for a negative contractual term', () => {
      const res = binomialLattice({ ...base, contractualTermYears: -3 });
      expect(res.expectedTermYears).toBe(0);
      expect(res.fairValue).toBe(0);
    });

    it('clamps the step count at both ends rather than trusting it', () => {
      // A step count of 1 would divide the term into one period and a step count
      // of a million would hang the request. Both are clamped, and the clamp is
      // observable: the tiny and huge requests agree with the floor and ceiling.
      const tiny = binomialLattice({ ...base, steps: 1 });
      const floor = binomialLattice({ ...base, steps: 10 });
      expect(tiny).toEqual(floor);

      const huge = binomialLattice({ ...base, steps: 10_000_000 });
      const ceiling = binomialLattice({ ...base, steps: 2000 });
      expect(huge).toEqual(ceiling);
      expect(finite(huge.fairValue)).toBe(true);
    });

    it('treats a fractional step count as its floor', () => {
      expect(binomialLattice({ ...base, steps: 50.9 })).toEqual(binomialLattice({ ...base, steps: 50 }));
    });

    it('vests immediately when the vesting period is zero, and never when it exceeds the term', () => {
      // `vestStep` is clamped to N, so a grant that vests after its own
      // expiry must still price — as an option that is never exercisable
      // early, which is worth *more* than one that is.
      const immediate = binomialLattice({ ...base, vestingYears: 0 });
      const never = binomialLattice({ ...base, vestingYears: 99 });
      expect(finite(immediate.fairValue)).toBe(true);
      expect(finite(never.fairValue)).toBe(true);
      expect(never.fairValue).toBeGreaterThan(immediate.fairValue);
      // Forced early exercise is what shortens the expected term, so the grant
      // that can never be exercised early runs to contractual maturity.
      expect(never.expectedTermYears).toBeCloseTo(base.contractualTermYears, 6);
      expect(immediate.expectedTermYears).toBeLessThan(never.expectedTermYears);
    });

    it('applies a post-vest exit hazard, and clamps it to a probability', () => {
      const none = binomialLattice({ ...base, postVestExitRate: 0 });
      const some = binomialLattice({ ...base, postVestExitRate: 0.15 });
      // Leaving early can only shorten the expected term.
      expect(some.expectedTermYears).toBeLessThan(none.expectedTermYears);
      /*
       * R407 (M2): and it has to reach the value as well. The hazard used to be
       * applied in the forward probability sweep only, so `expectedTermYears`
       * moved and `fairValue` came back bit-identical at every rate — 0, 15%
       * and 100% a year all priced one grant at the same figure. A holder who
       * leaves realises max(S − K, 0) instead of continuing, which is strictly
       * worse than continuing, so the value falls with the term.
       */
      expect(some.fairValue).toBeLessThan(none.fairValue);

      // Out-of-range rates are clamped, not trusted: a negative hazard would
      // add probability mass and a rate above 1 would remove more than exists.
      const negative = binomialLattice({ ...base, postVestExitRate: -5 });
      expect(negative).toEqual(none);
      const excessive = binomialLattice({ ...base, postVestExitRate: 12 });
      expect(finite(excessive.expectedTermYears)).toBe(true);
      expect(excessive.expectedTermYears).toBeGreaterThan(0);
      expect(excessive.expectedTermYears).toBeLessThanOrEqual(base.contractualTermYears);
      expect(finite(excessive.fairValue)).toBe(true);
      expect(excessive.fairValue).toBeGreaterThan(0);
    });

    // Both figures come off one model, so they have to move together and in the
    // same direction at every rate — not merely differ from the unhazarded case.
    it('lowers the value and the term monotonically as the exit rate rises', () => {
      const runs = [0, 0.05, 0.15, 0.5, 1].map((rate) =>
        binomialLattice({ ...base, postVestExitRate: rate }),
      );
      for (let i = 1; i < runs.length; i += 1) {
        expect(runs[i]!.fairValue).toBeLessThan(runs[i - 1]!.fairValue);
        expect(runs[i]!.expectedTermYears).toBeLessThan(runs[i - 1]!.expectedTermYears);
      }
      // A leaver never does better than a holder who stays, and never worse
      // than nothing: the value stays inside the no-hazard bound and above
      // intrinsic.
      expect(runs[runs.length - 1]!.fairValue).toBeLessThan(runs[0]!.fairValue);
      expect(runs[runs.length - 1]!.fairValue).toBeGreaterThanOrEqual(
        Math.max(0, base.underlying - base.strike),
      );
    });

    it('leaves both figures untouched when nobody leaves', () => {
      // The hazard is opt-in, so the default path has to be the arithmetic it
      // always was — the fix must not move a stored ASC 718 disclosure.
      const { postVestExitRate: _omit, ...noRate } = { ...base, postVestExitRate: 0 };
      expect(binomialLattice(noRate)).toEqual(binomialLattice({ ...base, postVestExitRate: 0 }));
    });

    it('prices a deeply out-of-the-money grant to a finite figure', () => {
      // No node reaches the exercise barrier, so no probability mass is ever
      // absorbed early — the `absorbed > 0` fallback is what stops the expected
      // term coming back as 0/0.
      const res = binomialLattice({ ...base, underlying: 1, strike: 1_000_000 });
      expect(finite(res.fairValue)).toBe(true);
      expect(finite(res.expectedTermYears)).toBe(true);
      expect(res.expectedTermYears).toBeGreaterThan(0);
    });

    it('honours a dividend yield and an exercise multiple', () => {
      const noDiv = binomialLattice({ ...base });
      const withDiv = binomialLattice({ ...base, dividendYield: 0.05 });
      expect(withDiv.fairValue).toBeLessThan(noDiv.fairValue);

      // A higher barrier means the employee holds longer, so a longer expected
      // term and a higher value — the Hull-White multiple's whole effect.
      const patient = binomialLattice({ ...base, exerciseMultiple: 4 });
      expect(patient.expectedTermYears).toBeGreaterThan(noDiv.expectedTermYears);
      expect(patient.fairValue).toBeGreaterThan(noDiv.fairValue);
    });
  });

  describe('ESPP', () => {
    const base = {
      grantDatePrice: 20,
      discountPct: 0.15,
      lookbackMonths: 6,
      volatility: 0.5,
      riskFreeRate: 0.04,
    };

    it('is worth exactly the discount when the look-back is zero', () => {
      // With no offering period the call and the put are both worthless, so the
      // §423 benefit reduces to the built-in discount and nothing else.
      const res = esppFairValue({ ...base, lookbackMonths: 0 });
      expect(res.components.callComponent).toBe(0);
      expect(res.components.putComponent).toBe(0);
      expect(res.fairValuePerShare).toBeCloseTo(0.15 * 20, 6);
    });

    it('treats a negative look-back as zero rather than as time running backwards', () => {
      expect(esppFairValue({ ...base, lookbackMonths: -6 })).toEqual(
        esppFairValue({ ...base, lookbackMonths: 0 }),
      );
    });

    it('clamps the discount to a fraction at both ends', () => {
      // A discount above 100% would make the shares free and then some; a
      // negative one would charge a premium. Neither is a §423 plan.
      expect(esppFairValue({ ...base, discountPct: 5 })).toEqual(esppFairValue({ ...base, discountPct: 1 }));
      expect(esppFairValue({ ...base, discountPct: -1 })).toEqual(esppFairValue({ ...base, discountPct: 0 }));
    });

    it('decomposes into three components that sum to the whole', () => {
      const res = esppFairValue(base);
      const { purchaseDiscount, callComponent, putComponent } = res.components;
      expect(purchaseDiscount + callComponent + putComponent).toBeCloseTo(res.fairValuePerShare, 3);
      for (const v of [purchaseDiscount, callComponent, putComponent]) {
        expect(finite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    });

    it('reduces the look-back components under a dividend yield', () => {
      const withDiv = esppFairValue({ ...base, dividendYield: 0.06 });
      const without = esppFairValue(base);
      expect(withDiv.components.callComponent).toBeLessThan(without.components.callComponent);
      expect(finite(withDiv.fairValuePerShare)).toBe(true);
    });
  });

  describe('RSU market value', () => {
    it('ignores the dividend discount for a protected award, or a zero yield or term', () => {
      // Three separate reasons to skip the discount, each on its own arm.
      expect(rsuMarketFairValue(30, { dividendProtected: true, dividendYield: 0.05, vestingYears: 4 })).toBe(
        30,
      );
      expect(rsuMarketFairValue(30, { dividendYield: 0, vestingYears: 4 })).toBe(30);
      expect(rsuMarketFairValue(30, { dividendYield: 0.05, vestingYears: 0 })).toBe(30);
      expect(rsuMarketFairValue(30)).toBe(30);
    });

    it('discounts an unprotected award, and floors a negative price at zero', () => {
      expect(rsuMarketFairValue(30, { dividendYield: 0.05, vestingYears: 4 })).toBeCloseTo(
        30 * Math.exp(-0.2),
        4,
      );
      expect(rsuMarketFairValue(-5)).toBe(0);
    });
  });

  describe('performance RSU', () => {
    const base = {
      marketPrice: 25,
      targetUnits: 1000,
      expectedAttainment: 1,
      attainmentVolatility: 0.3,
    };

    it('is deterministic at zero attainment volatility', () => {
      // No dispersion means every path attains exactly the expectation, so the
      // payout ratio is the expectation itself.
      const res = performanceRsuMonteCarlo({ ...base, attainmentVolatility: 0 });
      expect(res.expectedPayoutRatio).toBeCloseTo(1, 3);
      expect(res.expectedToVestUnits).toBeCloseTo(1000, 0);
      expect(res.totalFairValue).toBeCloseTo(25_000, -1);
    });

    it('treats a negative volatility as zero', () => {
      expect(performanceRsuMonteCarlo({ ...base, attainmentVolatility: -2 })).toEqual(
        performanceRsuMonteCarlo({ ...base, attainmentVolatility: 0 }),
      );
    });

    it('survives an expected attainment of zero instead of taking log(0)', () => {
      // `Math.log(Math.max(x, 1e-9))` — without the floor this is −Infinity and
      // every downstream figure is NaN.
      const res = performanceRsuMonteCarlo({ ...base, expectedAttainment: 0 });
      expect(finite(res.expectedPayoutRatio)).toBe(true);
      expect(finite(res.totalFairValue)).toBe(true);
      expect(res.expectedPayoutRatio).toBeCloseTo(0, 4);
    });

    it('caps the payout ratio at the plan maximum', () => {
      const uncapped = performanceRsuMonteCarlo({ ...base, expectedAttainment: 10, maxPayoutRatio: 2 });
      expect(uncapped.expectedPayoutRatio).toBeLessThanOrEqual(2);
      const tight = performanceRsuMonteCarlo({ ...base, expectedAttainment: 10, maxPayoutRatio: 1 });
      expect(tight.expectedPayoutRatio).toBeLessThanOrEqual(1);
      expect(tight.expectedPayoutRatio).toBeLessThan(uncapped.expectedPayoutRatio);
    });

    it('clamps the path count at both ends and stays reproducible under a seed', () => {
      const tiny = performanceRsuMonteCarlo({ ...base, paths: 1, seed: 7 });
      const floor = performanceRsuMonteCarlo({ ...base, paths: 1000, seed: 7 });
      expect(tiny).toEqual(floor);

      const huge = performanceRsuMonteCarlo({ ...base, paths: 10_000_000, seed: 7 });
      const ceiling = performanceRsuMonteCarlo({ ...base, paths: 200_000, seed: 7 });
      expect(huge).toEqual(ceiling);

      // Same seed, same answer — a valuation that moves between two runs of the
      // same inputs is not one anybody can sign.
      expect(performanceRsuMonteCarlo({ ...base, seed: 42 })).toEqual(
        performanceRsuMonteCarlo({ ...base, seed: 42 }),
      );
    });
  });

  describe('market-condition RSU', () => {
    const base = {
      underlying: 50,
      hurdlePrice: 75,
      vestingYears: 3,
      volatility: 0.45,
      riskFreeRate: 0.04,
    };

    it('answers by inspection when there is nothing to simulate', () => {
      // Zero price, zero term or zero volatility: the hurdle is either already
      // cleared or unreachable, and the answer is that fact rather than a
      // simulation of it.
      for (const over of [{ underlying: 0 }, { vestingYears: 0 }, { volatility: 0 }]) {
        const missed = marketConditionRsuMonteCarlo({ ...base, ...over });
        expect(missed.probabilityMet).toBe(0);
        expect(missed.fairValuePerUnit).toBe(0);
      }
      const cleared = marketConditionRsuMonteCarlo({ ...base, vestingYears: 0, hurdlePrice: 10 });
      expect(cleared.probabilityMet).toBe(1);
      expect(cleared.fairValuePerUnit).toBe(50);
    });

    it('prices an unreachable hurdle at nearly zero and a cleared one near the price', () => {
      const unreachable = marketConditionRsuMonteCarlo({ ...base, hurdlePrice: 1e9, seed: 11 });
      expect(unreachable.probabilityMet).toBeCloseTo(0, 3);
      expect(finite(unreachable.fairValuePerUnit)).toBe(true);

      const trivial = marketConditionRsuMonteCarlo({ ...base, hurdlePrice: 0.01, seed: 11 });
      expect(trivial.probabilityMet).toBeGreaterThan(0.95);
    });

    it('clamps its path count and honours a dividend yield', () => {
      expect(marketConditionRsuMonteCarlo({ ...base, paths: 1, seed: 3 })).toEqual(
        marketConditionRsuMonteCarlo({ ...base, paths: 1000, seed: 3 }),
      );
      expect(marketConditionRsuMonteCarlo({ ...base, paths: 9_999_999, seed: 3 })).toEqual(
        marketConditionRsuMonteCarlo({ ...base, paths: 400_000, seed: 3 }),
      );
      const withDiv = marketConditionRsuMonteCarlo({ ...base, dividendYield: 0.08, seed: 3 });
      expect(withDiv.probabilityMet).toBeLessThan(
        marketConditionRsuMonteCarlo({ ...base, seed: 3 }).probabilityMet,
      );
    });
  });

  describe('relative TSR', () => {
    const peers = [
      { name: 'A', volatility: 0.4 },
      { name: 'B', volatility: 0.5, correlation: 0.6 },
      { name: 'C', volatility: 0.35, dividendYield: 0.02 },
    ];
    const base = {
      subject: { underlying: 40, volatility: 0.45 },
      peers,
      performancePeriodYears: 3,
      riskFreeRate: 0.04,
      payoutSchedule: [
        { percentile: 75, payoutRatio: 2 },
        { percentile: 50, payoutRatio: 1 },
        { percentile: 25, payoutRatio: 0.5 },
      ],
    };

    it('falls back to intrinsic value when there is nothing to rank against', () => {
      // An empty peer basket is not a relative award — there is no percentile to
      // compute. Same for a zero price or a zero period.
      const noPeers = relativeTsrMonteCarlo({ ...base, peers: [] });
      expect(noPeers).toEqual({ fairValuePerUnit: 40, expectedPayoutRatio: 0, expectedPercentile: 0 });

      const noPrice = relativeTsrMonteCarlo({ ...base, subject: { underlying: 0, volatility: 0.4 } });
      expect(noPrice.fairValuePerUnit).toBe(0);

      const noPeriod = relativeTsrMonteCarlo({ ...base, performancePeriodYears: 0 });
      expect(noPeriod.fairValuePerUnit).toBe(40);
    });

    it('floors a negative subject price at zero rather than reporting a negative award', () => {
      const res = relativeTsrMonteCarlo({ ...base, subject: { underlying: -10, volatility: 0.4 } });
      expect(res.fairValuePerUnit).toBe(0);
    });

    it('prices a real basket to a finite figure inside the schedule', () => {
      const res = relativeTsrMonteCarlo({ ...base, seed: 99 });
      expect(finite(res.fairValuePerUnit)).toBe(true);
      expect(res.expectedPayoutRatio).toBeGreaterThanOrEqual(0);
      expect(res.expectedPayoutRatio).toBeLessThanOrEqual(2);
      expect(res.expectedPercentile).toBeGreaterThan(0);
      expect(res.expectedPercentile).toBeLessThan(100);
    });

    it('pays nothing when no tier is reachable, and clamps its path count', () => {
      // A schedule whose lowest tier is the 100th percentile can only pay when
      // the subject beats every peer — and with one path count or a million,
      // the clamped answer is the same one.
      const unreachable = relativeTsrMonteCarlo({
        ...base,
        payoutSchedule: [{ percentile: 100, payoutRatio: 3 }],
        seed: 5,
      });
      expect(finite(unreachable.fairValuePerUnit)).toBe(true);
      expect(unreachable.expectedPayoutRatio).toBeLessThan(1);

      expect(relativeTsrMonteCarlo({ ...base, paths: 1, seed: 5 })).toEqual(
        relativeTsrMonteCarlo({ ...base, paths: 1000, seed: 5 }),
      );
      expect(relativeTsrMonteCarlo({ ...base, paths: 9_999_999, seed: 5 })).toEqual(
        relativeTsrMonteCarlo({ ...base, paths: 300_000, seed: 5 }),
      );
    });

    it('pays the top tier when the schedule starts at zero', () => {
      const res = relativeTsrMonteCarlo({
        ...base,
        payoutSchedule: [{ percentile: 0, payoutRatio: 1.5 }],
        seed: 5,
      });
      expect(res.expectedPayoutRatio).toBeCloseTo(1.5, 6);
    });
  });

  describe('draw budget', () => {
    it('never scales a request above 1, and never below zero', () => {
      expect(monteCarloScale(10, 1000)).toBe(1);
      expect(monteCarloScale(2000, 1000)).toBeCloseTo(0.5, 6);
      expect(monteCarloScale(0, 1000)).toBe(1);
    });

    it('keeps a scaled path count usable rather than letting it reach zero', () => {
      const scaled = scaleMonteCarloPaths(20_000, monteCarloScale(1e9, 1000));
      expect(scaled).toBeGreaterThan(0);
      expect(Number.isInteger(scaled)).toBe(true);
      expect(scaleMonteCarloPaths(20_000, 1)).toBe(20_000);
    });
  });
});
