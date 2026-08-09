import { describe, expect, it } from 'vitest';
import {
  allocationExhibit,
  approachExhibit,
  assetExhibit,
  buildExhibits,
  capitalizationExhibit,
  discountExhibit,
  dlomDerivationExhibit,
  incomeExhibit,
  marketExhibit,
  peerSetExhibit,
  pwermExhibit,
  waccExhibit,
} from '../../src/domain/reportExhibits.js';
import { ALLOWED_TAGS, sanitizeHtml } from '../../src/domain/report.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

const CONTEXT = {
  currency: 'USD',
  companyName: 'Northwind Robotics, Inc.',
  valuationDate: '2026-06-30',
};

/** The engine payload as `calculations.inputs` stores it: `{ params, inputs }`. */
const INPUTS = {
  valuation_date: '2026-06-30',
  cash: 3_000_000,
  debt: 1_000_000,
  share_classes: [
    { kind: 'common', name: 'Common', shares: 8_000_000 },
    {
      kind: 'preferred',
      name: 'Series A',
      shares: 4_000_000,
      preference: 10_000_000,
      seniority: 1,
      participating: true,
      participation_cap: 20_000_000,
      conversion_ratio: 1,
    },
    { kind: 'option', name: 'Option pool', shares: 1_500_000, strike: 0.85 },
  ],
  income: {
    free_cash_flows: [1_000_000, 1_500_000, 2_200_000],
    revenues: [6_000_000, 9_000_000, 13_000_000],
    discount_rate: 0.25,
    terminal_growth: 0.03,
  },
  market: { metric: 4_000_000, multiples: [5.0, 6.5, 7.1] },
};

const RESULTS = {
  equity_value: 42_000_000,
  fmv_per_share: 1.2345,
  common_equity_value: 19_500_000,
  fully_diluted_common: 8_000_000,
  fully_diluted_basis: 'cap_table_common',
  allocation_method: 'opm',
  approaches: {
    income: {
      weight: 0.25,
      pv_explicit: 3_100_000,
      pv_terminal: 30_900_000,
      enterprise_value: 34_000_000,
      equity_value: 36_000_000,
    },
    market: {
      weight: 0.25,
      metric: 4_000_000,
      multiples: [5.0, 6.5, 7.1],
      selected_multiple: 6.5,
      enterprise_value: 26_000_000,
      equity_value: 28_000_000,
    },
    opm_backsolve: { weight: 0.5, method: 'backsolve_waterfall', equity_value: 52_000_000 },
  },
  allocation: {
    method: 'opm_waterfall',
    common_per_share: 1.828148,
    common_shares: 8_000_000,
    common_value: 14_625_184,
    breakpoints: [
      { from: 0, to: 10_000_000, participants: { 'Series A': 1 }, value: 9_400_000 },
      {
        from: 10_000_000,
        to: 40_000_000,
        participants: { Common: 0.666667, 'Series A': 0.333333 },
        value: 21_000_000,
      },
      { from: 40_000_000, to: null, participants: { Common: 1 }, value: 11_600_000 },
    ],
    classes: {
      Common: { kind: 'common', shares: 8_000_000, value: 14_625_184, per_share: 1.828148 },
      'Series A': { kind: 'preferred', shares: 4_000_000, value: 20_000_000, per_share: 5.0 },
      'Option pool': { kind: 'option', shares: 1_500_000, value: 7_374_816, per_share: 4.916544 },
    },
  },
  assumptions: { time_to_exit_years: 3.5, risk_free_rate: 0.042, volatility: 0.65 },
  discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'chaffee' },
};

function calculation(over: Partial<CalculationRow> = {}): CalculationRow {
  return {
    id: '01J000000000000000000000',
    valuation_id: '01J000000000000000000001',
    engine_version: '1.4.0',
    status: 'succeeded',
    inputs: { params: {}, inputs: INPUTS },
    results: RESULTS,
    equity_value: '42000000',
    fmv_per_share: '1.2345',
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  } as CalculationRow;
}

/** Cell text of a rendered exhibit, tags stripped — what a reader sees. */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// ── assembly ─────────────────────────────────────────────────────────────────

describe('buildExhibits', () => {
  it('produces the schedules the calculation supports, in reading order', () => {
    const headings = buildExhibits(calculation(), CONTEXT).map((s) => s.heading);
    expect(headings).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit B — Reconciliation of Valuation Approaches',
      'Exhibit C — Income Approach (Discounted Cash Flow)',
      'Exhibit D — Market Approach (Guideline Multiples)',
      'Exhibit F — Allocation of Equity Value',
      'Exhibit H — Discounts and Concluded Value',
    ]);
  });

  it('omits an exhibit for an approach the valuation did not apply', () => {
    // No asset approach was weighted, so there is no Exhibit E to draw.
    const headings = buildExhibits(calculation(), CONTEXT).map((s) => s.heading);
    expect(headings).not.toContain('Exhibit E — Asset Approach');
    expect(headings).not.toContain('Exhibit G — Probability-Weighted Expected Return Scenarios');
  });

  it('draws nothing when the engine has not produced a value', () => {
    expect(buildExhibits(null, CONTEXT)).toEqual([]);
    expect(buildExhibits(calculation({ status: 'failed' }), CONTEXT)).toEqual([]);
    expect(buildExhibits(calculation({ results: null }), CONTEXT)).toEqual([]);
  });

  it('survives a partial results document rather than throwing mid-render', () => {
    // Every shape a stored calculation from an older engine could have.
    for (const results of [
      {},
      { equity_value: 1 },
      { approaches: null, allocation: null, discounts: null },
      { approaches: 'not an object', allocation: [], fmv_per_share: 'x' },
      { fmv_per_share: 1.0, allocation: { breakpoints: 'no' }, discounts: { dloc: null } },
    ]) {
      expect(() => buildExhibits(calculation({ results }), CONTEXT)).not.toThrow();
    }
  });

  it('emits only markup the report renderer understands', () => {
    for (const s of buildExhibits(calculation(), CONTEXT)) {
      for (const tag of s.html.matchAll(/<\/?([a-z]+)/g)) {
        expect(ALLOWED_TAGS.has(tag[1]!), `${s.heading}: <${tag[1]}>`).toBe(true);
      }
      // The renderer's own whitelist is the authority; nothing here may be
      // something it would strip.
      expect(sanitizeHtml(s.html)).toBe(s.html);
    }
  });
});

// ── Exhibit A ────────────────────────────────────────────────────────────────

describe('capitalization exhibit', () => {
  it('tabulates every class with the rights that drive the allocation', () => {
    const html = capitalizationExhibit(INPUTS, CONTEXT)!.html;
    const seen = plain(html);
    expect(seen).toContain('Common');
    expect(seen).toContain('Series A');
    expect(seen).toContain('Option pool');
    expect(seen).toContain('8,000,000');
    expect(seen).toContain('$10,000,000'); // aggregate liquidation preference
    expect(seen).toContain('Strike $0.8500');
    expect(seen).toContain('13,500,000'); // total shares
  });

  it('states a participation cap, which decides how much preferred can take', () => {
    const seen = plain(capitalizationExhibit(INPUTS, CONTEXT)!.html);
    expect(seen).toContain('Yes, capped at $20,000,000');
  });

  it('marks an uncapped participating class as uncapped', () => {
    const classes = INPUTS.share_classes.map((c) =>
      c.name === 'Series A' ? { ...c, participation_cap: undefined } : c,
    );
    const seen = plain(capitalizationExhibit({ ...INPUTS, share_classes: classes }, CONTEXT)!.html);
    expect(seen).toContain('Yes, uncapped');
  });

  it('falls back to the aggregate cap table when no class list was supplied', () => {
    const seen = plain(
      capitalizationExhibit(
        {
          shares_outstanding_common: 7_000_000,
          shares_outstanding_preferred: 2_000_000,
          options_outstanding: 1_000_000,
          liquidation_preference: 5_000_000,
        },
        CONTEXT,
      )!.html,
    );
    expect(seen).toContain('aggregate basis');
    expect(seen).toContain('10,000,000'); // fully diluted
    expect(seen).toContain('$5,000,000');
  });

  it('is absent when there is no capitalization to state', () => {
    expect(capitalizationExhibit({}, CONTEXT)).toBeNull();
  });

  it('escapes a class name rather than letting it close a cell', () => {
    const classes = [{ kind: 'common', name: 'Common <b>&</b> Founders', shares: 1_000 }];
    const html = capitalizationExhibit({ share_classes: classes }, CONTEXT)!.html;
    expect(html).toContain('Common &lt;b&gt;&amp;&lt;/b&gt; Founders');
    expect(html).not.toContain('<b>');
  });
});

// ── Exhibit B ────────────────────────────────────────────────────────────────

describe('approach reconciliation exhibit', () => {
  it('shows each indication, its weight and its weighted contribution', () => {
    const seen = plain(approachExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('OPM backsolve');
    expect(seen).toContain('Income (DCF)');
    expect(seen).toContain('Market (comparables)');
    expect(seen).toContain('50%');
    expect(seen).toContain('$26,000,000'); // 52M × 0.5
    expect(seen).toContain('$9,000,000'); // 36M × 0.25
    expect(seen).toContain('$42,000,000'); // concluded equity value
  });

  it('leaves out an approach carrying no weight', () => {
    const results = {
      ...RESULTS,
      approaches: { ...RESULTS.approaches, asset: { weight: 0, equity_value: 5_000_000 } },
    };
    expect(plain(approachExhibit(results, CONTEXT)!.html)).not.toContain('Asset approach');
  });

  it('is absent on a PWERM run, which has no approach block', () => {
    expect(approachExhibit({ ...RESULTS, approaches: undefined }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit C ────────────────────────────────────────────────────────────────

describe('income approach exhibit', () => {
  it('lays out the forecast, the discount factors and the equity bridge', () => {
    const seen = plain(incomeExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('Year 1');
    expect(seen).toContain('Year 3');
    expect(seen).toContain('$1,000,000'); // year 1 free cash flow
    expect(seen).toContain('$6,000,000'); // year 1 revenue
    expect(seen).toContain('0.8000x'); // 1 / 1.25
    expect(seen).toContain('25.00%'); // discount rate
    expect(seen).toContain('3.00%'); // terminal growth
    expect(seen).toContain('$34,000,000'); // enterprise value
    expect(seen).toContain('$36,000,000'); // equity value
  });

  it('bridges enterprise to equity with the cash and debt the engine used', () => {
    const seen = plain(incomeExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$3,000,000'); // cash added
    expect(seen).toContain('-$1,000,000'); // debt deducted
  });

  it('omits the revenue column when revenue was not supplied for every year', () => {
    const inputs = { ...INPUTS, income: { ...INPUTS.income, revenues: [6_000_000] } };
    expect(plain(incomeExhibit(inputs, RESULTS, CONTEXT)!.html)).not.toContain('Revenue');
  });

  it('is absent when the income approach carried no weight', () => {
    expect(incomeExhibit(INPUTS, { ...RESULTS, approaches: {} }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit D ────────────────────────────────────────────────────────────────

describe('market approach exhibit', () => {
  it('lists the observed multiples and names the selected one as the median', () => {
    const seen = plain(marketExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('5.00x');
    expect(seen).toContain('6.50x');
    expect(seen).toContain('7.10x');
    expect(seen).toContain('Selected multiple (median) 6.50x');
    expect(seen).toContain('$26,000,000');
    expect(seen).toContain('$28,000,000');
  });

  it('is absent when the market approach carried no weight', () => {
    expect(marketExhibit(INPUTS, { ...RESULTS, approaches: {} }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit E ────────────────────────────────────────────────────────────────

describe('asset approach exhibit', () => {
  it('nets the balance sheet on the NAV method', () => {
    const results = {
      approaches: {
        asset: {
          weight: 1,
          method: 'nav',
          total_assets: 9_000_000,
          total_liabilities: 2_000_000,
          equity_value: 7_000_000,
        },
      },
    };
    const seen = plain(assetExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('net-asset-value');
    expect(seen).toContain('$9,000,000');
    expect(seen).toContain('-$2,000,000');
    expect(seen).toContain('$7,000,000');
  });

  it('states the rebuild cost on the cost-to-replicate method', () => {
    const results = {
      approaches: { asset: { weight: 1, method: 'cost_to_replicate', equity_value: 3_000_000 } },
    };
    const seen = plain(assetExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('cost-to-replicate');
    expect(seen).toContain('$3,000,000');
  });
});

// ── Exhibit F ────────────────────────────────────────────────────────────────

describe('allocation exhibit', () => {
  it('prints the breakpoint schedule the engine has always computed', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$10,000,000');
    expect(seen).toContain('$40,000,000');
    expect(seen).toContain('and above');
    expect(seen).toContain('Common 66.7%');
    expect(seen).toContain('Series A 33.3%');
  });

  it('names the allocation method in words, not in engine vocabulary', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('Option pricing model');
    expect(seen).not.toContain('OPM_WATERFALL');
  });

  it('states the option-pricing inputs the allocation rests on', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('65.0%'); // volatility
    expect(seen).toContain('3.50 years'); // time to exit
    expect(seen).toContain('4.20%'); // risk-free rate
  });

  it('gives each class its value and value per share', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$14,625,184');
    expect(seen).toContain('$1.8281');
    expect(seen).toContain('$5.0000');
  });

  it('states the single breakpoint on the aggregate model, which has no schedule', () => {
    const results = {
      ...RESULTS,
      allocation: {
        method: 'opm_single_breakpoint',
        breakpoint: 5_000_000,
        upside_after_preference: 18_000_000,
        common_fraction: 0.8,
      },
    };
    const seen = plain(allocationExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('$5,000,000');
    expect(seen).toContain('$18,000,000');
    expect(seen).toContain('80.00%');
  });

  it('is absent when the run recorded no allocation', () => {
    expect(allocationExhibit({ fmv_per_share: 1 }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit G ────────────────────────────────────────────────────────────────

describe('PWERM scenario exhibit', () => {
  const results = {
    equity_value: 30_000_000,
    common_equity_value: 12_000_000,
    allocation_method: 'pwerm',
    assumptions: { expected_time_to_exit_years: 3.1 },
    allocation: {
      method: 'pwerm',
      scenarios: [
        {
          name: 'IPO',
          type: 'ipo',
          probability: 0.3,
          exit_equity_value: 90_000_000,
          time_to_exit_years: 4,
          common_present_value: 25_000_000,
        },
        {
          name: 'Acquisition',
          type: 'merger_acquisition',
          probability: 0.5,
          exit_equity_value: 40_000_000,
          time_to_exit_years: 3,
          common_present_value: 9_000_000,
        },
        {
          name: 'Dissolution',
          type: 'dissolution',
          probability: 0.2,
          exit_equity_value: 2_000_000,
          time_to_exit_years: 1.5,
          common_present_value: 0,
        },
      ],
    },
  };

  it('tabulates every scenario with its probability and present value', () => {
    const seen = plain(pwermExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('IPO');
    expect(seen).toContain('merger acquisition');
    expect(seen).toContain('30.0%');
    expect(seen).toContain('$90,000,000');
    expect(seen).toContain('$25,000,000');
  });

  it('shows the probabilities summing to one, which the engine requires', () => {
    expect(plain(pwermExhibit(results, CONTEXT)!.html)).toContain('100%');
  });

  it('is absent on a run with no scenarios', () => {
    expect(pwermExhibit(RESULTS, CONTEXT)).toBeNull();
  });
});

// ── Exhibit H ────────────────────────────────────────────────────────────────

describe('discount exhibit', () => {
  it('closes exactly on the concluded fair market value', () => {
    const seen = plain(discountExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$1.8281'); // marketable, controlling
    expect(seen).toContain('10.0%'); // DLOC
    expect(seen).toContain('25.0%'); // DLOM
    expect(seen).toContain('$1.2345'); // concluded FMV
    expect(seen).toContain('Chaffee protective-put model');
    expect(seen).toContain('as of 2026-06-30');
  });

  it('shows the intermediate marketable-minority value between the two discounts', () => {
    // 1.828148 × 0.9 = 1.6453
    expect(plain(discountExhibit(RESULTS, CONTEXT)!.html)).toContain('$1.6453');
  });

  it('inverts the identity when the allocation reports no per-share value', () => {
    const results = { ...RESULTS, allocation: { method: 'as_converted' } };
    const seen = plain(discountExhibit(results, CONTEXT)!.html);
    // fmv / ((1 - 0.1) × (1 - 0.25)) = 1.2345 / 0.675 = 1.828889
    expect(seen).toContain('$1.8289');
    expect(seen).toContain('$1.2345');
  });

  it('is absent without a concluded value', () => {
    expect(discountExhibit({ discounts: { dloc: 0.1 } }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit D-1 ──────────────────────────────────────────────────────────────

describe('peer set exhibit', () => {
  const peers = [
    {
      ticker: 'AAA',
      name: 'Alpha Analytics',
      included: true,
      exclude_reason: null,
      source: 'market_feed',
      score: 0.82,
      multiples: { ev_revenue_ltm: 5.0, ev_ebitda_ltm: null },
    },
    {
      ticker: 'BBB',
      name: 'Beta & Sons <Holdings>',
      included: true,
      exclude_reason: null,
      source: 'analyst',
      score: null,
      multiples: { ev_revenue_ltm: 6.5, ev_ebitda_ltm: null },
    },
    {
      ticker: 'ZZZ',
      name: 'Zeta Mining',
      included: false,
      exclude_reason: 'different industry',
      source: 'market_feed',
      score: 0.05,
      multiples: { ev_revenue_ltm: 1.1, ev_ebitda_ltm: null },
    },
  ];

  it('names the retained companies and the ones set aside, with the basis', () => {
    const seen = plain(peerSetExhibit(peers, RESULTS)!.html);
    expect(seen).toContain('Alpha Analytics (AAA)');
    expect(seen).toContain('Zeta Mining (ZZZ)');
    expect(seen).toContain('different industry');
  });

  it('prints only the multiples the retained set actually has', () => {
    // Every retained comp is loss-making here, so an EV/EBITDA column would be
    // a column of dashes — which tells a reader nothing about the comps.
    const html = peerSetExhibit(peers, RESULTS)!.html;
    expect(html).toContain('EV/LTM Revenue');
    expect(html).not.toContain('EV/LTM EBITDA');
  });

  it('escapes company names, which come from the engagement', () => {
    expect(peerSetExhibit(peers, RESULTS)!.html).toContain('Beta &amp; Sons &lt;Holdings&gt;');
  });

  it('is absent without a peer set', () => {
    expect(peerSetExhibit(undefined, RESULTS)).toBeNull();
    expect(peerSetExhibit([], RESULTS)).toBeNull();
  });

  it('is absent when the run applied no market approach', () => {
    // A set an analyst screened but never weighted into the conclusion is
    // working material; printing it as a supporting schedule overstates it.
    const noMarket = { ...RESULTS, approaches: { income: { weight: 1 } } };
    expect(peerSetExhibit(peers, noMarket)).toBeNull();
  });

  it('follows Exhibit D and leaves the lettering alone', () => {
    const headings = buildExhibits(calculation(), { ...CONTEXT, peers }).map((s) => s.heading);
    expect(headings).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit B — Reconciliation of Valuation Approaches',
      'Exhibit C — Income Approach (Discounted Cash Flow)',
      'Exhibit D — Market Approach (Guideline Multiples)',
      'Exhibit D-1 — Guideline Company Set',
      'Exhibit F — Allocation of Equity Value',
      'Exhibit H — Discounts and Concluded Value',
    ]);
  });

  it('renders through the report sanitizer without losing its table', () => {
    const clean = sanitizeHtml(peerSetExhibit(peers, RESULTS)!.html, ALLOWED_TAGS);
    expect(clean).toContain('<table>');
    expect(clean).toContain('Alpha Analytics (AAA)');
  });
});

/**
 * The simulated allocation in the deliverable.
 *
 * A Monte Carlo run has to disclose two things a closed-form one does not, and
 * both are about whether a reader can trust the figure: the seed, because a
 * concluded value nobody can re-derive is not a conclusion, and the standard
 * error, because a simulated number without one is a number pretending to be
 * exact.
 */
describe('Exhibit F — a simulated allocation', () => {
  const MC_RESULTS = {
    equity_value: 72_000_000,
    allocation_method: 'monte_carlo',
    common_equity_value: 32_875_000,
    fmv_per_share: 2.4545,
    fully_diluted_common: 9_250_000,
    fully_diluted_basis: 'cap_table_common',
    assumptions: { volatility: 0.62, risk_free_rate: 0.0421, time_to_exit_years: 4 },
    discounts: { dloc: 0.08, dlom: 0.25 },
    allocation: {
      method: 'monte_carlo',
      paths: 20_000,
      antithetic: true,
      seed: 409,
      common_value: 32_875_000,
      common_shares: 9_250_000,
      common_per_share: 3.5537,
      standard_error_per_share: 0.0605,
      scenarios: [
        { name: 'IPO', probability: 0.3, years_to_exit: 5, volatility: 0.7, common_per_share: 3.66 },
        { name: 'Trade sale', probability: 0.7, years_to_exit: 2, volatility: 0.5, common_per_share: 3.48 },
      ],
      classes: {
        Common: { kind: 'common', shares: 9_250_000, value: 32_875_000, per_share: 3.5537 },
      },
    },
  };

  const html = () => allocationExhibit(MC_RESULTS, { currency: 'USD' })!.html;

  it('names the method rather than echoing the key', () => {
    expect(html()).toContain('Monte Carlo simulation');
    expect(html()).not.toContain('MONTE_CARLO');
  });

  it('states the seed, so the run can be reproduced', () => {
    expect(html()).toContain('Random seed');
    expect(html()).toContain('409');
  });

  it('states the path count and that pairs were antithetic', () => {
    expect(html()).toContain('20,000');
    expect(html()).toContain('antithetic');
  });

  it('states the standard error against the figure it qualifies', () => {
    // Reported to six decimals: the conclusion is stated to four, and an error
    // rounded to the same place would read as zero.
    expect(html()).toContain('Standard error');
    expect(html()).toContain('0.060500');
  });

  it('does not claim the mixture is a PWERM schedule', () => {
    // Monte Carlo scenarios carry a horizon and a volatility and no exit value,
    // because the exit is a distribution. Rendering them through Exhibit G's
    // columns would print $0 exit value and $0 present value for each, in an
    // exhibit headed "Probability-Weighted Expected Return".
    expect(pwermExhibit(MC_RESULTS, { currency: 'USD' })).toBeNull();
  });

  it('still renders Exhibit G for an actual PWERM run', () => {
    const pwerm = {
      ...MC_RESULTS,
      allocation_method: 'pwerm',
      assumptions: { expected_time_to_exit_years: 3.2 },
      allocation: {
        method: 'pwerm',
        scenarios: [
          {
            name: 'IPO',
            type: 'ipo',
            probability: 0.3,
            exit_equity_value: 120_000_000,
            time_to_exit_years: 4,
            common_present_value: 20_000_000,
          },
        ],
      },
    };
    expect(pwermExhibit(pwerm, { currency: 'USD' })).not.toBeNull();
  });
});

// ── Exhibit B — the market movement adjustment ───────────────────────────────

describe('market movement in Exhibit B', () => {
  const MOVED = {
    ...RESULTS,
    market_movement: {
      factor: 0.899,
      index_return: -0.0878,
      beta: 1.15,
      index_start: 4812.6,
      index_end: 4390.1,
      index_name: 'S&P North American Technology Software Index',
      period_start: '2025-10-15',
      period_end: '2026-06-30',
    },
    approaches: {
      ...RESULTS.approaches,
      opm_backsolve: {
        ...RESULTS.approaches.opm_backsolve,
        equity_value: 46_748_000,
        unadjusted_equity_value: 52_000_000,
        market_movement: { factor: 0.899 },
      },
    },
  };

  const html = () => plain(approachExhibit(MOVED, CONTEXT)!.html);

  it('shows the round indication before and after the adjustment', () => {
    // Printing only the adjusted figure would hide the most contestable step in
    // the reconciliation: the round transacted at a price, and this valuation
    // concluded the price means something different today.
    expect(html()).toContain('$52,000,000');
    expect(html()).toContain('$46,748,000');
  });

  it('names the benchmark, the period and the beta', () => {
    const text = html();
    expect(text).toContain('S&amp;P North American Technology Software Index');
    expect(text).toContain('2025-10-15 to 2026-06-30');
    expect(text).toContain('1.15');
    expect(text).toContain('-8.8%');
  });

  it('prints index levels as levels, not as multiples', () => {
    // `ratio()` would suffix them and print the S&P at "4812.60x".
    const text = html();
    expect(text).toContain('4,812.6');
    expect(text).not.toContain('4,812.6x');
  });

  it('states the factor and how it was derived', () => {
    expect(html()).toContain('0.8990x');
    expect(html()).toContain('1 + β × benchmark return');
  });

  it('says nothing at all when no adjustment was made', () => {
    // The common case. A row reading "1.0000x" would imply somebody measured a
    // movement, on a valuation dated days after its round where nobody did.
    const text = plain(approachExhibit(RESULTS, CONTEXT)!.html);
    expect(text).not.toContain('Market movement');
    expect(text).not.toContain('Benchmark');
  });
});

// ── Exhibit H-1 — the marketability discount, derived ────────────────────────

describe('dlomDerivationExhibit', () => {
  const MODEL = {
    ...RESULTS,
    discounts: {
      dloc: 0.1,
      dlom: 0.2448,
      dlom_method: 'finnerty',
      dlom_detail: {
        method: 'finnerty',
        volatility: 0.62,
        time_to_liquidity_years: 4,
        dlom: 0.244969,
        formula: 'Finnerty average-strike put — 2N(v/2) - 1 with effective variance',
      },
    },
    class_volatility: {
      enterprise_volatility: 0.62,
      time_to_exit_years: 4,
      risk_free_rate: 0.0421,
      equity_value: 42_000_000,
      delta_total: 1,
      classes: {
        Common: { kind: 'common', value: 19_900_045, delta: 0.555, elasticity: 1.1971, volatility: 0.7422 },
        'Series A': { kind: 'preferred', value: 6_215_857, delta: 0.1422, elasticity: 0.9762, volatility: 0.6052 },
      },
    },
  };

  it('states the inputs the model was struck on', () => {
    // A bare 24.5% is not reviewable: the model is arithmetic nobody disputes,
    // and the volatility and holding period *are* the argument.
    const text = plain(dlomDerivationExhibit(MODEL, CONTEXT)!.html);
    expect(text).toContain('Finnerty average-strike put model');
    expect(text).toContain('62.0%');
    expect(text).toContain('4.00 years');
    expect(text).toContain('24.5%');
  });

  it('shows each class carrying its own volatility, above the enterprise for common', () => {
    const text = plain(dlomDerivationExhibit(MODEL, CONTEXT)!.html);
    // Common ranks behind the whole preference stack, so it is a levered claim
    // and its return volatility exceeds the enterprise's — which is the whole
    // reason the schedule is worth printing.
    expect(text).toContain('74.2%');
    expect(text).toContain('60.5%');
    expect(text).toContain('1.20x');
  });

  it('discloses a Longstaff conclusion as an upper bound', () => {
    const longstaff = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.31,
        dlom_method: 'longstaff',
        dlom_detail: { method: 'longstaff', bound_multiple: 1.4498, is_upper_bound: true, dlom: 0.31 },
      },
    };
    const text = plain(dlomDerivationExhibit(longstaff, CONTEXT)!.html);
    expect(text).toContain('upper bound');
    expect(text).toContain('1.4498x');
  });

  it('names the restricted-stock studies a blended conclusion rests on', () => {
    const studies = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.221,
        dlom_method: 'restricted_stock',
        dlom_detail: {
          method: 'restricted_stock',
          statistic: 'median',
          dlom: 0.221,
          studies: [
            { study: 'silber', period_start: 1981, period_end: 1988, observations: 69, median: 0.339 },
            { study: 'stout_2018', period_start: 2008, period_end: 2018, observations: 143, median: 0.182 },
          ],
        },
      },
    };
    const text = plain(dlomDerivationExhibit(studies, CONTEXT)!.html);
    // Set selection is the whole objection to the method, so naming the studies
    // is not a courtesy.
    expect(text).toContain('silber');
    expect(text).toContain('stout_2018');
    expect(text).toContain('1981–1988');
    expect(text).toContain('Rule 144');
  });

  it('says a qualitative discount is a judgement', () => {
    const qualitative = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.2,
        dlom_method: 'qualitative',
        dlom_detail: { method: 'qualitative', dlom: 0.2, basis: 'analyst judgement — no model or study was applied' },
      },
    };
    expect(plain(dlomDerivationExhibit(qualitative, CONTEXT)!.html)).toContain('judgement');
  });

  it('renders on the class volatilities alone when no model detail exists', () => {
    const { discounts: _d, ...noDetail } = MODEL;
    expect(dlomDerivationExhibit(noDetail, CONTEXT)).not.toBeNull();
  });

  it('is absent when the run produced neither', () => {
    // A calculation predating the engine change, or an aggregate allocation
    // with no cap table to decompose. The report reads as it did before.
    expect(dlomDerivationExhibit(RESULTS, CONTEXT)).toBeNull();
  });

  it('follows Exhibit H in the assembled deliverable', () => {
    const headings = buildExhibits(
      calculation({ results: MODEL } as Partial<CalculationRow>),
      CONTEXT,
    ).map((s) => s.heading);
    expect(headings.at(-2)).toBe('Exhibit H — Discounts and Concluded Value');
    expect(headings.at(-1)).toBe('Exhibit H-1 — Marketability Discount: Derivation');
  });

  it('escapes a class name rather than emitting it as markup', () => {
    const hostile = {
      ...MODEL,
      class_volatility: {
        ...MODEL.class_volatility,
        classes: { '<img src=x>': { kind: 'common', value: 1, delta: 1, elasticity: 1, volatility: 0.5 } },
      },
    };
    const html = dlomDerivationExhibit(hostile, CONTEXT)!.html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

// ── Exhibit H-1 — several methods, weighted ───────────────────────────────────

/**
 * The DLOM method-weighting table.
 *
 * A marketability discount is the one figure in a 409A with no single defensible
 * derivation: the option models price the cost of being unable to sell from the
 * subject's own volatility and holding period, and the restricted-stock studies
 * report what the market actually paid for restricted shares. The standard
 * appraisal answer is to weight them, which the engine could not do — so an
 * appraiser wanting a 50/50 computed it by hand and entered the result as
 * `qualitative`, recording their arithmetic as judgement and leaving the report
 * unable to say where the number came from.
 */
describe('a DLOM concluded by weighting several methods', () => {
  const WEIGHTED = {
    ...RESULTS,
    discounts: {
      dloc: 0.1,
      dlom: 0.1874,
      dlom_method: 'weighted',
      dlom_detail: {
        method: 'weighted',
        dlom: 0.187402,
        weight_total: 1,
        components: [
          {
            method: 'finnerty',
            weight: 0.5,
            dlom: 0.244803,
            weighted: 0.122402,
            detail: {
              method: 'finnerty',
              volatility: 0.62,
              time_to_liquidity_years: 4,
              dlom: 0.244803,
              formula: 'Finnerty average-strike put — 2N(v/2) - 1',
            },
          },
          {
            method: 'restricted_stock',
            weight: 0.5,
            dlom: 0.13,
            weighted: 0.065,
            detail: {
              method: 'restricted_stock',
              dlom: 0.13,
              statistic: 'median',
              studies: [
                {
                  study: 'Columbia Financial Advisors (post-amendment)',
                  period_start: 1997,
                  period_end: 1998,
                  discount: 0.13,
                },
              ],
            },
          },
        ],
      },
    },
  };

  const text = (results = WEIGHTED) => plain(dlomDerivationExhibit(results, CONTEXT)!.html);

  it('tabulates every method with its weight and its indicated discount', () => {
    const out = text();
    expect(out).toContain('Finnerty average-strike put model');
    expect(out).toContain('Restricted-stock studies');
    expect(out).toContain('50.00%'); // both weights
    expect(out).toContain('24.5%'); // Finnerty indicated
    expect(out).toContain('13.0%'); // studies indicated
  });

  it('states the weighted contribution rather than leaving it to be multiplied out', () => {
    // The concluded figure has to be visibly the sum of the column above it;
    // otherwise the table shows the ingredients of an answer without showing
    // that it is the answer.
    const out = text();
    expect(out).toContain('12.2%'); // 24.48% × 50%
    expect(out).toContain('6.5%'); // 13.0% × 50%
    expect(out).toContain('18.7%'); // and the concluded total
  });

  it('carries each leg’s own derivation under it', () => {
    // A weighted average is checked by reading the legs, so four percentages
    // with nothing behind them would move the unreviewable bare figure from
    // Exhibit H to Exhibit H-1 rather than removing it.
    const out = text();
    expect(out).toContain('62.0%'); // the volatility the Finnerty leg used
    expect(out).toContain('4.00 years');
    expect(out).toContain('Columbia Financial Advisors (post-amendment)');
    expect(out).toContain('1997–1998');
  });

  it('keeps a nil-weighted method in the table', () => {
    /*
     * An appraiser who computed Longstaff to show it as an upper bound and
     * weighted it to nothing is documenting the bound. Dropping the row would
     * hide a method that was considered — which is the opposite of what the
     * table is for.
     */
    const withNil = {
      ...WEIGHTED,
      discounts: {
        ...WEIGHTED.discounts,
        dlom_detail: {
          ...WEIGHTED.discounts.dlom_detail,
          components: [
            ...WEIGHTED.discounts.dlom_detail.components,
            {
              method: 'longstaff',
              weight: 0,
              dlom: 0.42,
              weighted: 0,
              detail: { method: 'longstaff', bound_multiple: 1.4498, is_upper_bound: true },
            },
          ],
        },
      },
    };
    const out = text(withNil);
    expect(out).toContain('Longstaff upper bound');
    expect(out).toContain('42.0%');
    expect(out).toContain('0.00%');
    // And it is still disclosed as a bound rather than an estimate.
    expect(out).toContain('upper bound');
  });

  it('says why the methods are weighted rather than ranked', () => {
    const out = text();
    expect(out).toContain('evidence of different kinds');
  });

  it('falls back to nothing rather than an empty table with no components', () => {
    const empty = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.2,
        dlom_method: 'weighted',
        dlom_detail: { method: 'weighted', dlom: 0.2, components: [] },
      },
    };
    // The exhibit still renders (the class volatilities are in RESULTS), but it
    // does not claim a weighting it has no rows for.
    const out = plain(dlomDerivationExhibit(empty, CONTEXT)!.html);
    expect(out).not.toContain('DLOM method');
  });

  it('escapes a method name from the calculation record', () => {
    const hostile = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.2,
        dlom_method: 'weighted',
        dlom_detail: {
          method: 'weighted',
          dlom: 0.2,
          components: [
            { method: '<img src=x>', weight: 0.5, dlom: 0.2, weighted: 0.1 },
            { method: 'finnerty', weight: 0.5, dlom: 0.2, weighted: 0.1 },
          ],
        },
      },
    };
    const html = dlomDerivationExhibit(hostile, CONTEXT)!.html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

// ── Exhibit H — value per class, marketable and non-marketable ───────────────

describe('the per-class value table in Exhibit H', () => {
  const html = () => plain(discountExhibit(RESULTS, CONTEXT)!.html);

  it('states each class marketable and the common class discounted', () => {
    const text = html();
    expect(text).toContain('Series A');
    expect(text).toContain('$5.0000'); // Series A, marketable
    expect(text).toContain('$1.8281'); // Common, marketable
    // 1.828148 × (1 − 0.10) × (1 − 0.25)
    expect(text).toContain('$1.2340');
  });

  it('does not carry the common discounts across the preferred classes', () => {
    // DLOC and DLOM were reasoned about a minority holder of common with no
    // market. Applying them to a series holding governance and registration
    // rights would assert a conclusion nobody reached.
    const text = html();
    expect(text).not.toContain('$3.3750'); // 5.0000 discounted, were it applied
    expect(text).toContain('is not in that position');
  });

  it('is absent when the allocation reports no classes', () => {
    const aggregate = { ...RESULTS, allocation: { method: 'as_converted', common_fraction: 0.8 } };
    const text = plain(discountExhibit(aggregate, CONTEXT)!.html);
    expect(text).not.toContain('Value per share — marketable');
    // The common chain above it still renders — that is the exhibit's job.
    expect(text).toContain('Concluded fair market value');
  });
});

/**
 * Appendix I — where the discount rate came from.
 *
 * Exhibit C states the rate and discounts the flows with it. A reviewer asked
 * to accept 28% cannot check a bare percentage; the build-up is the argument.
 */
describe('Appendix I — the WACC build-up', () => {
  const AUTO_WACC = {
    wacc: 0.2812,
    cost_of_equity: 0.2954,
    cost_of_debt: 0.085,
    after_tax_cost_of_debt: 0.0672,
    tax_rate: 0.21,
    target_debt_to_equity: 0.15,
    weights: { equity: 0.87, debt: 0.13 },
    capm: {
      risk_free_rate: 0.0421,
      beta_unlevered: 1.24,
      beta_relevered: 1.38,
      equity_risk_premium: 0.055,
      size_premium: 0.0389,
      size_tier: 'Decile 10b',
      company_specific_premium: 0.06,
    },
    comparables: [
      { ticker: 'ABCD', levered_beta: 1.42, debt_to_equity: 0.21, unlevered_beta: 1.22 },
      { ticker: 'EFGH', levered_beta: 1.31, debt_to_equity: 0.08, unlevered_beta: 1.25 },
    ],
  };

  const withWacc = (over: Record<string, unknown> = {}) => ({
    equity_value: 42_000_000,
    fmv_per_share: 1.2345,
    auto: { wacc: { ...AUTO_WACC, ...over } },
  });

  const html = (over?: Record<string, unknown>) =>
    waccExhibit(withWacc(over), { currency: 'USD' })!.html;

  it('states every component of the cost of equity', () => {
    const out = html();
    expect(out).toContain('Risk-free rate');
    expect(out).toContain('4.21%');
    expect(out).toContain('Equity risk premium');
    expect(out).toContain('5.50%');
    expect(out).toContain('Size premium');
    expect(out).toContain('3.89%');
    expect(out).toContain('Company-specific risk premium');
  });

  it('names the size tier the premium was taken from', () => {
    // "3.89%" is a number; "Decile 10b" is what a reviewer checks it against.
    expect(html()).toContain('Decile 10b');
  });

  it('shows the relevering, both betas', () => {
    const out = html();
    expect(out).toContain('1.2400'); // unlevered
    expect(out).toContain('1.3800'); // relevered
  });

  it('lists the guideline set the beta was computed over', () => {
    // The one input that is neither published nor a judgement — it is a
    // calculation over a chosen set, and the set is what gets argued with.
    const out = html();
    expect(out).toContain('ABCD');
    expect(out).toContain('EFGH');
  });

  it('concludes on the rate Exhibit C actually applies', () => {
    expect(html()).toContain('28.12%');
    expect(html()).toContain('Exhibit C discounts the projected cash flows');
  });

  it('says so when the analyst overrode it', () => {
    // The build-up still belongs in the report — it is what the override was a
    // judgement against — but the appendix must not claim it drove the flows.
    expect(html({ used_manual_override: true })).toContain('superseded by the analyst');
  });

  it('renders nothing when the rate was typed rather than built', () => {
    // Inventing a decomposition that sums to the analyst's figure would be the
    // appendix asserting reasoning nobody did.
    expect(waccExhibit({ equity_value: 1, fmv_per_share: 1 }, { currency: 'USD' })).toBeNull();
  });

  it('survives a build-up missing a component', () => {
    const out = waccExhibit(
      { auto: { wacc: { wacc: 0.25, capm: {} } } },
      { currency: 'USD' },
    );
    expect(out).not.toBeNull();
    expect(out!.html).toContain('25.00%');
  });

  it('is included in the assembled exhibit list', () => {
    const calc = {
      status: 'succeeded',
      inputs: { params: {}, inputs: {} },
      results: withWacc(),
    } as unknown as CalculationRow;
    const headings = buildExhibits(calc, CONTEXT).map((s) => s.heading);
    expect(headings).toContain('Appendix I — Discount Rate Build-Up (WACC)');
  });
});
