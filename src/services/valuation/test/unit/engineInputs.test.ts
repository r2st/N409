import { describe, expect, it } from 'vitest';
import { EngineInputsBody } from '../../src/routes/engineInputs.js';

/** Schema mirrors the compute engine (compute.py + waterfall.py). */
describe('EngineInputsBody', () => {
  const fullModel = {
    shares_outstanding_common: 8_000_000,
    shares_outstanding_preferred: 2_000_000,
    options_outstanding: 500_000,
    liquidation_preference: 5_000_000,
    volatility: 0.6,
    risk_free_rate: 0.043,
    time_to_exit_years: 4,
    cash: 1_000_000,
    debt: 250_000,
    last_round_post_money: 20_000_000,
    last_round_price_per_share: 2.5,
    last_round_class: 'Series A',
    asset: { total_assets: 3_000_000, total_liabilities: 1_000_000 },
    income: { free_cash_flows: [1e6, 2e6, 3e6], revenues: [5e6, 8e6, 12e6], discount_rate: 0.25, terminal_growth: 0.03 },
    market: { metric: 4_000_000, multiples: [3.5, 5, 6.2] },
    share_classes: [
      { kind: 'common', name: 'Common', shares: 8_000_000 },
      { kind: 'preferred', name: 'Series A', shares: 2_000_000, preference: 5_000_000 },
      { kind: 'option', name: 'Option Pool', shares: 500_000, strike: 0.5 },
    ],
  };

  it('accepts a complete hand-entered model', () => {
    const parsed = EngineInputsBody.parse(fullModel);
    expect(parsed.income?.free_cash_flows).toEqual([1e6, 2e6, 3e6]);
    expect(parsed.market?.multiples).toEqual([3.5, 5, 6.2]);
  });

  it('applies preferred-class defaults (seniority, participating, conversion_ratio)', () => {
    const parsed = EngineInputsBody.parse(fullModel);
    const series = parsed.share_classes?.find((c) => c.name === 'Series A');
    expect(series).toMatchObject({ seniority: 1, participating: false, conversion_ratio: 1 });
  });

  it('rejects unknown top-level fields', () => {
    expect(EngineInputsBody.safeParse({ ...fullModel, bogus: 1 }).success).toBe(false);
  });

  it('requires a common class when share_classes are given', () => {
    const res = EngineInputsBody.safeParse({
      share_classes: [{ kind: 'preferred', name: 'A', shares: 100, preference: 1000 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects duplicate share class names', () => {
    const res = EngineInputsBody.safeParse({
      share_classes: [
        { kind: 'common', name: 'Common', shares: 100 },
        { kind: 'common', name: 'Common', shares: 50 },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects last_round_class that names no share class', () => {
    const res = EngineInputsBody.safeParse({
      last_round_class: 'Series Z',
      share_classes: [{ kind: 'common', name: 'Common', shares: 100 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects a discount rate at or below terminal growth', () => {
    const res = EngineInputsBody.safeParse({ income: { discount_rate: 0.03, terminal_growth: 0.05 } });
    expect(res.success).toBe(false);
  });

  it('rejects non-positive common shares and negative preferences', () => {
    expect(EngineInputsBody.safeParse({ shares_outstanding_common: 0 }).success).toBe(false);
    expect(
      EngineInputsBody.safeParse({
        share_classes: [
          { kind: 'common', name: 'C', shares: 100 },
          { kind: 'preferred', name: 'A', shares: 100, preference: -1 },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires a strike for option classes', () => {
    const res = EngineInputsBody.safeParse({
      share_classes: [
        { kind: 'common', name: 'C', shares: 100 },
        { kind: 'option', name: 'Pool', shares: 10 },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('accepts explicit nulls to clear fields/sections', () => {
    const res = EngineInputsBody.safeParse({ volatility: null, income: null, market: null, share_classes: null });
    expect(res.success).toBe(true);
  });

  it('accepts an empty patch', () => {
    expect(EngineInputsBody.safeParse({}).success).toBe(true);
  });

  it('accepts PWERM scenarios and defaults time_to_exit_years', () => {
    const res = EngineInputsBody.safeParse({
      pwerm: {
        discount_rate: 0.25,
        scenarios: [
          { name: 'IPO', type: 'ipo', probability: 0.4, equity_value: 20_000_000, time_to_exit_years: 2 },
          { name: 'Liquidation', type: 'liquidation', probability: 0.6, enterprise_value: 5_000_000 },
        ],
      },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.pwerm?.scenarios?.[1]?.time_to_exit_years).toBe(0);
    }
  });

  it('rejects a PWERM scenario without an exit value', () => {
    const res = EngineInputsBody.safeParse({
      pwerm: { scenarios: [{ probability: 1, time_to_exit_years: 1 }] },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an unknown PWERM scenario type', () => {
    const res = EngineInputsBody.safeParse({
      pwerm: { scenarios: [{ probability: 1, equity_value: 1_000_000, type: 'spac' }] },
    });
    expect(res.success).toBe(false);
  });

  it('accepts hybrid blend weights', () => {
    const res = EngineInputsBody.safeParse({ hybrid: { opm_weight: 0.4, pwerm_weight: 0.6 } });
    expect(res.success).toBe(true);
  });

  it('rejects hybrid weights outside [0, 1]', () => {
    const res = EngineInputsBody.safeParse({ hybrid: { opm_weight: 1.4, pwerm_weight: -0.4 } });
    expect(res.success).toBe(false);
  });

  it('rejects unknown keys in the hybrid block', () => {
    const res = EngineInputsBody.safeParse({ hybrid: { opm_weight: 0.5, bogus: 1 } });
    expect(res.success).toBe(false);
  });
});
