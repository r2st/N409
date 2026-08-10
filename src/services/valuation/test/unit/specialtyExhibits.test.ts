import { describe, expect, it } from 'vitest';
import { buildSpecialtyExhibits } from '../../src/domain/specialtyExhibits.js';
import { buildExhibits } from '../../src/domain/reportExhibits.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

const ctx = { currency: 'USD', companyName: 'Acme', valuationDate: '2026-08-07' };

function calc(kind: string, specialty: Record<string, unknown>): CalculationRow {
  return {
    id: '01J',
    valuation_id: '01K',
    engine_version: 'test',
    status: 'succeeded',
    inputs: {},
    results: { kind, specialty },
    equity_value: null,
    fmv_per_share: null,
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date(),
  };
}

describe('buildSpecialtyExhibits', () => {
  it('renders the §1202 test table with holding period and cap components', () => {
    const sections = buildSpecialtyExhibits(
      calc('qsbs', {
        eligible: true,
        exclusion_available_now: false,
        exclusion_percentage: 1,
        gain_exclusion_cap: 10_000_000,
        tests: {
          c_corporation: { passed: true, detail: 'entity_type=c_corp' },
          gross_asset_test: { passed: false, detail: 'over the limit' },
        },
        holding_period: { years_held: 3.2, required_years: 5, met: false, five_year_date: '2028-03-01' },
        cap_components: {
          lifetime_cap: 10_000_000,
          prior_exclusions: 0,
          lifetime_remaining: 10_000_000,
          ten_times_basis: 500_000,
        },
        failed_tests: ['gross_asset_test'],
      }),
      ctx,
    );
    expect(sections).toHaveLength(1);
    const html = sections[0]!.html;
    expect(sections[0]!.heading).toContain('Section 1202');
    expect(html).toContain('C corporation');
    expect(html).toContain('Fail');
    expect(html).toContain('2028-03-01');
    expect(html).toContain('$10,000,000');
  });

  it('renders the PPA allocation with goodwill as the residual, or a bargain purchase', () => {
    const base = {
      consideration_transferred: 10_000_000,
      tangible_net_assets: 2_000_000,
      intangibles: [{ name: 'Technology <core>', method: 'relief_from_royalty', fair_value: 3_000_000 }],
      total_intangible_value: 3_000_000,
      identifiable_net_assets: 5_000_000,
      goodwill: 5_000_000,
      bargain_purchase_gain: 0,
    };
    const [ppa] = buildSpecialtyExhibits(calc('ppa', base), ctx);
    expect(ppa!.html).toContain('Goodwill (residual)');
    expect(ppa!.html).toContain('Technology &lt;core&gt;');

    const [bargain] = buildSpecialtyExhibits(
      calc('ppa', { ...base, goodwill: 0, bargain_purchase_gain: 250_000 }),
      ctx,
    );
    expect(bargain!.html).toContain('Bargain purchase gain');
  });

  it('renders the impairment measures for each standard shape', () => {
    const [goodwill] = buildSpecialtyExhibits(
      calc('goodwill', {
        standard: 'ASC 350-20',
        reporting_unit: 'US segment',
        carrying_amount: 100,
        fair_value: 80,
        headroom: -20,
        impaired: true,
        impairment_loss: 20,
        goodwill_after: 10,
      }),
      ctx,
    );
    expect(goodwill!.heading).toContain('ASC 350-20');
    expect(goodwill!.html).toContain('US segment');
    expect(goodwill!.html).toContain('Impairment loss');

    const [longLived] = buildSpecialtyExhibits(
      calc('goodwill', {
        standard: 'ASC 360-10',
        asset_group: 'Plant A',
        carrying_amount: 100,
        undiscounted_cash_flows_total: 120,
        recoverable: true,
        fair_value: 60,
        impaired: false,
        impairment_loss: 0,
        carrying_after: 100,
      }),
      ctx,
    );
    expect(longLived!.html).toContain('Recoverable');
    expect(longLived!.html).toContain('none indicated');
  });

  it('renders the ESOP level-of-value chain and repurchase schedule', () => {
    const [esop] = buildSpecialtyExhibits(
      calc('esop', {
        value_basis: 'control',
        levels: { control: 10_000_000, marketable_minority: 9_000_000, nonmarketable_minority: 7_650_000 },
        dloc: 0.1,
        dlom: 0.15,
        shares_outstanding: 1_000_000,
        fmv_per_share: 7.65,
        esop_stake_value: 1_530_000,
        repurchase_obligation: {
          schedule: [
            {
              year: 1,
              share_price: 7.65,
              shares_redeemed: 16_000,
              repurchase_cost: 122_400,
              remaining_shares: 184_000,
              pv: 113_000,
            },
          ],
          total_obligation: 122_400,
          pv_of_obligation: 113_000,
          ending_share_balance: 184_000,
        },
      }),
      ctx,
    );
    const html = esop!.html;
    expect(html).toContain('Marketable minority (DLOC 10.0%)');
    expect(html).toContain('$7.6500');
    expect(html).toContain('Total obligation');
    expect(html).toContain('$1,530,000');
  });

  it('renders SMB methods with weights and EMI/CSOP scheme checks', () => {
    const [smb] = buildSpecialtyExhibits(
      calc('fmv', {
        sde_normalization: {
          pretax_income: 100_000,
          addbacks: { owner_compensation: 150_000, interest_expense: 0 },
          deductions: { one_time_income: 5_000 },
          sde: 245_000,
        },
        methods: {
          capitalization_of_earnings: { equity_value: 980_000 },
          sde_multiple: { equity_value: 612_500 },
        },
        weights: { capitalization_of_earnings: 0.5, sde_multiple: 0.5 },
        equity_value: 796_250,
      }),
      ctx,
    );
    const smbHtml = smb!.html;
    expect(smbHtml).toContain("Seller's discretionary earnings");
    expect(smbHtml).toContain('Add back: Owner compensation');
    expect(smbHtml).not.toContain('Interest expense');
    expect(smbHtml).toContain('Concluded equity value');

    const [emi] = buildSpecialtyExhibits(
      calc('emi', {
        pro_rata_per_share: 10,
        minority_discount: 0.1,
        restriction_discount: 0.2,
        umv_per_share: 9,
        amv_per_share: 7.2,
        qualification: {
          scheme: 'emi',
          qualifies: false,
          checks: { gross_asset_limit: { passed: false, detail: 'over £30m' } },
          failed_checks: ['gross_asset_limit'],
        },
      }),
      ctx,
    );
    expect(emi!.html).toContain('Schedule 5');
    expect(emi!.html).toContain('does not qualify');
  });

  it('renders the CSOP scheme against Schedule 4 rather than Schedule 5', () => {
    const [csop] = buildSpecialtyExhibits(
      calc('csop', {
        pro_rata_per_share: 4,
        umv_per_share: 3.6,
        amv_per_share: 3.6,
        qualification: {
          scheme: 'csop',
          qualifies: true,
          checks: { share_class: { passed: true, detail: 'ordinary, non-redeemable' } },
        },
      }),
      ctx,
    );
    expect(csop!.html).toContain('Schedule 4');
    expect(csop!.html).not.toContain('Schedule 5');
    expect(csop!.html).toContain('qualifies');
  });

  it('renders the single-intangible exhibit with only the measures that were supplied', () => {
    const [full] = buildSpecialtyExhibits(
      calc('ip', {
        fair_value: 4_200_000,
        pv_before_tab: 3_600_000,
        tab: 600_000,
        discount_rate: 0.18,
        royalty_rate: 0.05,
        tax_rate: 0.21,
      }),
      ctx,
    );
    expect(full!.heading).toContain('Intangible Asset');
    expect(full!.html).toContain('Tax amortization benefit');
    expect(full!.html).toContain('18.0%');
    expect(full!.html).toContain('$4,200,000');

    // `pv` is the fallback name for the same figure, and a run that supplied
    // neither a rate nor a TAB should print a shorter table, not empty rows.
    const [sparse] = buildSpecialtyExhibits(calc('ip', { fair_value: 1_000, pv: 900 }), ctx);
    expect(sparse!.html).toContain('Present value before TAB');
    expect(sparse!.html).not.toContain('Discount rate');
    expect(sparse!.html).not.toContain('Royalty rate');

    // Nothing but the conclusion: the measures table is dropped rather than
    // printed as a header with no rows under it.
    const [bare] = buildSpecialtyExhibits(calc('ip', { fair_value: 500 }), ctx);
    expect(bare!.html).not.toContain('<table');
    expect(bare!.html).toContain('Concluded fair value');
  });

  /**
   * The degradation half of this module's contract — "an absent, partial or
   * unfamiliar shape drops the exhibit rather than throwing inside a render".
   *
   * These are report exhibits: a run that returned half a result must produce
   * an em-dash, not a cell reading `undefined`, `NaN` or `[object Object]`.
   * That is the difference between a schedule that says a figure was not
   * computed and one that tells a client's board something untrue about its
   * own valuation.
   */
  describe('partial and hostile shapes', () => {
    /** Each kind, paired with the least it needs before it renders at all. */
    const GATES: Array<[string, Record<string, unknown>]> = [
      ['qsbs', { tests: {} }],
      ['ppa', { consideration_transferred: 1_000_000 }],
      ['goodwill', { standard: 'ASC 350-20', carrying_amount: 100 }],
      ['esop', { levels: {} }],
      ['fmv', { methods: {} }],
      ['emi', { umv_per_share: 1 }],
      ['csop', { umv_per_share: 1 }],
      ['ip', { fair_value: 1 }],
    ];

    /** Anything that would tell a reader a number exists when none does. */
    const leaks = (html: string): string[] =>
      ['undefined', 'NaN', '[object Object]', '>null<', '$null'].filter((bad) => html.includes(bad));

    it.each(GATES)('renders %s from its gate field alone without leaking placeholders', (kind, gate) => {
      const sections = buildSpecialtyExhibits(calc(kind, gate), ctx);
      expect(sections).toHaveLength(1);
      expect(leaks(sections[0]!.html)).toEqual([]);
    });

    it.each(GATES)('drops the %s exhibit when its gate field is the wrong type', (kind, gate) => {
      for (const key of Object.keys(gate)) {
        const broken = { ...gate, [key]: ['not', 'a', 'value'] };
        expect(buildSpecialtyExhibits(calc(kind, broken), ctx)).toEqual([]);
      }
    });

    /**
     * The shape an engine change or a hand-edited result actually produces:
     * the right keys carrying the wrong types. Every one of these reaches a
     * `num()`/`record()` guard, and none may throw or print through.
     */
    it.each(GATES)('survives %s with every optional field the wrong type', (kind, gate) => {
      const hostile = {
        ...gate,
        // Records where records are expected.
        holding_period: 'not a record',
        cap_components: [],
        qualification: 42,
        sde_normalization: 'nope',
        repurchase_obligation: [1, 2, 3],
        weights: 'weights',
        // Values where numbers are expected.
        gain_exclusion_cap: {},
        exclusion_percentage: 'lots',
        total_intangible_value: {},
        tangible_net_assets: 'some',
        identifiable_net_assets: null,
        goodwill: undefined,
        bargain_purchase_gain: 'positive',
        fair_value: kind === 'ip' ? 1 : {},
        headroom: [],
        impairment_loss: 'big',
        fmv_per_share: {},
        esop_stake_value: 'lots',
        dloc: [],
        dlom: {},
        equity_value: 'some',
        amv_per_share: {},
        pro_rata_per_share: [],
        minority_discount: 'ten percent',
        restriction_discount: {},
        discount_rate: [],
        royalty_rate: {},
        tax_rate: 'twenty one',
        tab: [],
        // Lists where lists are expected.
        intangibles: 'not a list',
      };
      const sections = buildSpecialtyExhibits(calc(kind, hostile), ctx);
      expect(sections).toHaveLength(1);
      expect(leaks(sections[0]!.html)).toEqual([]);
    });

    /**
     * A row inside a list can be as broken as the container. The engine emits
     * these as arrays, and one bad element must not take the schedule with it.
     */
    it('keeps a schedule whose rows are individually unusable', () => {
      const [ppa] = buildSpecialtyExhibits(
        calc('ppa', {
          consideration_transferred: 1_000_000,
          intangibles: ['a string', null, 7, { name: 'Trade name' }],
        }),
        ctx,
      );
      expect(ppa!.html).toContain('Trade name');
      expect(leaks(ppa!.html)).toEqual([]);

      const [esop] = buildSpecialtyExhibits(
        calc('esop', {
          levels: { control: 10 },
          repurchase_obligation: { schedule: ['x', null, { year: 2 }] },
        }),
        ctx,
      );
      expect(esop!.html).toContain('Total obligation');
      expect(leaks(esop!.html)).toEqual([]);
    });

    /** A cell's text comes from the engagement, so it has to survive markup. */
    it('escapes engine-supplied text in every cell it reaches', () => {
      const [ppa] = buildSpecialtyExhibits(
        calc('ppa', {
          consideration_transferred: 1,
          intangibles: [{ name: 'Series A & B <old>', method: '<em>rfr</em>', fair_value: 1 }],
        }),
        ctx,
      );
      expect(ppa!.html).toContain('Series A &amp; B &lt;old&gt;');
      expect(ppa!.html).toContain('&lt;em&gt;rfr&lt;/em&gt;');

      const [goodwill] = buildSpecialtyExhibits(
        calc('goodwill', {
          standard: 'ASC <350>',
          carrying_amount: 1,
          reporting_unit: 'Unit & Co <1>',
        }),
        ctx,
      );
      expect(goodwill!.heading).toContain('ASC &lt;350&gt;');
      expect(goodwill!.html).toContain('Unit &amp; Co &lt;1&gt;');
    });

    /** A calculation that did not succeed has no figures to schedule. */
    it('renders nothing for a failed or empty calculation', () => {
      const failed = { ...calc('qsbs', { tests: {} }), status: 'failed' as const };
      expect(buildSpecialtyExhibits(failed, ctx)).toEqual([]);

      const noResults = { ...calc('qsbs', { tests: {} }), results: null };
      expect(buildSpecialtyExhibits(noResults, ctx)).toEqual([]);

      const noKind = calc('qsbs', { tests: {} });
      noKind.results = { specialty: { tests: {} } };
      expect(buildSpecialtyExhibits(noKind, ctx)).toEqual([]);

      const listSpecialty = calc('qsbs', {});
      listSpecialty.results = { kind: 'qsbs', specialty: [] };
      expect(buildSpecialtyExhibits(listSpecialty, ctx)).toEqual([]);
    });
  });

  it('routes specialty results through buildExhibits and drops unfamiliar shapes', () => {
    const viaMain = buildExhibits(calc('esop', { levels: { control: 1 } }), ctx);
    expect(viaMain).toHaveLength(1);
    expect(viaMain[0]!.heading).toContain('ESOP');

    expect(buildSpecialtyExhibits(calc('esop', {}), ctx)).toEqual([]);
    expect(buildSpecialtyExhibits(calc('unknown-kind', { anything: 1 }), ctx)).toEqual([]);
    expect(buildSpecialtyExhibits(null, ctx)).toEqual([]);
  });
});
