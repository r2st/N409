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
    income: {
      free_cash_flows: [1e6, 2e6, 3e6],
      revenues: [5e6, 8e6, 12e6],
      discount_rate: 0.25,
      terminal_growth: 0.03,
    },
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

  it('carries a participation cap on a participating class', () => {
    const parsed = EngineInputsBody.parse({
      share_classes: [
        { kind: 'common', name: 'Common', shares: 8_000_000 },
        {
          kind: 'preferred',
          name: 'Series A',
          shares: 4_000_000,
          preference: 10_000_000,
          participating: true,
          participation_cap: 20_000_000,
        },
      ],
    });
    expect(parsed.share_classes?.[1]).toMatchObject({ participating: true, participation_cap: 20_000_000 });
  });

  it('treats an absent participation cap as uncapped rather than defaulting one', () => {
    const parsed = EngineInputsBody.parse(fullModel);
    const series = parsed.share_classes?.find((c) => c.name === 'Series A');
    expect(series).not.toHaveProperty('participation_cap', expect.any(Number));
  });

  it('rejects a participation cap that is not a positive number', () => {
    for (const participation_cap of [0, -1, 'lots']) {
      const res = EngineInputsBody.safeParse({
        share_classes: [
          { kind: 'common', name: 'Common', shares: 100 },
          {
            kind: 'preferred',
            name: 'A',
            shares: 100,
            preference: 1000,
            participating: true,
            participation_cap,
          },
        ],
      });
      expect(res.success, String(participation_cap)).toBe(false);
    }
  });

  it('leaves the cap-versus-preference rule to the engine, which owns it', () => {
    // A cap at or below the preference, and a cap on a non-participating class,
    // are both refusals — but they are refusals the pre-flight validator and
    // the allocation state in one voice. Restating them here would let the two
    // drift; the schema's job is the shape.
    const res = EngineInputsBody.safeParse({
      share_classes: [
        { kind: 'common', name: 'Common', shares: 100 },
        { kind: 'preferred', name: 'A', shares: 100, preference: 1000, participation_cap: 500 },
      ],
    });
    expect(res.success).toBe(true);
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

  /*
   * The DCF's two methodology choices. The engine has read all of these, and
   * validated them, since it learned to; this object is `.strict()`, so every
   * one of them was a 400 and no engagement could be stored with the mid-year
   * convention or an exit-multiple terminal value it asked for.
   */
  describe('DCF methodology choices', () => {
    it('accepts the mid-year convention', () => {
      const res = EngineInputsBody.safeParse({
        income: { discount_rate: 0.25, terminal_growth: 0.03, mid_year_convention: true },
      });
      expect(res.success).toBe(true);
      expect(res.success && res.data.income?.mid_year_convention).toBe(true);
    });

    it('accepts an exit-multiple terminal value with its metric and basis', () => {
      const res = EngineInputsBody.safeParse({
        income: {
          discount_rate: 0.25,
          terminal_method: 'exit_multiple',
          exit_multiple: 8.5,
          terminal_metric: 4_400_000,
          terminal_metric_basis: 'ebitda',
        },
      });
      expect(res.success).toBe(true);
      expect(res.success && res.data.income?.exit_multiple).toBe(8.5);
    });

    it('refuses an exit-multiple terminal value with no multiple to strike', () => {
      const res = EngineInputsBody.safeParse({
        income: { discount_rate: 0.25, terminal_method: 'exit_multiple' },
      });
      expect(res.success).toBe(false);
    });

    it('lets an exit multiple sit below the terminal growth rate, which capitalises nothing', () => {
      // The Gordon inequality is a Gordon rule: a perpetuity diverges as the
      // rate approaches growth, and a sale at 8x EBITDA does not.
      const res = EngineInputsBody.safeParse({
        income: {
          discount_rate: 0.03,
          terminal_growth: 0.05,
          terminal_method: 'exit_multiple',
          exit_multiple: 8.5,
        },
      });
      expect(res.success).toBe(true);
    });

    it('still holds a Gordon run to the inequality when the method is named explicitly', () => {
      const res = EngineInputsBody.safeParse({
        income: { discount_rate: 0.03, terminal_growth: 0.05, terminal_method: 'gordon' },
      });
      expect(res.success).toBe(false);
    });

    it('refuses a non-positive metric to strike a multiple against', () => {
      const res = EngineInputsBody.safeParse({
        income: { terminal_method: 'exit_multiple', exit_multiple: 8.5, terminal_metric: -1 },
      });
      expect(res.success).toBe(false);
    });

    it('refuses an unknown terminal method and an implausible multiple', () => {
      expect(EngineInputsBody.safeParse({ income: { terminal_method: 'liquidation' } }).success).toBe(false);
      expect(
        EngineInputsBody.safeParse({
          income: { terminal_method: 'exit_multiple', exit_multiple: 850 },
        }).success,
      ).toBe(false);
    });
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
    const res = EngineInputsBody.safeParse({
      volatility: null,
      income: null,
      market: null,
      share_classes: null,
    });
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
