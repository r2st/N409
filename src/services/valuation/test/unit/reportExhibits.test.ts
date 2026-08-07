import { describe, expect, it } from 'vitest';
import {
  allocationExhibit,
  approachExhibit,
  assetExhibit,
  buildExhibits,
  capitalizationExhibit,
  discountExhibit,
  incomeExhibit,
  marketExhibit,
  pwermExhibit,
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
