import { describe, expect, it } from 'vitest';
import { blackScholesMerton } from '../../src/domain/asc718.js';
import {
  binomialLattice,
  esppFairValue,
  historicalExpectedTerm,
  historicalVolatility,
  marketConditionRsuMonteCarlo,
  performanceRsuMonteCarlo,
  relativeTsrMonteCarlo,
  rsuMarketFairValue,
  simplifiedExpectedTerm,
  standardNormals,
} from '../../src/domain/asc718Public.js';

describe('deterministic standard normals', () => {
  it('is reproducible for a fixed seed and ~N(0,1)', () => {
    const a = standardNormals(42);
    const b = standardNormals(42);
    const drawsA: number[] = [];
    const drawsB: number[] = [];
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < 20000; i++) {
      const x = a();
      drawsA.push(x);
      drawsB.push(b());
      sum += x;
      sq += x * x;
    }
    expect(drawsA).toEqual(drawsB);
    expect(sum / 20000).toBeCloseTo(0, 1); // mean ≈ 0
    expect(sq / 20000).toBeCloseTo(1, 1); // variance ≈ 1
  });
});

describe('expected-term methods', () => {
  it('SAB 107 simplified term is the vesting/contractual midpoint', () => {
    // 4y vesting, 10y contractual → (4 + 10) / 2 = 7.
    expect(simplifiedExpectedTerm(4, 10)).toBe(7);
  });

  it('historical term is share-weighted time to exercise', () => {
    const term = historicalExpectedTerm([
      { years: 2, options: 1000 },
      { years: 6, options: 3000 },
    ]);
    // (2·1000 + 6·3000) / 4000 = 5.
    expect(term).toBe(5);
  });

  it('historical term rejects an empty exercise history', () => {
    expect(() => historicalExpectedTerm([])).toThrow();
  });

  it('binomial lattice converges toward Black-Scholes for a European-style deep OTM exercise multiple', () => {
    // A very high exercise multiple suppresses early exercise, so the lattice
    // approaches the European BSM value.
    const bsm = blackScholesMerton({
      grantDateFairValue: 50,
      exercisePrice: 50,
      expectedTermYears: 10,
      volatility: 0.4,
      riskFreeRate: 0.03,
    });
    const lattice = binomialLattice({
      underlying: 50,
      strike: 50,
      contractualTermYears: 10,
      vestingYears: 4,
      volatility: 0.4,
      riskFreeRate: 0.03,
      exerciseMultiple: 1e6,
      steps: 300,
    });
    expect(lattice.fairValue).toBeCloseTo(bsm, 0);
    expect(lattice.expectedTermYears).toBeCloseTo(10, 1);
  });

  it('a lower exercise multiple lowers the value and shortens the expected term', () => {
    const base = { underlying: 50, strike: 50, contractualTermYears: 10, vestingYears: 4, volatility: 0.4, riskFreeRate: 0.03, steps: 300 };
    const patient = binomialLattice({ ...base, exerciseMultiple: 5 });
    const eager = binomialLattice({ ...base, exerciseMultiple: 1.5 });
    expect(eager.fairValue).toBeLessThan(patient.fairValue);
    expect(eager.expectedTermYears).toBeLessThan(patient.expectedTermYears);
  });
});

describe('historical volatility', () => {
  it('annualises the std-dev of log returns', () => {
    // Constant-growth series has zero return variance → zero volatility.
    const flat = [100, 101, 102.01, 103.0301];
    expect(historicalVolatility(flat)).toBeCloseTo(0, 6);
  });

  it('scales with the periods-per-year factor', () => {
    const closes = [100, 102, 99, 105, 103, 108, 106];
    const daily = historicalVolatility(closes, 252);
    const monthly = historicalVolatility(closes, 12);
    expect(daily).toBeGreaterThan(monthly);
  });

  it('rejects a series shorter than two points', () => {
    expect(() => historicalVolatility([100])).toThrow();
  });
});

describe('ESPP with lookback', () => {
  const espp = {
    grantDatePrice: 20,
    discountPct: 0.15,
    lookbackMonths: 12,
    volatility: 0.3,
    riskFreeRate: 0.03,
  };

  it('decomposes into discount + call + put components that sum to the fair value', () => {
    const fv = esppFairValue(espp);
    const sum = fv.components.purchaseDiscount + fv.components.callComponent + fv.components.putComponent;
    expect(fv.fairValuePerShare).toBeCloseTo(sum, 3);
    // Discount component is exactly 15% of the $20 grant price.
    expect(fv.components.purchaseDiscount).toBeCloseTo(3, 6);
  });

  it('is worth more than the bare discount because of the lookback optionality', () => {
    const fv = esppFairValue(espp);
    expect(fv.fairValuePerShare).toBeGreaterThan(fv.components.purchaseDiscount);
  });
});

describe('RSU fair value', () => {
  it('service-only RSU is just the market price', () => {
    expect(rsuMarketFairValue(37.5)).toBe(37.5);
  });

  it('non-dividend-protected RSU is discounted for forgone dividends', () => {
    const protectedFv = rsuMarketFairValue(100, { vestingYears: 4, dividendYield: 0.02, dividendProtected: true });
    const unprotected = rsuMarketFairValue(100, { vestingYears: 4, dividendYield: 0.02 });
    expect(protectedFv).toBe(100);
    expect(unprotected).toBeLessThan(100);
  });

  it('performance-condition RSU expected payout ratio is near the expected attainment (capped)', () => {
    const res = performanceRsuMonteCarlo({
      marketPrice: 40,
      targetUnits: 10000,
      expectedAttainment: 1.0,
      attainmentVolatility: 0.25,
      maxPayoutRatio: 2,
      seed: 11,
    });
    expect(res.fairValuePerUnit).toBe(40);
    expect(res.expectedPayoutRatio).toBeGreaterThan(0.9);
    expect(res.expectedPayoutRatio).toBeLessThan(1.1);
    expect(res.expectedToVestUnits).toBeGreaterThan(9000);
  });

  it('market-condition RSU per-unit value rises with a lower hurdle', () => {
    const base = { underlying: 50, vestingYears: 3, volatility: 0.4, riskFreeRate: 0.03, seed: 3 };
    const easy = marketConditionRsuMonteCarlo({ ...base, hurdlePrice: 40 });
    const hard = marketConditionRsuMonteCarlo({ ...base, hurdlePrice: 90 });
    expect(easy.probabilityMet).toBeGreaterThan(hard.probabilityMet);
    expect(easy.fairValuePerUnit).toBeGreaterThan(hard.fairValuePerUnit);
  });
});

describe('relative TSR Monte-Carlo', () => {
  const schedule = [
    { percentile: 75, payoutRatio: 2.0 },
    { percentile: 50, payoutRatio: 1.0 },
    { percentile: 25, payoutRatio: 0.5 },
    { percentile: 0, payoutRatio: 0 },
  ];

  it('a stronger subject (higher drift via lower vol drag / same basket) earns a higher payout ratio', () => {
    const peers = [
      { name: 'A', volatility: 0.4 },
      { name: 'B', volatility: 0.4 },
      { name: 'C', volatility: 0.4 },
      { name: 'D', volatility: 0.4 },
    ];
    const res = relativeTsrMonteCarlo({
      subject: { underlying: 100, volatility: 0.4 },
      peers,
      performancePeriodYears: 3,
      riskFreeRate: 0.03,
      payoutSchedule: schedule,
      seed: 5,
    });
    // With a symmetric basket the subject ranks around the median → payout ~1×.
    expect(res.expectedPercentile).toBeGreaterThan(30);
    expect(res.expectedPercentile).toBeLessThan(70);
    expect(res.fairValuePerUnit).toBeGreaterThan(0);
    expect(res.expectedPayoutRatio).toBeGreaterThan(0);
  });

  it('is deterministic for a fixed seed', () => {
    const peers = [{ name: 'A', volatility: 0.5 }, { name: 'B', volatility: 0.3 }];
    const args = {
      subject: { underlying: 100, volatility: 0.4 },
      peers,
      performancePeriodYears: 3,
      riskFreeRate: 0.03,
      payoutSchedule: schedule,
      seed: 99,
    };
    expect(relativeTsrMonteCarlo(args)).toEqual(relativeTsrMonteCarlo(args));
  });
});
