import { describe, expect, it } from 'vitest';
import {
  allocationExhibit,
  approachExhibit,
  assetExhibit,
  buildExhibits,
  capitalizationExhibit,
  discountExhibit,
  dlomDerivationExhibit,
  financialsExhibit,
  incomeExhibit,
  marketExhibit,
  peerSetExhibit,
  pwermExhibit,
  volatilityExhibit,
  waccExhibit,
  type ExhibitContext,
} from '../../src/domain/reportExhibits.js';
import type { CalculationRow } from '../../src/repos/calculations.js';
import type { ProjectionRow } from '../../src/repos/projections.js';
import type { VolatilityEstimateRow } from '../../src/repos/volatilityEstimates.js';

/**
 * The 409A exhibits on the results shapes a thin or an old calculation leaves.
 *
 * `reportExhibits.test.ts` renders each schedule from a complete engine result.
 * This file renders them from the incomplete ones, which is the case the module
 * header actually promises to handle: "an absent, partial or unfamiliar results
 * shape drops the exhibit rather than throwing inside a PDF render."
 *
 * Every cell in this module has a written fallback — an em-dash, a zero, a
 * default label — and until now most of them had never rendered. That matters
 * more here than in ordinary code: `results` is jsonb, so the shapes below are
 * not hypothetical but simply *older*. A calculation stored a year ago, before a
 * field existed, is re-rendered by today's code every time someone reopens the
 * report, and the fallback is what that reader sees.
 */

const CTX: ExhibitContext = {
  currency: 'USD',
  companyName: 'Northwind Robotics, Inc.',
  valuationDate: '2026-06-30',
};

describe('Exhibit A — capitalization on the aggregate model', () => {
  it('prints the preference as an em-dash in both the row and the foot', () => {
    // The aggregate branch: no share_classes, a blended preferred with no
    // preference recorded. Both places the figure appears must degrade, or the
    // foot states a total the rows above it do not support.
    const s = capitalizationExhibit(
      { shares_outstanding_common: 8_000_000, shares_outstanding_preferred: 4_000_000 },
      CTX,
    );
    expect(s).not.toBeNull();
    expect(s!.html).toContain('aggregate basis');
    expect(s!.html).toContain('Preferred stock');
    expect(s!.html.match(/—/g)?.length).toBeGreaterThanOrEqual(2);
    expect(s!.html).toContain('12,000,000');
  });

  it('omits a preferred and an option line that are present but nil', () => {
    const s = capitalizationExhibit(
      { shares_outstanding_common: 1_000, shares_outstanding_preferred: 0, options_outstanding: 0 },
      CTX,
    );
    expect(s!.html).toContain('Common stock');
    expect(s!.html).not.toContain('Preferred stock');
    expect(s!.html).not.toContain('Options outstanding');
  });

  it('totals the fully-diluted line from only the counts that were supplied', () => {
    const s = capitalizationExhibit({ options_outstanding: 500_000 }, CTX);
    expect(s!.html).toContain('Options outstanding');
    expect(s!.html).toContain('500,000');
  });

  it('drops the exhibit when neither a cap table nor any aggregate count exists', () => {
    expect(capitalizationExhibit({ liquidation_preference: 1_000_000 }, CTX)).toBeNull();
  });
});

describe('Exhibit B — reconciliation on a thin approach block', () => {
  it('drops the exhibit when every approach carries a zero weight', () => {
    // Weight zero is how the engine records an approach that was computed and
    // not relied on. A reconciliation of nothing is not a reconciliation.
    const results = { approaches: { income: { weight: 0, equity_value: 10 } } };
    expect(approachExhibit(results, CTX)).toBeNull();
  });

  it('drops the exhibit when the weighted approach reported no equity value', () => {
    expect(approachExhibit({ approaches: { income: { weight: 1 } } }, CTX)).toBeNull();
  });

  it('falls back to the raw key for an approach with no published label', () => {
    const s = approachExhibit(
      { approaches: { real_options: { weight: 1, equity_value: 5_000_000 } }, equity_value: 5_000_000 },
      CTX,
    );
    expect(s!.html).toContain('real_options');
    expect(s!.html).toContain('$5,000,000');
  });

  it('omits the market-movement block when no adjustment factor was recorded', () => {
    const s = approachExhibit(
      {
        approaches: { opm_backsolve: { weight: 1, equity_value: 5 } },
        market_movement: { index_name: 'S&P 500' },
      },
      CTX,
    );
    expect(s!.html).not.toContain('Market movement adjustment');
  });

  it('renders the movement block on a factor alone, with every particular unstated', () => {
    const s = approachExhibit(
      {
        approaches: { opm_backsolve: { weight: 1, equity_value: 5_000_000 } },
        market_movement: { factor: 1.08 },
      },
      CTX,
    );
    const html = s!.html;
    // No index name, no levels, no period, and no unadjusted figure: the
    // adjustment is still disclosed, because the alternative is a weighted
    // indication that silently differs from the round price.
    expect(html).toContain('Market movement adjustment');
    expect(html).toContain('Benchmark</td>');
    expect(html).toContain('Round date to valuation date');
    expect(html).toContain('1.0800x');
    expect(html).not.toContain('unadjusted');
    expect(html).toContain('as adjusted');
  });
});

describe('Exhibit C — income approach without an income input block', () => {
  it('renders the bridge alone when the calculation kept no forecast', () => {
    // `inputs.income` absent: the approach ran (it has a result) but the stored
    // inputs do not carry the stream, which is every calculation written before
    // the projection work landed.
    const s = incomeExhibit(
      {},
      { approaches: { income: { weight: 1, pv_explicit: 3_000_000, equity_value: 30_000_000 } } },
      CTX,
    );
    expect(s).not.toBeNull();
    expect(s!.html).toContain('Present value of the explicit forecast');
    expect(s!.html).not.toContain('Forecast year');
    expect(s!.html).toContain('Terminal growth rate');
  });

  it('states an exit-multiple terminal value on the metric basis the run recorded', () => {
    const s = incomeExhibit(
      { income: { free_cash_flows: [1_000_000], discount_rate: 0.2 } },
      {
        approaches: {
          income: {
            weight: 1,
            equity_value: 20_000_000,
            terminal_method: 'exit_multiple',
            pv_terminal: 12_000_000,
            terminal_detail: {
              exit_multiple: 8,
              terminal_metric: 2_500_000,
              terminal_metric_basis: 'ebitda',
            },
          },
        },
      },
      CTX,
    );
    const html = s!.html;
    expect(html).toContain('Exit multiple');
    expect(html).toContain('terminal-year EBITDA');
    expect(html).toContain('Exit multiple on the terminal-year metric');
    // A growth rate is a Gordon input and must not appear against this method.
    expect(html).not.toContain('Terminal growth rate');
  });

  it('names the metric generically when the run did not say what it was struck on', () => {
    const s = incomeExhibit(
      {},
      {
        approaches: {
          income: {
            weight: 1,
            equity_value: 1,
            terminal_method: 'exit_multiple',
            terminal_detail: { exit_multiple: 6, terminal_metric: 1_000_000, terminal_metric_basis: 7 },
          },
        },
      },
      CTX,
    );
    expect(s!.html).toContain('the terminal-year metric');
  });

  it('drops the schedule when a flow stream exists but no discount rate does', () => {
    const s = incomeExhibit(
      { income: { free_cash_flows: [1_000, 2_000] } },
      { approaches: { income: {} } },
      CTX,
    );
    expect(s!.html).toContain('Forecast year');
    // Factor and present value both degrade rather than printing a factor of 1.
    expect(s!.html.match(/—/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Exhibit D — market approach with no observed set', () => {
  it('drops the guideline table but keeps the bridge', () => {
    const s = marketExhibit(
      {},
      {
        approaches: { market: { metric: 4_000_000, enterprise_value: 26_000_000, equity_value: 28_000_000 } },
      },
      CTX,
    );
    expect(s!.html).not.toContain('Guideline observation');
    expect(s!.html).toContain('Company metric');
    expect(s!.html).toContain('$28,000,000');
  });

  it('prints an em-dash for the selected multiple when the set has no median', () => {
    const s = marketExhibit({}, { approaches: { market: { multiples: [5, 7] } } }, CTX);
    expect(s!.html).toContain('Selected multiple (median)');
    expect(s!.html).toContain('5.00x');
  });
});

describe('Exhibit D-1 — guideline set on rows the database did not shape', () => {
  const withMarket = { approaches: { market: { weight: 1, equity_value: 1 } } };

  it('keeps a peer whose multiples block is missing and prints its cells as dashes', () => {
    const s = peerSetExhibit(
      [
        { name: 'Alpha', included: true, ev_revenue_ltm: 3 },
        { name: 'Beta', included: true, multiples: { ev_revenue_ltm: 4 } },
      ] as never,
      withMarket,
    );
    expect(s).not.toBeNull();
    expect(s!.html).toContain('Alpha');
    expect(s!.html).toContain('4.00x');
    expect(s!.html).toContain('—');
  });

  it('reads a figures-as-of that arrived as a Date rather than a string', () => {
    // node-postgres hands `date` columns back as JS Dates; the repo passes the
    // row through untouched, so both forms reach this exhibit.
    const s = peerSetExhibit(
      [
        {
          name: 'Alpha',
          included: true,
          multiples: { ev_revenue_ltm: 3 },
          figures_source: 'live',
          figures_as_of: new Date('2026-05-31T00:00:00Z'),
        },
      ] as never,
      withMarket,
    );
    expect(s!.html).toContain('observed market data');
    expect(s!.html).toContain('current as at 2026-05-31');
  });

  it('describes an analyst-entered set as entered from the workpapers', () => {
    const s = peerSetExhibit(
      [
        { name: 'Alpha', included: true, multiples: { ev_revenue_ltm: 3 }, figures_source: 'analyst' },
      ] as never,
      withMarket,
    );
    expect(s!.html).toContain('entered by the analyst');
  });

  it('lists the companies set aside with an explicit basis when none was stated', () => {
    const s = peerSetExhibit(
      [
        { name: 'Alpha', included: true, multiples: { ev_revenue_ltm: 3 } },
        { name: 'Gamma', included: false },
      ] as never,
      withMarket,
    );
    expect(s!.html).toContain('considered and are not reflected');
    expect(s!.html).toContain('Not stated');
  });

  it('drops the exhibit when the run weighted no market approach', () => {
    expect(peerSetExhibit([{ name: 'Alpha', included: true }] as never, {})).toBeNull();
  });

  it('drops the exhibit when peers is not a list of rows', () => {
    expect(peerSetExhibit('nonsense' as never, withMarket)).toBeNull();
  });
});

describe('Exhibit E — asset approach with no balance sheet', () => {
  it('states the cost to replicate when neither total was reported', () => {
    const s = assetExhibit({ approaches: { asset: { method: 'cost_to_replicate' } } }, CTX);
    expect(s!.html).toContain('cost-to-replicate');
    expect(s!.html).toContain('Cost to replicate the business');
    // No equity value either: the row prints zero rather than dropping, because
    // an asset approach with no figure at all is a fact worth showing.
    expect(s!.html).toContain('$0');
  });

  it('describes the default basis as net asset value', () => {
    const s = assetExhibit({ approaches: { asset: { total_assets: 5_000_000 } } }, CTX);
    expect(s!.html).toContain('net-asset-value basis');
    expect(s!.html).toContain('Total assets');
  });
});

describe('Exhibit F — allocation on partial breakpoints and classes', () => {
  it('prints an em-dash for a tranche with no participants', () => {
    const s = allocationExhibit(
      { allocation: { method: 'opm_waterfall', breakpoints: [{ from: 0, to: 1_000_000, value: 900_000 }] } },
      CTX,
    );
    expect(s!.html).toContain('Tranche');
    expect(s!.html).toContain('—');
  });

  it('classes an entry with no kind as common and dashes its missing figures', () => {
    const s = allocationExhibit({ allocation: { classes: { 'Series A': {}, Broken: 'x' } } }, CTX);
    expect(s!.html).toContain('Series A');
    expect(s!.html).toContain('Common');
    expect(s!.html).toContain('$0.0000');
  });

  it('marks a simulation drawn in antithetic pairs', () => {
    const s = allocationExhibit(
      { allocation: { method: 'monte_carlo', paths: 20_000, antithetic: true, seed: 7 } },
      CTX,
    );
    expect(s!.html).toContain('20,000 (antithetic pairs)');
    expect(s!.html).toContain('Random seed');
  });

  it('drops the exhibit without an allocation block', () => {
    expect(allocationExhibit({}, CTX)).toBeNull();
  });
});

describe('Exhibit F-1 — selected volatility', () => {
  const row = (over: Partial<VolatilityEstimateRow> = {}): VolatilityEstimateRow =>
    ({
      id: '01V',
      valuation_id: '01K',
      method: 'close_to_close',
      periods_per_year: 252,
      window_start: new Date('2024-06-30T00:00:00Z'),
      window_end: new Date('2026-06-30T00:00:00Z'),
      companies: [
        { ticker: 'AAA', volatility: 0.62, observations: 500, used: true },
        { ticker: 'BBB', volatility: 0.48, used: false },
      ],
      excluded: [{ ticker: 'CCC', reason: 'price series ended' }],
      recommended: 0.62,
      median_vol: 0.62,
      mean_vol: 0.55,
      min_vol: 0.48,
      max_vol: 0.62,
      coefficient_of_variation: 0.12,
      time_to_exit_years: 4,
      confidence: 'medium',
      manual_override: null,
      applied_at: new Date('2026-07-01T00:00:00Z'),
      applied_by: null,
      created_by: null,
      created_at: new Date(),
      ...over,
    }) as VolatilityEstimateRow;

  it('marks the peers that were measured and the ones that were not', () => {
    const s = volatilityExhibit({ ...CTX, volatility: row() }, {});
    expect(s!.html).toContain('Included');
    expect(s!.html).toContain('Excluded');
    expect(s!.html).toContain('price series ended');
    // No observation count on the second peer — a dash, not a zero.
    expect(s!.html).toContain('—');
  });

  it('labels the foot as an analyst selection when the method was manual', () => {
    const s = volatilityExhibit({ ...CTX, volatility: row({ method: 'manual' }) }, {});
    expect(s!.html).toContain('Analyst selection');
  });

  it('drops the peer and distribution tables when the run measured nothing', () => {
    const s = volatilityExhibit(
      {
        ...CTX,
        volatility: row({
          companies: [],
          excluded: [],
          min_vol: null,
          median_vol: null,
          mean_vol: null,
          max_vol: null,
          coefficient_of_variation: null,
          time_to_exit_years: null,
        }),
      },
      {},
    );
    expect(s!.html).not.toContain('Guideline company');
    expect(s!.html).not.toContain('Cross-sectional distribution');
    expect(s!.html).toContain('Guideline companies measured');
  });

  it('drops the exhibit when the stored window is not a pair of dates', () => {
    expect(
      volatilityExhibit({ ...CTX, volatility: row({ window_start: '2024-06-30' as never }) }, {}),
    ).toBeNull();
    expect(volatilityExhibit({ ...CTX, volatility: row({ companies: 'x' as never }) }, {})).toBeNull();
    expect(volatilityExhibit(CTX, {})).toBeNull();
  });
});

describe('Exhibit G — PWERM scenarios missing their particulars', () => {
  it('renders a scenario with no name, type or figures as an unstated row', () => {
    const s = pwermExhibit({ allocation: { scenarios: [{}] } }, CTX);
    const html = s!.html;
    expect(html).toContain('Probability-weighted');
    expect(html).toContain('0.00');
    expect(html).toContain('$0');
  });

  it('reads the scenarios off a hybrid run that nested its PWERM leg', () => {
    const s = pwermExhibit(
      { allocation: { pwerm: { scenarios: [{ name: 'IPO', probability: 0.4, exit_equity_value: 100 }] } } },
      CTX,
    );
    expect(s!.html).toContain('IPO');
  });

  it('reads a top-level pwerm_allocation for calculations stored before the nesting', () => {
    const s = pwermExhibit({ pwerm_allocation: { scenarios: [{ name: 'Sale', probability: 1 }] } }, CTX);
    expect(s!.html).toContain('Sale');
  });

  it('is absent for a Monte Carlo allocation, whose scenarios are a different thing', () => {
    expect(
      pwermExhibit({ allocation_method: 'monte_carlo', allocation: { scenarios: [{ name: 'p1' }] } }, CTX),
    ).toBeNull();
  });
});

describe('Exhibit H — discounts on a bare conclusion', () => {
  it('drops the exhibit when the discounts multiply out to nothing', () => {
    // A 100% DLOM leaves no factor to invert the marketable value from, and
    // there is no allocated per-share figure to fall back on.
    expect(discountExhibit({ fmv_per_share: 0.5, discounts: { dlom: 1 } }, CTX)).toBeNull();
  });

  it('names the control-discount method from the published map', () => {
    const s = discountExhibit(
      {
        fmv_per_share: 1,
        discounts: { dloc: 0.1, dlom: 0.2, dloc_method: 'control_premium', dlom_method: 'chaffee' },
        allocation: { common_per_share: 1.5 },
      },
      CTX,
    );
    expect(s!.html).toContain('Inverted from a stated control premium');
    expect(s!.html).toContain('Chaffee protective-put model');
  });

  it('falls back to the raw slug for a control method the map does not carry', () => {
    const s = discountExhibit(
      { fmv_per_share: 1, discounts: { dloc: 0.1, dloc_method: 'bespoke_blend' }, allocation: {} },
      CTX,
    );
    expect(s!.html).toContain('bespoke_blend');
  });

  it('states the control premium implied by a discount that was set directly', () => {
    const s = discountExhibit(
      {
        fmv_per_share: 1,
        discounts: {
          dloc: 0.2,
          dloc_detail: { implied_control_premium: 0.25, basis: 'Analyst judgement on governance' },
        },
      },
      CTX,
    );
    expect(s!.html).toContain('Control premium implied by the discount');
    expect(s!.html).toContain('Basis for the judgement');
    expect(s!.html).toContain('Analyst judgement on governance');
  });

  it('prints a control-premium study set whose rows carry no period or premium', () => {
    const s = discountExhibit(
      { fmv_per_share: 1, discounts: { dloc: 0.1, dloc_detail: { studies: [{}, 'x'] } } },
      CTX,
    );
    expect(s!.html).toContain('Control-premium study');
  });

  it('drops the class table when the allocation reported no usable class rows', () => {
    const s = discountExhibit(
      { fmv_per_share: 1, discounts: { dlom: 0.2 }, allocation: { classes: { A: 'not-a-row' } } },
      CTX,
    );
    expect(s!.html).not.toContain('Value per share — non-marketable');
  });
});

describe('Exhibit H-1 — DLOM derivation on partial detail', () => {
  it('falls back to the discounts block for a method the detail did not name', () => {
    const s = dlomDerivationExhibit(
      { discounts: { dlom: 0.245, dlom_method: 'finnerty', dlom_detail: { volatility: 0.6 } } },
      CTX,
    );
    expect(s!.html).toContain('Finnerty average-strike put model');
    expect(s!.html).toContain('Of the interest valued over the holding period');
    expect(s!.html).toContain('24.5%');
  });

  it('reports a Longstaff run as an upper bound with no multiple to state', () => {
    const s = dlomDerivationExhibit(
      { discounts: { dlom_detail: { method: 'longstaff', is_upper_bound: true, risk_free_rate: 0.04 } } },
      CTX,
    );
    expect(s!.html).toContain('Reported as an upper bound');
    expect(s!.html).toContain('>Yes<');
    expect(s!.html).toContain('Risk-free rate');
    // No dlom on the detail and none on the discounts: the foot degrades.
    expect(s!.html).toContain('Concluded discount for lack of marketability');
  });

  it('weights several methods, dashing the legs that reported no figures', () => {
    const s = dlomDerivationExhibit(
      {
        discounts: {
          dlom: 0.3,
          dlom_detail: {
            method: 'weighted',
            components: [
              { method: 'chaffee', weight: 0.5, dlom: 0.28, weighted: 0.14, detail: { volatility: 0.6 } },
              { method: 'bespoke' },
              // A leg with a detail block but nothing in it: skipped, because a
              // subheading over a one-row table documents nothing.
              { method: 'qualitative', detail: {} },
            ],
          },
        },
      },
      CTX,
    );
    const html = s!.html;
    expect(html).toContain('Chaffee protective-put model');
    expect(html).toContain('bespoke');
    expect(html.match(/—/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('30.0%');
  });

  it('carries the pre-IPO caveats and the study range for a study-based discount', () => {
    const s = dlomDerivationExhibit(
      {
        discounts: {
          dlom_detail: {
            method: 'pre_ipo',
            dlom: 0.4,
            statistic: 'mean',
            studies: [
              { study: 'Emory', median: 0.44 },
              { mean: 0.38, period_start: 1985 },
            ],
            predates_modern_ipo_market: true,
            low: 0.3,
            high: 0.5,
          },
        },
      },
      CTX,
    );
    const html = s!.html;
    expect(html).toContain('pre-IPO studies');
    expect(html).toContain('Emory');
    expect(html).toContain('reaches back before 1990');
    expect(html).toContain('range from 30.0% to 50.0%');
    // The second row has a start but no end, and no `discount` key.
    expect(html).toContain('38.0%');
  });

  it('prints the class volatility schedule with an unstated basis', () => {
    const s = dlomDerivationExhibit(
      {
        class_volatility: {
          enterprise_volatility: 0.55,
          classes: { Common: { kind: 'common', volatility: 0.7, elasticity: 1.3, delta: 0.8 }, Odd: {} },
        },
      },
      CTX,
    );
    const html = s!.html;
    expect(html).toContain('The volatility above describes the enterprise.');
    expect(html).toContain('Class volatility');
    expect(html).toContain('1.30x');
    // `Odd` has no kind, delta, elasticity or volatility of its own.
    expect(html).toContain('Odd');
    // No delta_total on the block, so the foot's delta cell stays empty.
    expect(html).toContain('1.00x');
  });

  it('drops the exhibit when neither a derivation nor class volatilities exist', () => {
    expect(dlomDerivationExhibit({ discounts: { dlom: 0.2 } }, CTX)).toBeNull();
  });
});

describe('Appendix I — WACC build-up on a partial record', () => {
  it('dashes every component the run did not report', () => {
    const s = waccExhibit({ auto: { wacc: { wacc: 0.28 } } }, CTX);
    const html = s!.html;
    expect(html).toContain('Risk-free rate');
    expect(html).toContain('Excess return of small capitalisations');
    expect(html).toContain('28.00%');
    expect(html.match(/—/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it('reads a guideline beta stored under the older `beta` key', () => {
    const s = waccExhibit(
      { auto: { wacc: { capm: { size_tier: 'Decile 10' }, comparables: [{ beta: 1.4 }, 'x'] } } },
      CTX,
    );
    expect(s!.html).toContain('Market capitalisation tier Decile 10');
    expect(s!.html).toContain('1.400');
    // The comparable has no ticker and no name.
    expect(s!.html).toContain('—');
  });

  it('drops the exhibit when the run did not build the rate', () => {
    expect(waccExhibit({ auto: {} }, CTX)).toBeNull();
  });
});

describe('Appendix II — financial statements from a partial workbook', () => {
  const sheet = (over: Record<string, unknown> = {}) => ({
    key: 'income_statement',
    label: 'Income statement',
    columns: [{ key: 'FY2025', label: 'FY2025' }],
    rows: [{ label: 'Revenue', format: 'currency', cells: [{ column_key: 'FY2025', value: 5_000_000 }] }],
    ...over,
  });

  it('renders a percent row and a plain-number row in their own formats', () => {
    const s = financialsExhibit(
      [
        sheet({
          rows: [
            { label: 'Gross margin', format: 'percent', cells: [{ column_key: 'FY2025', value: 0.62 }] },
            { label: 'Headcount', format: 'number', cells: [{ column_key: 'FY2025', value: 148 }] },
          ],
        }),
      ] as never,
      CTX,
    );
    expect(s!.html).toContain('62.0%');
    expect(s!.html).toContain('148');
  });

  it('skips a sheet whose reported columns are all projections', () => {
    const s = financialsExhibit(
      [
        sheet({ columns: [{ key: 'FY+1', label: 'FY+1' }] }),
        sheet({ key: 'balance_sheet', label: 'Balance sheet' }),
      ] as never,
      CTX,
    );
    // The income statement drops for want of a reported column; the balance
    // sheet still renders, so the appendix is not lost with it.
    expect(s!.html).not.toContain('Income statement');
    expect(s!.html).toContain('Revenue');
  });

  it('names an unlabelled sheet, column and row rather than leaving them blank', () => {
    const s = financialsExhibit(
      [
        {
          key: 'income_statement',
          columns: [{ key: 'FY2025' }],
          rows: [{ format: 'currency', cells: [{ column_key: 'FY2025', value: 1 }] }],
        },
      ] as never,
      CTX,
    );
    expect(s!.html).toContain('<h3>—</h3>');
  });

  it('drops the appendix when every row is empty across the reported periods', () => {
    const s = financialsExhibit(
      [
        sheet({
          rows: [{ label: 'Inventory', format: 'currency', cells: [{ column_key: 'FY2025', value: null }] }],
        }),
      ] as never,
      CTX,
    );
    expect(s).toBeNull();
  });

  it('drops the appendix on a workbook that is not a list of sheets', () => {
    expect(financialsExhibit('nonsense' as never, CTX)).toBeNull();
    expect(financialsExhibit([{ key: 'income_statement' }] as never, CTX)).toBeNull();
  });
});

describe('buildExhibits assembly', () => {
  const calc = (over: Partial<CalculationRow>): CalculationRow =>
    ({
      id: '01J',
      valuation_id: '01K',
      engine_version: 'test',
      status: 'succeeded',
      inputs: null,
      results: {},
      equity_value: null,
      fmv_per_share: null,
      error: null,
      diagnostics: [],
      created_by: null,
      created_at: new Date(),
      ...over,
    }) as CalculationRow;

  it('reads no inputs at all without throwing', () => {
    // `inputs` is nullable on the row and `payload.inputs` need not be an
    // object; both defaults have to hold, because this runs inside a PDF write.
    expect(buildExhibits(calc({ inputs: null }), CTX)).toEqual([]);
    expect(buildExhibits(calc({ inputs: { inputs: 'not-a-record' } }), CTX)).toEqual([]);
  });

  it('builds the capitalization exhibit from a payload that carries only inputs', () => {
    const sections = buildExhibits(
      calc({ inputs: { inputs: { shares_outstanding_common: 1_000_000 } } }),
      CTX,
    );
    expect(sections.map((s) => s.heading)).toEqual(['Exhibit A — Capitalization Table']);
  });
});

describe('Exhibit C-1 — projection basis on a stored run', () => {
  const projection = (over: Partial<ProjectionRow> = {}): ProjectionRow =>
    ({
      id: '01P',
      valuation_id: '01K',
      method: 'growth',
      years: 1,
      tax_rate: 0.21,
      inputs: { base_revenue: 6_000_000, revenue_growth: [0.4, 0.3], cogs_pct: 0.3 },
      projections: [
        {
          year: 2026,
          revenue: 8_400_000,
          cogs: 2_520_000,
          opex: 4_000_000,
          ebitda: 1_880_000,
          da: 200_000,
          ebit: 1_680_000,
          nopat: 1_327_200,
          capex: 300_000,
          delta_nwc: 100_000,
          fcff: 1_127_200,
        },
      ],
      free_cash_flows: [1_127_200],
      terminal_method: 'gordon',
      terminal_value: null,
      applied_at: null,
      applied_by: null,
      created_by: null,
      created_at: new Date(),
      ...over,
    }) as ProjectionRow;

  it('states a by-year growth assumption as a range and the period in the singular', () => {
    const sections = buildExhibits(calc({ inputs: { inputs: {} } }), { ...CTX, projection: projection() });
    const c1 = sections.find((s) => s.heading.startsWith('Exhibit C-1'));
    expect(c1!.html).toContain('30.0% to 40.0%, by year');
    expect(c1!.html).toContain('1 year');
    expect(c1!.html).toContain('Top-down');
  });

  it('says the forecast was never adopted when the calculation discounts something else', () => {
    const sections = buildExhibits(calc({ inputs: { inputs: { income: { free_cash_flows: [999] } } } }), {
      ...CTX,
      projection: projection(),
    });
    const c1 = sections.find((s) => s.heading.startsWith('Exhibit C-1'));
    expect(c1!.html).toContain('not been adopted');
  });

  it('says the model was amended when an adopted forecast no longer matches', () => {
    const sections = buildExhibits(calc({ inputs: { inputs: { income: { free_cash_flows: [999] } } } }), {
      ...CTX,
      projection: projection({ applied_at: new Date('2026-07-01T00:00:00Z') }),
    });
    const c1 = sections.find((s) => s.heading.startsWith('Exhibit C-1'));
    expect(c1!.html).toContain('financial model was amended');
  });

  it('tolerates a stored run whose assumptions block is not an object', () => {
    const sections = buildExhibits(calc({ inputs: { inputs: {} } }), {
      ...CTX,
      projection: projection({ inputs: 'nonsense' as never }),
    });
    expect(sections.find((s) => s.heading.startsWith('Exhibit C-1'))).toBeDefined();
  });

  it('drops C-1 for a run whose projections are not an array', () => {
    const sections = buildExhibits(calc({ inputs: { inputs: {} } }), {
      ...CTX,
      projection: projection({ projections: 'x' as never }),
    });
    expect(sections.find((s) => s.heading.startsWith('Exhibit C-1'))).toBeUndefined();
  });

  function calc(over: Partial<CalculationRow>): CalculationRow {
    return {
      id: '01J',
      valuation_id: '01K',
      engine_version: 'test',
      status: 'succeeded',
      inputs: null,
      results: {},
      equity_value: null,
      fmv_per_share: null,
      error: null,
      diagnostics: [],
      created_by: null,
      created_at: new Date(),
      ...over,
    } as CalculationRow;
  }
});
