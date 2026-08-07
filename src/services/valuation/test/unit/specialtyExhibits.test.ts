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

  it('routes specialty results through buildExhibits and drops unfamiliar shapes', () => {
    const viaMain = buildExhibits(calc('esop', { levels: { control: 1 } }), ctx);
    expect(viaMain).toHaveLength(1);
    expect(viaMain[0]!.heading).toContain('ESOP');

    expect(buildSpecialtyExhibits(calc('esop', {}), ctx)).toEqual([]);
    expect(buildSpecialtyExhibits(calc('unknown-kind', { anything: 1 }), ctx)).toEqual([]);
    expect(buildSpecialtyExhibits(null, ctx)).toEqual([]);
  });
});
