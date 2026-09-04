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
   * The sign of a balance-sheet subtotal (R410, M19).
   *
   * `nonNeg` here was the only statement in the estate that one cannot be
   * negative; the engine warns rather than refuses, and the accounting import
   * writes both figures straight through `applyEngineInputs` from a provider
   * whose liabilities section can net to a debit balance.
   */
  describe('asset subtotals', () => {
    it('accepts a liabilities section that nets negative, as the ledger import writes it', () => {
      const res = EngineInputsBody.safeParse({
        asset: { total_assets: 4_000_000, total_liabilities: -250_000 },
      });
      expect(res.success).toBe(true);
    });

    it('accepts a negative total_assets rather than refusing what the engine only warns about', () => {
      // `validate._check_asset` raises `negative_nav` as a warning when
      // liabilities exceed assets, and nothing refuses either figure's sign.
      expect(
        EngineInputsBody.safeParse({ asset: { total_assets: -1, total_liabilities: 0 } }).success,
      ).toBe(true);
    });

    it('still refuses a negative cost to replicate, which the engine does refuse', () => {
      // `approaches.asset_value`: "asset.cost_to_replicate is required for the
      // cost-to-replicate method" on anything below zero.
      expect(EngineInputsBody.safeParse({ asset: { cost_to_replicate: -1 } }).success).toBe(false);
    });

    it('still bounds the magnitude of both subtotals', () => {
      expect(
        EngineInputsBody.safeParse({ asset: { total_liabilities: -1e999 } }).success,
      ).toBe(false);
      expect(
        EngineInputsBody.safeParse({ asset: { total_assets: Number.MAX_SAFE_INTEGER * 10 } })
          .success,
      ).toBe(false);
    });
  });

  /*
   * The horizon (R406). The projection route runs to 100 years and its adoption
   * writes `income.free_cash_flows` straight through `applyEngineInputs`, so a
   * cap of 30 here refused an array the platform had written itself — and the
   * next save of the model came back 400 on a field the analyst never touched.
   */
  describe('forecast length', () => {
    const flows = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i);

    it('accepts a forecast as long as the engine will price', () => {
      // `projection.MAX_FORECAST_YEARS` — the length a projection run can
      // produce and therefore the length an adoption can store.
      const res = EngineInputsBody.safeParse({ income: { free_cash_flows: flows(100) } });
      expect(res.success).toBe(true);
    });

    it('accepts a forty-year run, which the old cap of 30 refused', () => {
      expect(
        EngineInputsBody.safeParse({
          income: { free_cash_flows: flows(40), revenues: flows(40) },
        }).success,
      ).toBe(true);
    });

    it('still refuses a horizon past the engine’s own bound', () => {
      // Past 100 the engine answers `out_of_range` on the same field, so
      // storing it is storing a document that cannot be computed.
      expect(
        EngineInputsBody.safeParse({ income: { free_cash_flows: flows(101) } }).success,
      ).toBe(false);
      expect(EngineInputsBody.safeParse({ income: { revenues: flows(101) } }).success).toBe(false);
    });
  });

  /*
   * A perpetuity that shrinks (R406). `min(0)` here was the only statement in
   * the estate that a terminal growth rate cannot be negative: the engine
   * floors it at -1 and its own remedy text says "-2% is -0.02", the overwrites
   * registry publishes -0.05 … 0.15 for the same rate, and `healthChecks`
   * warns on a stored growth below zero — a branch nothing could reach.
   */
  describe('a declining perpetuity', () => {
    it('accepts a negative terminal growth rate', () => {
      const res = EngineInputsBody.safeParse({
        income: { discount_rate: 0.14, terminal_growth: -0.02 },
      });
      expect(res.success).toBe(true);
      expect(res.success && res.data.income?.terminal_growth).toBe(-0.02);
    });

    it('accepts the engine’s own floor of -1 — a flow that stops at the horizon', () => {
      const res = EngineInputsBody.safeParse({
        income: { discount_rate: 0.14, terminal_growth: -1 },
      });
      expect(res.success).toBe(true);
    });

    it('refuses a growth rate below the engine’s floor', () => {
      // Below -100% the Gordon numerator `(1 + g)` goes negative while the
      // denominator does not, so a positive final cash flow capitalises to a
      // negative terminal value — and `r > g` is satisfied by every such rate,
      // so nothing else would catch it.
      expect(
        EngineInputsBody.safeParse({ income: { discount_rate: 0.14, terminal_growth: -1.5 } })
          .success,
      ).toBe(false);
    });

    it('leaves r > g satisfied by construction once the growth is negative', () => {
      // `discount_rate` is `positive()`, so a negative growth can never breach
      // the Gordon inequality — the reason widening the floor here does not
      // reopen the divergence the refine below guards.
      expect(
        EngineInputsBody.safeParse({ income: { discount_rate: 0.001, terminal_growth: -0.9 } })
          .success,
      ).toBe(true);
    });
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

  /**
   * Both weights are `nullable()`, so clearing the field in the form stores an
   * explicit null rather than dropping the key — and the engine has to read
   * that as an unset weight, not as a figure it cannot parse. It did not:
   * `resolve_hybrid_weights` reached its 50/50 default only for an *absent*
   * key and answered "hybrid.opm_weight must be a number" for a cleared one,
   * so a document this schema accepts failed on the next Calculate.
   *
   * This test is the half of that contract that lives here. The engine's
   * `TestPreflightAgreesWithTheAllocator` is the other half; neither is
   * meaningful alone.
   */
  it('accepts a cleared hybrid weight, which the engine reads as unset', () => {
    for (const hybrid of [
      { opm_weight: null, pwerm_weight: null },
      { opm_weight: null },
      { pwerm_weight: null },
      {},
    ]) {
      expect(EngineInputsBody.safeParse({ hybrid }).success).toBe(true);
    }
  });

  /**
   * The market-movement window is printed, not computed.
   *
   * `market_movement.py._period` keeps these two out of the arithmetic on
   * purpose — they exist so Exhibit C can state the interval the benchmark
   * levels were read over. `reportExhibits.ts` renders that cell as
   * `${from} to ${to}`, so a pair the wrong way round ships on a signed §409A
   * opinion as a period running backwards, beside a return computed from
   * `index_end / index_start - 1` whose sign then contradicts it.
   *
   * Each end was bounded on its own and nothing compared them. The three study
   * tables in `routes/params.ts` carry this same refinement; this block was the
   * pair that did not.
   */
  describe('market_movement period', () => {
    const window = (period_start: string | null, period_end: string | null) => ({
      market_movement: { index_start: 100, index_end: 110, period_start, period_end },
    });

    it('rejects a window whose end precedes its start', () => {
      const res = EngineInputsBody.safeParse(window('2026-06-30', '2025-01-01'));
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toBe('period_start must not be after period_end');
      expect(res.error?.issues[0]?.path).toContain('period_start');
    });

    it('accepts a window in order, and a single day', () => {
      expect(EngineInputsBody.safeParse(window('2025-01-01', '2026-06-30')).success).toBe(true);
      expect(EngineInputsBody.safeParse(window('2025-01-01', '2025-01-01')).success).toBe(true);
    });

    /**
     * One end alone is undated, not misdated — the exhibit already falls back
     * to "Round date to valuation date" unless it has both.
     */
    it('accepts a block that states one end and not the other', () => {
      expect(EngineInputsBody.safeParse(window('2026-06-30', null)).success).toBe(true);
      expect(EngineInputsBody.safeParse(window(null, '2025-01-01')).success).toBe(true);
      expect(
        EngineInputsBody.safeParse({ market_movement: { index_start: 100, index_end: 110 } }).success,
      ).toBe(true);
    });

    /** The block is nullable, and a refinement must not make null a failure. */
    it('still accepts a cleared block', () => {
      expect(EngineInputsBody.safeParse({ market_movement: null }).success).toBe(true);
    });
  });
});
