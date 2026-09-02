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

  describe('the date each mark speaks for', () => {
    /*
     * `latestMarks` takes the newest mark a holding has, whatever day it falls
     * on, and these exhibits sum them. So the schedule can be a NAV assembled
     * from marks of different ages and from marks dated after the report's own
     * valuation date, under prose that says "at the measurement date". The
     * dates were carried on every row and printed nowhere.
     */
    it('prints the mark date beside the fair value it dates', () => {
      const out = html(buildFundExhibits(fundData(), ctx));
      expect(out).toContain('Marked at');
      expect(out).toContain('2026-06-30');
      // The unmarked holding is carried at cost and has no date of its own.
      expect(out).toContain('<td>—</td>');
    });

    it('says so when the holdings are not all marked at one date', () => {
      const data = fundData();
      data.positions[0]!.mark = mark({ position_id: 'p1', measurement_date: '2025-03-31' });
      const out = html(buildFundExhibits(data, ctx));
      expect(out).toContain('dated 2025-03-31 through 2026-06-30');
      expect(out).toContain('not measured as of a single date');
    });

    it('names a mark dated after the valuation date as subsequent evidence', () => {
      const data = fundData();
      data.positions[0]!.mark = mark({ position_id: 'p1', measurement_date: '2026-09-30' });
      const out = html(buildFundExhibits(data, ctx));
      expect(out).toContain('1 of 3 holdings carry a mark dated after the valuation date');
      expect(out).toContain('subsequent evidence');
    });

    it('says the portfolio was not re-marked when every mark predates the report', () => {
      const data = fundData();
      for (const p of data.positions) if (p.mark) p.mark.measurement_date = '2026-03-31';
      const out = html(buildFundExhibits(data, ctx));
      expect(out).toContain('Every mark above is dated 2026-03-31');
      expect(out).toContain('rather than re-marked');
    });

    it('says nothing when every mark falls on the valuation date', () => {
      const out = html(buildFundExhibits(fundData(), ctx));
      expect(out).not.toContain('not measured as of a single date');
      expect(out).not.toContain('subsequent evidence');
      expect(out).not.toContain('rather than re-marked');
    });

    it('makes no claim about dates for a report with no valuation date', () => {
      const out = html(buildFundExhibits(fundData(), { ...ctx, valuationDate: null }));
      expect(out).toContain('2026-06-30');
      expect(out).not.toContain('rather than re-marked');
      expect(out).not.toContain('subsequent evidence');
    });

    it('still ranges the dates when the report has no valuation date to compare to', () => {
      const data = fundData();
      data.positions[0]!.mark = mark({ position_id: 'p1', measurement_date: '2025-03-31' });
      const out = html(buildFundExhibits(data, { ...ctx, valuationDate: null }));
      expect(out).toContain('dated 2025-03-31 through 2026-06-30');
    });

    it('says nothing about dates for a portfolio nobody has marked', () => {
      const data = fundData();
      for (const p of data.positions) p.mark = null;
      const out = html(buildFundExhibits(data, ctx));
      expect(out).not.toContain('not measured as of a single date');
      expect(out).not.toContain('rather than re-marked');
    });
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

  /*
   * Every numeric column arrives as a `numeric` string from pg, and a nullable
   * one arrives empty. Reading that as NaN puts "$NaN" in a signed opinion, so
   * each of these reads as zero (a quantity) or as "—" (an amount nobody
   * stated) — never as arithmetic on a non-number.
   */
  it('reads an unstated cost basis and quantity as zero', () => {
    const data: FundReportData = {
      fund,
      positions: [
        {
          position: position({ id: 'p1', company_name: 'Unpriced Co', cost_basis: '', quantity: '' }),
          mark: mark({ position_id: 'p1', fair_value: '250000', level: 2 }),
        },
      ],
      lpTerms: null,
    };
    const out = html(buildFundExhibits(data, ctx));
    expect(out).toContain('<td>$0</td>'); // cost basis
    expect(out).toContain('$250,000'); // fair value, and so the whole gain
    expect(out).toContain('Level 2');
  });

  it('carries a position whose mark states no fair value at its cost', () => {
    // A mark row exists — so the holding is "marked" and keeps the level the
    // engine assigned — but the amount is absent. Cost is the only defensible
    // carrying value; zero would understate the NAV.
    const data: FundReportData = {
      fund,
      positions: [
        {
          position: position({ id: 'p1', cost_basis: '500000' }),
          mark: mark({ position_id: 'p1', fair_value: '', level: 2 }),
        },
      ],
      lpTerms: null,
    };
    const out = html(buildFundExhibits(data, ctx));
    expect(out).toContain('$500,000');
    // Marked, so it must not be reported as an unmarked holding.
    expect(out).not.toContain('carry no mark');
  });

  it('humanizes a mark method the label table does not name', () => {
    // The DB column can hold a method added by a later migration; an exhibit
    // must print it rather than "undefined".
    const data: FundReportData = {
      fund,
      positions: [
        {
          position: position({ id: 'p1' }),
          mark: mark({ position_id: 'p1', method: 'secondary_transaction' as FundMarkRow['method'] }),
        },
      ],
      lpTerms: null,
    };
    expect(html(buildFundExhibits(data, ctx))).toContain('Secondary transaction');
  });

  it('humanizes a security type the same way', () => {
    const data: FundReportData = {
      fund,
      positions: [{ position: position({ id: 'p1', security_type: 'safe' }), mark: null }],
      lpTerms: null,
    };
    expect(html(buildFundExhibits(data, ctx))).toContain('<td>Safe</td>');
  });

  it('states an unfunded commitment of zero rather than a negative one', () => {
    // Contributed above committed is a recording error, not a negative
    // commitment the LP can be called on.
    const terms: LpTermsRow = { ...lpTerms, committed_capital: '', contributed_capital: '1000000' };
    const out = html(buildFundExhibits({ fund, positions: [], lpTerms: terms }, ctx));
    expect(out).toContain('<td>Unfunded commitment</td><td>$0</td>');
  });

  it('leaves an unrecorded LP term blank instead of printing a zero', () => {
    const terms: LpTermsRow = {
      ...lpTerms,
      contributed_capital: '',
      carry_pct: '',
      management_fee_pct: '',
      management_fees_paid: '',
      gp_catch_up: false,
    };
    const out = html(buildFundExhibits({ fund, positions: [], lpTerms: terms }, ctx));
    // Nothing drawn down yet — the whole commitment is unfunded.
    expect(out).toContain('<td>Contributed capital</td><td>$0</td>');
    expect(out).toContain('<td>Unfunded commitment</td><td>$50,000,000</td>');
    expect(out).toContain('<td>Carried interest</td><td>—</td>');
    expect(out).toContain('<td>Management fees paid to date</td><td>—</td>');
    expect(out).toContain('<td>GP catch-up</td><td>No</td>');
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

  describe('instrument terms', () => {
    it('prints a flag as Yes/No and a free-text param as itself', () => {
      const data = debtData({
        instrument: {
          ...instrument,
          params: { callable: true, amortizing: false, structure: 'bullet', face: 1_000_000 },
        },
        valuation: null,
        history: [],
      });
      const out = html(buildDebtExhibits(data, ctx));
      expect(out).toContain('<td>Callable</td><td>Yes</td>');
      expect(out).toContain('<td>Amortizing</td><td>No</td>');
      // Not money, not a rate — printing "$0.00" or "0.0%" here would be a lie.
      expect(out).toContain('<td>Structure</td><td>bullet</td>');
    });

    it('drops a param the record left unset rather than printing a blank row', () => {
      const data = debtData({
        instrument: { ...instrument, params: { face: 1_000_000, call_price: null, put_price: undefined } },
        valuation: null,
        history: [],
      });
      const out = html(buildDebtExhibits(data, ctx));
      expect(out).toContain('<td>Face</td>');
      expect(out).not.toContain('Call price');
      expect(out).not.toContain('Put price');
    });

    it('omits the terms exhibit entirely for an instrument with no params', () => {
      const empty = buildDebtExhibits(
        debtData({ instrument: { ...instrument, params: {} }, valuation: null, history: [] }),
        ctx,
      );
      expect(headings(empty)).toEqual(['Exhibit — Credit Terms & Discount Rate']);

      // The column is NOT NULL, but a row written before it was is still on
      // file — reading it must drop the exhibit, not throw inside a render.
      const nulled = buildDebtExhibits(
        debtData({
          instrument: { ...instrument, params: null as unknown as DebtInstrumentRow['params'] },
          valuation: null,
          history: [],
        }),
        ctx,
      );
      expect(headings(nulled)).toEqual(['Exhibit — Credit Terms & Discount Rate']);
    });

    it('names an instrument type the label table does not carry', () => {
      const data = debtData({
        instrument: {
          ...instrument,
          instrument_type: 'revolving_credit' as DebtInstrumentRow['instrument_type'],
        },
      });
      expect(html(buildDebtExhibits(data, ctx))).toContain('a revolving_credit');
    });

    it('ignores per-run inputs that are not a params object', () => {
      const data = debtData();
      data.valuation!.inputs = { instrument_type: 'bond', params: [1, 2, 3] };
      // Falls back to the stored record rather than mapping an array's indices.
      expect(html(buildDebtExhibits(data, ctx))).toContain('<td>Coupon rate</td><td>8.500%</td>');
    });
  });

  describe('credit terms', () => {
    it('omits the whole exhibit when nothing about the credit is recorded', () => {
      const out = buildDebtExhibits(debtData({ creditTerms: null, valuation: null, history: [] }), ctx);
      expect(headings(out)).toEqual(['Exhibit — Instrument Terms']);
    });

    it('skips an unrated instrument, humanizes an unknown seniority and states unsecured', () => {
      const data = debtData({
        creditTerms: {
          ...creditTerms,
          rating: null,
          seniority: 'second_lien' as CreditTermsRow['seniority'],
          secured: false,
        },
      });
      const out = html(buildDebtExhibits(data, ctx));
      expect(out).not.toContain('Credit rating');
      expect(out).toContain('<td>Seniority</td><td>Second lien</td>');
      expect(out).toContain('<td>Secured</td><td>No</td>');
    });

    it('prefers the yield the run actually discounted at over the stored terms', () => {
      const data = debtData();
      data.valuation!.result = { ...data.valuation!.result, benchmark_yield: 0.05, credit_spread: 0.07 };
      const out = html(buildDebtExhibits(data, ctx));
      expect(out).toContain('5.000%');
      expect(out).toContain('7.000%');
      expect(out).not.toContain('4.200%'); // the stored 0.042 is not what priced it
    });

    it('states the market yield as the all-in yield when the run reported no build-up', () => {
      // The bond path returns market_yield and nothing else; that IS the rate
      // the cash flows were discounted at.
      expect(html(buildDebtExhibits(debtData(), ctx))).toContain(
        '<td>All-in discount yield</td><td>9.500%</td>',
      );
    });
  });

  describe('valuation result', () => {
    it('skips a measure the engine reported as unusable', () => {
      const data = debtData({
        valuation: debtValuation({ result: { fair_value: 'n/a', clean_price: 946_182.11 } }),
        history: [],
      });
      const out = html(buildDebtExhibits(data, ctx));
      expect(out).toContain('<td>Clean price</td>');
      expect(out).not.toContain('<td>Fair value</td>');
    });

    it('omits the exhibit when the result carries no recognised measure', () => {
      const out = buildDebtExhibits(
        debtData({
          valuation: debtValuation({ result: { engine_version: '2.1', schedule: [] } }),
          history: [],
        }),
        ctx,
      );
      expect(headings(out)).not.toContain('Exhibit — Valuation Result');
      expect(headings(out)).not.toContain('Exhibit — Contractual Cash Flows');
    });

    it('humanizes an amortization structure', () => {
      const data = debtData({
        valuation: debtValuation({ result: { fair_value: 1000, structure: 'straight_line' } }),
        history: [],
      });
      expect(html(buildDebtExhibits(data, ctx))).toContain(
        '<td>Amortization structure</td><td>Straight line</td>',
      );
    });
  });

  describe('contractual cash flows', () => {
    it('leaves a period and term blank when the row does not state them', () => {
      const data = debtData({
        valuation: debtValuation({
          result: { fair_value: 1000, schedule: [{ interest: 500, principal: 0, amount: 500 }] },
        }),
        history: [],
      });
      const out = html(buildDebtExhibits(data, ctx));
      expect(out).toContain('<td></td><td>—</td>'); // period, then years
      expect(out).toContain('$500.00');
    });

    it('totals only the payments that stated an amount', () => {
      const data = debtData({
        valuation: debtValuation({
          result: {
            fair_value: 1000,
            schedule: [
              { period: 1, t_years: 0.5, amount: 42_500 },
              { period: 2, t_years: 1 }, // no amount recorded
            ],
          },
        }),
        history: [],
      });
      // The second row contributes nothing rather than NaN-ing the total.
      expect(html(buildDebtExhibits(data, ctx))).toContain('<td><strong>$42,500.00</strong></td>');
    });

    it('drops a schedule whose every row is unusable', () => {
      const data = debtData({
        valuation: debtValuation({
          result: { fair_value: 1000, schedule: [null, [1, 2], 'row'] },
        }),
        history: [],
      });
      expect(headings(buildDebtExhibits(data, ctx))).not.toContain('Exhibit — Contractual Cash Flows');
    });
  });

  it('leaves an unpriced prior measurement blank in the history', () => {
    const out = html(
      buildDebtExhibits(
        debtData({
          history: [
            debtValuation(),
            debtValuation({ id: 'v0', valuation_date: '2026-03-31', fair_value: null }),
          ],
        }),
        ctx,
      ),
    );
    expect(out).toContain('<td>2026-03-31</td><td>—</td>');
  });
});
