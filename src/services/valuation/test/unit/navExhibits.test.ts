import { describe, expect, it } from 'vitest';
import {
  buildDebtExhibits,
  buildFundExhibits,
  type DebtReportData,
  type FundReportData,
} from '../../src/domain/navExhibits.js';
import type { ExhibitContext } from '../../src/domain/reportExhibits.js';
import type { FundMarkRow, FundPositionRow, FundRow, LpTermsRow } from '../../src/repos/funds.js';
import type { CreditTermsRow, DebtInstrumentRow, DebtValuationRow } from '../../src/repos/debtInstruments.js';

/**
 * The render-time schedules for the two measurement kinds. What matters here
 * is the arithmetic (the rollups are done in TS, not by the engine), the ASC
 * 820 level treatment of an unmarked position, and the degradation rule —
 * a partial shape drops its exhibit rather than throwing inside a render.
 */

const ctx: ExhibitContext = {
  currency: 'USD',
  companyName: 'Meridian Ventures II',
  valuationDate: '2026-06-30',
};

const html = (sections: Array<{ heading: string; html: string }>): string =>
  sections.map((s) => `${s.heading}\n${s.html}`).join('\n');

const headings = (sections: Array<{ heading: string }>): string[] => sections.map((s) => s.heading);

// ── Fund fixtures ────────────────────────────────────────────────────────────

const fund: FundRow = {
  id: '01J000000000000000000FUND',
  name: 'Meridian Ventures II',
  fund_type: 'vc',
  currency: 'USD',
  vintage_year: 2021,
  valuation_id: '01J0000000000000000000VAL',
  created_by: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
};

function position(over: Partial<FundPositionRow> & { id: string }): FundPositionRow {
  return {
    fund_id: fund.id,
    company_name: 'Northwind Robotics',
    security_type: 'preferred',
    quantity: '1000000',
    cost_basis: '500000',
    mark_method: 'last_round',
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function mark(over: Partial<FundMarkRow> & { position_id: string }): FundMarkRow {
  return {
    id: `mark-${over.position_id}`,
    measurement_date: '2026-06-30',
    method: 'last_round',
    fair_value: '900000',
    level: 3,
    inputs: {},
    created_by: null,
    created_at: new Date('2026-06-30T00:00:00Z'),
    ...over,
  };
}

const lpTerms: LpTermsRow = {
  fund_id: fund.id,
  committed_capital: '50000000',
  contributed_capital: '32000000',
  preferred_return_rate: '0.08',
  carry_pct: '0.2',
  gp_catch_up: true,
  management_fee_pct: '0.02',
  management_fees_paid: '4000000',
  gp_distributions_to_date: '0',
  updated_at: new Date('2026-06-30T00:00:00Z'),
};

/** Two marked holdings (Level 1 and Level 3) plus one that was never marked. */
function fundData(): FundReportData {
  return {
    fund,
    positions: [
      {
        position: position({ id: 'p1', company_name: 'Northwind Robotics', cost_basis: '500000' }),
        mark: mark({ position_id: 'p1', fair_value: '900000', level: 3 }),
      },
      {
        position: position({
          id: 'p2',
          company_name: 'Helios Public Co',
          cost_basis: '250000',
          mark_method: 'market',
        }),
        mark: mark({ position_id: 'p2', method: 'market', fair_value: '400000', level: 1 }),
      },
      // Never marked → carried at cost.
      { position: position({ id: 'p3', company_name: 'Quiet Holdings', cost_basis: '100000' }), mark: null },
    ],
    lpTerms,
  };
}

describe('fund NAV exhibits', () => {
  it('builds the four schedules for a marked portfolio', () => {
    expect(headings(buildFundExhibits(fundData(), ctx))).toEqual([
      'Exhibit — Portfolio Schedule',
      'Exhibit — Fair Value Hierarchy (ASC 820)',
      'Exhibit — Net Asset Value',
      'Exhibit — Limited Partnership Economics',
    ]);
  });

  it('totals cost, fair value and unrealized gain across the portfolio', () => {
    const out = html(buildFundExhibits(fundData(), ctx));
    // Cost 500,000 + 250,000 + 100,000; fair value 900,000 + 400,000 + 100,000
    // (the unmarked holding at cost); gain 400,000 + 150,000 + 0.
    expect(out).toContain('$850,000');
    expect(out).toContain('$1,400,000');
    expect(out).toContain('$550,000');
  });

  it('carries an unmarked position at cost and measures it as Level 3', () => {
    const out = html(buildFundExhibits(fundData(), ctx));
    expect(out).toContain('1 of 3 holdings carry no mark');
    // Level 3 = Northwind (900,000) + the unmarked Quiet Holdings (100,000).
    expect(out).toContain('$1,000,000');
    // Level 1 is the one quoted holding, 400,000 / 1,400,000 = 28.6%.
    expect(out).toContain('28.6%');
  });

  it('says nothing about unmarked holdings when every position is marked', () => {
    const data = fundData();
    data.positions = data.positions.slice(0, 2);
    expect(html(buildFundExhibits(data, ctx))).not.toContain('carry no mark');
  });

  it('states the unfunded commitment rather than making a reader subtract', () => {
    const out = html(buildFundExhibits(fundData(), ctx));
    // 50,000,000 committed less 32,000,000 contributed.
    expect(out).toContain('$18,000,000');
    expect(out).toContain('8.0%'); // preferred return
    expect(out).toContain('20.0%'); // carry
  });

  it('does not print a percentage column for a portfolio with no value', () => {
    const data = fundData();
    data.positions = [
      {
        position: position({ id: 'p1', cost_basis: '0' }),
        mark: mark({ position_id: 'p1', fair_value: '0' }),
      },
    ];
    const out = html(buildFundExhibits(data, ctx));
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
  });

  it('drops the LP exhibit when no terms are recorded, keeping the rest', () => {
    const data = fundData();
    data.lpTerms = null;
    expect(headings(buildFundExhibits(data, ctx))).not.toContain('Exhibit — Limited Partnership Economics');
    expect(headings(buildFundExhibits(data, ctx))).toContain('Exhibit — Net Asset Value');
  });

  it('builds nothing for an engagement with no linked portfolio', () => {
    expect(buildFundExhibits(null, ctx)).toEqual([]);
  });

  it('accepts a measurement_date that arrives from pg as a Date', () => {
    // node-postgres parses a `date` column into a JS Date, so this is the
    // shape the renderer actually sees. The row type used to claim `string`
    // and the exhibit called .slice() on it, which threw inside the render and
    // 500ed every fund PDF.
    const data = fundData();
    data.positions[0]!.mark!.measurement_date = new Date(2026, 5, 30);
    expect(() => buildFundExhibits(data, ctx)).not.toThrow();
    expect(headings(buildFundExhibits(data, ctx))).toContain('Exhibit — Portfolio Schedule');
  });

  it('builds nothing for a linked portfolio holding no positions', () => {
    expect(buildFundExhibits({ fund, positions: [], lpTerms: null }, ctx)).toEqual([]);
  });

  it('escapes a portfolio company name so it cannot close a cell', () => {
    const data = fundData();
    data.positions[0]!.position.company_name = 'Series A & B <old>';
    const out = html(buildFundExhibits(data, ctx));
    expect(out).toContain('Series A &amp; B &lt;old&gt;');
    expect(out).not.toContain('<old>');
  });
});

// ── Debt fixtures ────────────────────────────────────────────────────────────

const instrument: DebtInstrumentRow = {
  id: '01J000000000000000000DEBT',
  name: 'Northwind 8.5% Senior Note 2030',
  instrument_type: 'bond',
  currency: 'USD',
  params: { face: 1_000_000, coupon_rate: 0.085, frequency: 2, maturity_years: 4, market_yield: 0.095 },
  valuation_id: '01J0000000000000000000VAL',
  created_by: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const creditTerms: CreditTermsRow = {
  instrument_id: instrument.id,
  rating: 'BB',
  benchmark_yield: '0.042',
  spread: '0.053',
  seniority: 'senior_secured',
  secured: true,
  updated_at: new Date('2026-06-30T00:00:00Z'),
};

function debtValuation(over: Partial<DebtValuationRow> = {}): DebtValuationRow {
  return {
    id: 'v1',
    instrument_id: instrument.id,
    valuation_date: '2026-06-30',
    inputs: { instrument_type: 'bond', params: instrument.params },
    result: {
      fair_value: 967_432.11,
      clean_price: 946_182.11,
      accrued_interest: 21_250,
      dirty_price: 967_432.11,
      market_yield: 0.095,
      macaulay_duration: 3.4121,
      modified_duration: 3.2573,
      convexity: 13.8842,
      schedule: [
        { period: 1, t_years: 0.5, interest: 42_500, principal: 0, amount: 42_500, balance: 1_000_000 },
        { period: 2, t_years: 1.0, interest: 42_500, principal: 0, amount: 42_500, balance: 1_000_000 },
      ],
    },
    fair_value: '967432.11',
    created_by: null,
    created_at: new Date('2026-06-30T00:00:00Z'),
    ...over,
  };
}

function debtData(over: Partial<DebtReportData> = {}): DebtReportData {
  const valuation = debtValuation();
  return { instrument, creditTerms, valuation, history: [valuation], ...over };
}

describe('debt instrument exhibits', () => {
  it('builds terms, credit, result and cash flows for a priced bond', () => {
    expect(headings(buildDebtExhibits(debtData(), ctx))).toEqual([
      'Exhibit — Instrument Terms',
      'Exhibit — Credit Terms & Discount Rate',
      'Exhibit — Valuation Result',
      'Exhibit — Contractual Cash Flows',
    ]);
  });

  it('prints rate params as percentages and money params as money', () => {
    const out = html(buildDebtExhibits(debtData(), ctx));
    expect(out).toContain('<td>Coupon rate</td><td>8.500%</td>'); // not "0.085"
    expect(out).toContain('<td>Face</td><td>$1,000,000.00</td>');
    // A count, not money and not a percentage — "$4.00 maturity years" and
    // "400.0%" are both readings a term sheet has to rule out.
    expect(out).toContain('<td>Maturity years</td><td>4</td>');
    expect(out).toContain('<td>Frequency</td><td>2</td>');
  });

  it('states the yield build-up from the engine result', () => {
    const data = debtData();
    data.valuation!.result = {
      ...data.valuation!.result,
      benchmark_yield: 0.042,
      credit_spread: 0.053,
      all_in_yield: 0.095,
    };
    const out = html(buildDebtExhibits(data, ctx));
    expect(out).toContain('4.200%');
    expect(out).toContain('5.300%');
    expect(out).toContain('9.500%');
    expect(out).toContain('Senior secured');
    expect(out).toContain('BB');
  });

  it('falls back to the stored credit terms when the run reported no build-up', () => {
    // The bond path returns market_yield but neither benchmark nor spread.
    const out = html(buildDebtExhibits(debtData(), ctx));
    expect(out).toContain('4.200%'); // from creditTerms.benchmark_yield
    expect(out).toContain('5.300%'); // from creditTerms.spread
  });

  it('totals the contractual payments', () => {
    expect(html(buildDebtExhibits(debtData(), ctx))).toContain('$85,000.00');
  });

  it('reports duration and convexity as plain numbers, not money', () => {
    const out = html(buildDebtExhibits(debtData(), ctx));
    expect(out).toContain('3.4121');
    expect(out).toContain('13.8842');
    expect(out).not.toContain('$3.41');
  });

  it('prices the instrument on the run inputs rather than the stored params', () => {
    const data = debtData();
    // An override priced this run at a different yield; the terms exhibit must
    // show what was actually used, not what is sitting on the instrument.
    data.valuation!.inputs = {
      instrument_type: 'bond',
      params: { ...instrument.params, market_yield: 0.115 },
    };
    expect(html(buildDebtExhibits(data, ctx))).toContain('11.500%');
  });

  it('omits the result and cash-flow exhibits for an instrument never priced', () => {
    const out = buildDebtExhibits(debtData({ valuation: null, history: [] }), ctx);
    // The terms are still worth printing — they came from the instrument record.
    expect(headings(out)).toEqual(['Exhibit — Instrument Terms', 'Exhibit — Credit Terms & Discount Rate']);
  });

  it('omits the history exhibit until there is more than one measurement', () => {
    expect(headings(buildDebtExhibits(debtData(), ctx))).not.toContain('Exhibit — Valuation History');
    const two = debtData({
      history: [
        debtValuation(),
        debtValuation({ id: 'v0', valuation_date: '2026-03-31', fair_value: '950000' }),
      ],
    });
    const out = buildDebtExhibits(two, ctx);
    expect(headings(out)).toContain('Exhibit — Valuation History');
    expect(html(out)).toContain('2026-03-31');
  });

  it('renders a SAFE result without the bond-only measures', () => {
    const safe = debtData({
      instrument: { ...instrument, instrument_type: 'safe', params: { investment: 500_000 } },
      valuation: debtValuation({
        result: {
          fair_value: 812_500,
          shares_received: 65_000,
          ownership_pct: 0.0325,
          conversion_price: 12.5,
          converted_via: 'cap',
          moic: 1.625,
        },
      }),
    });
    const out = html(buildDebtExhibits(safe, ctx));
    expect(out).toContain('$812,500.00');
    expect(out).toContain('3.250%');
    expect(out).toContain('Cap'); // converted_via humanized
    expect(out).not.toContain('Macaulay');
  });

  it('builds nothing for an engagement with no linked instrument', () => {
    expect(buildDebtExhibits(null, ctx)).toEqual([]);
  });

  it('dates the measurement from a pg Date without shifting it a day', () => {
    // Midnight local on 30 June. toISOString() would render this as 29 June
    // anywhere west of UTC, dating the measurement to the day before it was
    // made — so the exhibit formats from the local parts instead.
    const data = debtData();
    data.valuation!.valuation_date = new Date(2026, 5, 30);
    expect(html(buildDebtExhibits(data, ctx))).toContain('2026-06-30');
  });

  it('escapes an instrument name so it cannot close a cell', () => {
    const data = debtData({ instrument: { ...instrument, name: 'Note <A> & <B>' } });
    const out = html(buildDebtExhibits(data, ctx));
    expect(out).toContain('Note &lt;A&gt; &amp; &lt;B&gt;');
    expect(out).not.toContain('<A>');
  });
});
