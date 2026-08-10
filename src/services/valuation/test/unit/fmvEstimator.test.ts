import { describe, expect, it } from 'vitest';
import {
  estimateFmv,
  ESTIMATOR_STAGES,
  NoEvidenceError,
  SAFE_HARBOR_DISCLAIMER,
  type EstimatorInput,
  type Range,
} from '../../src/domain/fmvEstimator.js';

/**
 * The estimator is a statistical range, so most of what is worth asserting are
 * the invariants a range has to satisfy to be one — ordering, monotonicity in
 * each input, and the direction each of the three steps moves the number.
 * A band that is merely plausible-looking is the failure mode here.
 */

const base: EstimatorInput = { stage: 'series_a', round_age: 'under_6m' };

const ordered = (r: Range): boolean => r.p10 < r.median && r.median < r.p90;

describe('estimateFmv', () => {
  it('refuses to produce a range with no evidence behind it', () => {
    expect(() => estimateFmv(base)).toThrow(NoEvidenceError);
    // The stage alone is not evidence, at any stage.
    for (const stage of ESTIMATOR_STAGES) {
      expect(() => estimateFmv({ stage, round_age: 'never' })).toThrow(NoEvidenceError);
    }
  });

  it('treats a zero or negative figure as absent, not as evidence', () => {
    expect(() => estimateFmv({ ...base, revenue_ltm: 0 })).toThrow(NoEvidenceError);
    expect(() => estimateFmv({ ...base, post_money: -5_000_000 })).toThrow(NoEvidenceError);
  });

  it('ignores a post-money when the caller says there was never a priced round', () => {
    // The two answers contradict each other; the explicit "never" wins, and
    // with nothing else supplied there is no evidence left.
    expect(() => estimateFmv({ stage: 'seed', round_age: 'never', post_money: 10_000_000 })).toThrow(
      NoEvidenceError,
    );
  });

  it('orders every reported range p10 < median < p90', () => {
    const r = estimateFmv({
      ...base,
      post_money: 25_000_000,
      revenue_ltm: 2_300_000,
      capital_raised: 6_000_000,
      fully_diluted_shares: 10_000_000,
    });
    expect(ordered(r.equity_value)).toBe(true);
    expect(ordered(r.common_allocation)).toBe(true);
    expect(ordered(r.common_fmv)).toBe(true);
    expect(r.per_share).not.toBeNull();
    expect(ordered(r.per_share!)).toBe(true);
    for (const e of r.evidence) expect(ordered(e.implied)).toBe(true);
  });

  it('centres equity value on a fresh priced round when it is the only evidence', () => {
    const r = estimateFmv({ ...base, post_money: 25_000_000 });
    expect(r.equity_value.median).toBeCloseTo(25_000_000, -1);
  });

  it('reproduces the worked Series A example on the tool page', () => {
    // $25M post-money, 10M fully diluted shares. The stage band puts common at
    // 25-40% of equity value, so the allocation brackets $6.25M-$10M.
    const r = estimateFmv({ ...base, post_money: 25_000_000, fully_diluted_shares: 10_000_000 });
    expect(r.common_share_band).toEqual({ low: 0.25, high: 0.4 });
    expect(r.common_allocation.p10).toBeGreaterThan(5_000_000);
    expect(r.common_allocation.p90).toBeLessThan(12_500_000);
    // Allocation before DLOM sits against a $2.50 preferred price, so common
    // must land well below it.
    expect(r.common_allocation.median / 10_000_000).toBeLessThan(2.5);
  });

  it('widens the band and de-weights the round as it goes stale, without moving the median', () => {
    const fresh = estimateFmv({ ...base, post_money: 25_000_000 });
    const old = estimateFmv({ ...base, round_age: 'over_2y', post_money: 25_000_000 });

    // Nothing here knows which way the company went, so the centre holds...
    expect(old.equity_value.median).toBeCloseTo(fresh.equity_value.median, -1);
    // ...and the uncertainty is expressed as a wider band instead.
    const width = (r: Range) => r.p90 / r.p10;
    expect(width(old.equity_value)).toBeGreaterThan(width(fresh.equity_value));
  });

  it('lets other evidence outweigh a stale round, but not a fresh one', () => {
    const withRevenue = { revenue_ltm: 20_000_000, post_money: 25_000_000 };
    const fresh = estimateFmv({ ...base, ...withRevenue });
    const stale = estimateFmv({ ...base, ...withRevenue, round_age: 'over_2y' });

    const roundWeight = (r: ReturnType<typeof estimateFmv>) =>
      r.evidence.find((e) => e.source === 'priced_round')!.weight;
    expect(roundWeight(fresh)).toBeGreaterThan(roundWeight(stale));
    // Revenue implies more than the round does, so de-weighting the round
    // pulls the pooled estimate up.
    expect(stale.equity_value.median).toBeGreaterThan(fresh.equity_value.median);
  });

  it('widens the band when two sources disagree (law of total variance)', () => {
    const width = (r: ReturnType<typeof estimateFmv>) => r.equity_value.p90 / r.equity_value.p10;

    // Revenue chosen so its median lands near the round: 2.3M at the series_a
    // 5x-18x band has a median near sqrt(5*18)*2.3M ≈ $21.8M.
    const agreeing = estimateFmv({ ...base, post_money: 21_800_000, revenue_ltm: 2_300_000 });
    // Same revenue, a round an order of magnitude away from it.
    const disagreeing = estimateFmv({ ...base, post_money: 200_000_000, revenue_ltm: 2_300_000 });

    expect(width(disagreeing)).toBeGreaterThan(width(agreeing));
  });

  it('reports weights that sum to one, strongest first', () => {
    const r = estimateFmv({
      ...base,
      post_money: 25_000_000,
      revenue_ltm: 2_300_000,
      profit_ltm: 400_000,
      capital_raised: 6_000_000,
    });
    expect(r.evidence).toHaveLength(4);
    expect(r.evidence.reduce((s, e) => s + e.weight, 0)).toBeCloseTo(1, 10);
    for (let i = 1; i < r.evidence.length; i++) {
      expect(r.evidence[i - 1]!.weight).toBeGreaterThanOrEqual(r.evidence[i]!.weight);
    }
    // Capital raised is corroboration, so it must never be the leading source.
    expect(r.evidence[0]!.source).not.toBe('capital_raised');
  });

  it('scales linearly in each money input', () => {
    const one = estimateFmv({ ...base, post_money: 25_000_000 });
    const ten = estimateFmv({ ...base, post_money: 250_000_000 });
    expect(ten.equity_value.median / one.equity_value.median).toBeCloseTo(10, 6);
    expect(ten.common_fmv.median / one.common_fmv.median).toBeCloseTo(10, 6);
  });

  it('divides per-share by the fully diluted count, and omits it when absent', () => {
    const shares = 10_000_000;
    const r = estimateFmv({ ...base, post_money: 25_000_000, fully_diluted_shares: shares });
    expect(r.per_share!.median).toBeCloseTo(r.common_fmv.median / shares, 9);
    expect(estimateFmv({ ...base, post_money: 25_000_000 }).per_share).toBeNull();
  });

  it('applies the three steps in the defensible direction', () => {
    const r = estimateFmv({ ...base, post_money: 25_000_000 });
    // Allocation takes common below total equity...
    expect(r.common_allocation.median).toBeLessThan(r.equity_value.median);
    // ...and the marketability discount takes it below the allocation, by
    // exactly the reported DLOM.
    expect(r.common_fmv.median).toBeCloseTo(r.common_allocation.median * (1 - r.dlom), 6);
    expect(r.dlom).toBeGreaterThan(0);
    expect(r.dlom).toBeLessThan(1);
  });

  it('leaves common a smaller share and a smaller discount as the stack deepens', () => {
    const byStage = ESTIMATOR_STAGES.map((stage) =>
      estimateFmv({ stage, round_age: 'under_6m', post_money: 25_000_000 }),
    );
    for (let i = 1; i < byStage.length; i++) {
      const prev = byStage[i - 1]!;
      const cur = byStage[i]!;
      // Each round adds preference ahead of common.
      expect(cur.common_share_band.high).toBeLessThanOrEqual(prev.common_share_band.high);
      expect(cur.common_share_band.low).toBeLessThanOrEqual(prev.common_share_band.low);
      // A nearer exit is a shorter holding period, so a smaller DLOM.
      expect(cur.dlom).toBeLessThanOrEqual(prev.dlom);
    }
  });

  it('produces a plottable curve whose mode sits at the median', () => {
    const r = estimateFmv({ ...base, post_money: 25_000_000 });
    expect(r.curve.length).toBeGreaterThan(20);
    for (const p of r.curve) {
      expect(Number.isFinite(p.value)).toBe(true);
      expect(p.density).toBeGreaterThan(0);
    }
    // Values ascend, so the frontend can plot without sorting.
    for (let i = 1; i < r.curve.length; i++) {
      expect(r.curve[i]!.value).toBeGreaterThan(r.curve[i - 1]!.value);
    }
    // The density is symmetric in log space, so its peak is the median.
    const peak = r.curve.reduce((a, b) => (b.density > a.density ? b : a));
    expect(peak.value / r.equity_value.median).toBeCloseTo(1, 1);
    // The band edges bracket the mode.
    expect(r.equity_value.p10).toBeLessThan(peak.value);
    expect(r.equity_value.p90).toBeGreaterThan(peak.value);
  });

  it('carries the safe-harbor disclaimer with the result, not only on the page', () => {
    const r = estimateFmv({ ...base, post_money: 25_000_000 });
    expect(r.disclaimer).toBe(SAFE_HARBOR_DISCLAIMER);
    expect(r.disclaimer).toMatch(/not a valuation/i);
    expect(r.disclaimer).toMatch(/no IRS safe-harbor/i);
    expect(r.disclaimer).toMatch(/must not be used to set option strike prices/i);
  });

  it('stays finite at the extremes of the accepted input range', () => {
    const r = estimateFmv({
      stage: 'pre_seed',
      round_age: 'under_6m',
      post_money: 1e12,
      capital_raised: 1e12,
      revenue_ltm: 1e12,
      profit_ltm: 1e12,
      fully_diluted_shares: 1e15,
    });
    for (const v of [r.equity_value, r.common_allocation, r.common_fmv, r.per_share!]) {
      expect(Number.isFinite(v.p10)).toBe(true);
      expect(Number.isFinite(v.median)).toBe(true);
      expect(Number.isFinite(v.p90)).toBe(true);
    }
    // And at the bottom: a single dollar of revenue still yields a real band.
    const tiny = estimateFmv({ stage: 'pre_seed', round_age: 'never', revenue_ltm: 1 });
    expect(ordered(tiny.equity_value)).toBe(true);
    expect(tiny.per_share).toBeNull();
  });
});
