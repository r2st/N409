import { describe, expect, it } from 'vitest';
import {
  isSpecialtyKind,
  SPECIALTY_KINDS,
  SpecialtyInputError,
  specialtyEngineRequest,
  specialtyHeadline,
} from '../../src/domain/specialty.js';

describe('specialtyEngineRequest', () => {
  it('assembles a QSBS request from intake answers with today as the assessment date', () => {
    const req = specialtyEngineRequest(
      'qsbs',
      {
        entity_type: 'c_corp',
        is_domestic: true,
        industry: 'software',
        acquisition_date: '2020-03-01',
        acquired_at_original_issue: true,
        gross_assets_before_issuance: 4_000_000,
        gross_assets_after_issuance: 9_000_000,
        active_business_asset_pct: 0.95,
      },
      {},
      '2026-08-07',
    );
    expect(req.path).toBe('/engine/v1/qsbs');
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.assessment_date).toBe('2026-08-07');
    expect(inputs.entity_type).toBe('c_corp');
    expect(inputs.gross_assets_after_issuance).toBe(9_000_000);
    // Unanswered optionals stay absent so the engine defaults decide.
    expect('aggregate_basis' in inputs).toBe(false);
  });

  it('coerces numeric strings and leaves unanswerable values out', () => {
    const req = specialtyEngineRequest('csop', {
      equity_value: '5000000',
      total_shares: 1_000_000,
      options_granted: 10_000,
      exercise_price: 5,
      minority_discount: 'not-a-number',
    });
    const params = req.body.params as Record<string, unknown>;
    expect(params.equity_value).toBe(5_000_000);
    expect('minority_discount' in params).toBe(false);
    expect(req.body.scheme).toBe('csop');
  });

  it('maps the EMI FTE headcount onto the engine employee_count kwarg', () => {
    const req = specialtyEngineRequest('emi', {
      equity_value: 1_000_000,
      total_shares: 100_000,
      options_granted: 1_000,
      gross_assets: 2_000_000,
      fte_employee_count: 40,
      is_independent: true,
      has_qualifying_trade: true,
      works_25_hours_or_75_pct: true,
    });
    const params = req.body.params as Record<string, unknown>;
    expect(params.employee_count).toBe(40);
    expect('fte_employee_count' in params).toBe(false);
  });

  it('refuses a PPA without an intangible schedule, and merges one from run inputs', () => {
    const answers = { consideration_transferred: 10_000_000, fixed_assets: 500_000 };
    expect(() => specialtyEngineRequest('ppa', answers)).toThrow(SpecialtyInputError);

    const intangibles = [{ name: 'Tech', method: 'relief_from_royalty', params: {} }];
    const req = specialtyEngineRequest('ppa', answers, { intangibles });
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.intangibles).toEqual(intangibles);
    expect(inputs.consideration_transferred).toBe(10_000_000);
    expect(inputs.net_working_capital).toBe(0);
  });

  it('builds the impairment request for each test shape', () => {
    const goodwill = specialtyEngineRequest('goodwill', {
      impairment_test: 'goodwill',
      reporting_unit: 'US segment',
      carrying_amount: 100,
      fair_value: 80,
      goodwill_carrying_amount: 30,
    });
    expect(goodwill.body.test).toBe('goodwill');
    expect((goodwill.body.params as Record<string, unknown>).goodwill_carrying_amount).toBe(30);

    expect(() =>
      specialtyEngineRequest('goodwill', {
        impairment_test: 'goodwill',
        carrying_amount: 100,
        fair_value: 80,
      }),
    ).toThrow(/goodwill carrying amount/);

    const longLived = specialtyEngineRequest('goodwill', {
      impairment_test: 'long_lived',
      reporting_unit: 'Plant A',
      carrying_amount: 100,
      fair_value: 60,
      undiscounted_cash_flows: '40, 35, 20',
    });
    expect((longLived.body.params as Record<string, unknown>).undiscounted_cash_flows).toEqual([40, 35, 20]);
    expect((longLived.body.params as Record<string, unknown>).asset_group).toBe('Plant A');

    expect(() =>
      specialtyEngineRequest('goodwill', {
        impairment_test: 'long_lived',
        carrying_amount: 100,
        fair_value: 60,
        undiscounted_cash_flows: '40, thirty-five',
      }),
    ).toThrow(/comma-separated/);
  });

  it('attaches the ESOP repurchase projection only when the plan facts exist', () => {
    const base = {
      equity_value: 10_000_000,
      shares_outstanding: 1_000_000,
      value_basis: 'control',
      dloc: 0.1,
      dlom: 0.15,
    };
    expect('repurchase' in specialtyEngineRequest('esop', base).body).toBe(false);

    const withPlan = specialtyEngineRequest('esop', {
      ...base,
      esop_share_balance: 200_000,
      annual_redemption_rate: 0.08,
      projection_years: 12,
    });
    expect(withPlan.body.repurchase).toMatchObject({
      esop_share_balance: 200_000,
      annual_redemption_rate: 0.08,
      years: 12,
    });
    // Overrides address inputs and repurchase separately.
    const overridden = specialtyEngineRequest(
      'esop',
      { ...base, esop_share_balance: 200_000, annual_redemption_rate: 0.08 },
      { dlom: 0.2, repurchase: { years: 5 } },
    );
    expect((overridden.body.inputs as Record<string, unknown>).dlom).toBe(0.2);
    expect((overridden.body.repurchase as Record<string, unknown>).years).toBe(5);
  });

  it('builds SMB SDE + cap-rate inputs and defaults a flat IP revenue forecast', () => {
    const smb = specialtyEngineRequest('fmv', {
      pretax_income: 200_000,
      owner_compensation: 150_000,
      sde_multiple: 2.5,
      risk_free_rate: 0.04,
      equity_risk_premium: 0.05,
      size_premium: 0.03,
    });
    const inputs = smb.body.inputs as Record<string, unknown>;
    expect((inputs.sde_inputs as Record<string, unknown>).owner_compensation).toBe(150_000);
    expect((inputs.cap_rate_inputs as Record<string, unknown>).size_premium).toBe(0.03);
    expect(inputs.sde_multiple).toBe(2.5);

    const ip = specialtyEngineRequest('ip', {
      valuation_method: 'relief_from_royalty',
      annual_revenue: 1_000_000,
      remaining_life_years: 5,
      royalty_rate: 0.06,
      discount_rate: 0.2,
      tax_rate: 0.25,
    });
    expect(ip.body.method).toBe('relief_from_royalty');
    const params = ip.body.params as Record<string, unknown>;
    expect(params.revenues).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]);
    // A real forecast in the run inputs replaces the flat default.
    const withForecast = specialtyEngineRequest(
      'ip',
      { valuation_method: 'relief_from_royalty', annual_revenue: 1_000_000, remaining_life_years: 5 },
      { revenues: [900_000, 800_000] },
    );
    expect((withForecast.body.params as Record<string, unknown>).revenues).toEqual([900_000, 800_000]);
  });
});

/**
 * ASC 820, gift & estate and IFRS 2 had questionnaires but no dispatch, so
 * each ran the 409A allocation and produced a per-share FMV nobody asked for.
 * These pin what each now sends instead.
 */
describe('specialtyEngineRequest — ASC 820', () => {
  const answers = { measurement_date: '2026-06-30', fair_value_level: 'level_3' };
  const positions = [{ name: 'Listed', fair_value: 1_000_000, level: 'level_1' }];

  it('sends the analyst position schedule with the measurement date', () => {
    const req = specialtyEngineRequest('820', answers, { positions });
    expect(req.path).toBe('/engine/v1/fair-value-820');
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.positions).toEqual(positions);
    expect(inputs.measurement_date).toBe('2026-06-30');
  });

  it('refuses a run with no position schedule rather than inventing a table', () => {
    // "Predominant level" is an answer about the portfolio, not a measurement.
    for (const overrides of [{}, { positions: [] }, { positions: 'level_3' }]) {
      expect(() => specialtyEngineRequest('820', answers, overrides)).toThrow(SpecialtyInputError);
    }
  });

  it('does not send positions twice when merging the overrides', () => {
    const req = specialtyEngineRequest('820', answers, {
      positions,
      level_3_rollforward: { beginning_balance: 1 },
    });
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.positions).toEqual(positions);
    expect(inputs.level_3_rollforward).toEqual({ beginning_balance: 1 });
  });
});

describe('specialtyEngineRequest — gift & estate', () => {
  const answers = {
    transfer_date: '2026-04-15',
    transfer_type: 'gift',
    percent_interest: 25,
    dloc: 0.2,
    dlom: 0.3,
    prior_gifts_value: 500_000,
  };

  it('assembles the transfer and both discounts', () => {
    const req = specialtyEngineRequest('gifts', { ...answers, entity_value: 10_000_000 });
    expect(req.path).toBe('/engine/v1/gift-estate');
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.entity_value).toBe(10_000_000);
    expect(inputs.percent_interest).toBe(25);
    expect(inputs.dloc).toBe(0.2);
    expect(inputs.dlom).toBe(0.3);
    expect(inputs.transfer_type).toBe('gift');
  });

  it('passes the percentage through as a percentage', () => {
    // The questionnaire says "25 for a quarter interest"; converting to a
    // fraction here would value the interest at a quarter of a percent.
    const req = specialtyEngineRequest('gifts', { ...answers, entity_value: 1_000_000 });
    expect((req.body.inputs as Record<string, unknown>).percent_interest).toBe(25);
  });

  it('maps the questionnaire prior-gifts field onto the engine kwarg', () => {
    const req = specialtyEngineRequest('gifts', { ...answers, entity_value: 1_000_000 });
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.prior_taxable_gifts).toBe(500_000);
    expect('prior_gifts_value' in inputs).toBe(false);
  });

  it('takes the entity value from the run inputs when intake has none', () => {
    const req = specialtyEngineRequest('gifts', answers, { entity_value: 8_000_000 });
    expect((req.body.inputs as Record<string, unknown>).entity_value).toBe(8_000_000);
  });

  it('refuses a run with no entity value at all', () => {
    expect(() => specialtyEngineRequest('gifts', answers, {})).toThrow(SpecialtyInputError);
  });

  it('refuses a run with no transferred percentage', () => {
    expect(() =>
      specialtyEngineRequest('gifts', { entity_value: 1_000_000, transfer_type: 'gift' }, {}),
    ).toThrow(SpecialtyInputError);
  });

  it('defaults an unanswered transfer type to a gift', () => {
    const req = specialtyEngineRequest('gifts', { entity_value: 1_000, percent_interest: 10 });
    expect((req.body.inputs as Record<string, unknown>).transfer_type).toBe('gift');
  });
});

describe('specialtyEngineRequest — IFRS 2', () => {
  const answers = {
    grant_date: '2026-01-01',
    settlement: 'cash_settled',
    vesting_condition: 'market',
    vesting_years: 4,
    exercise_price: 10,
    share_price: 12,
    options_granted: 100_000,
    expected_term_years: 4,
    expected_volatility: 0.6,
    risk_free_rate: 0.04,
  };

  it('assembles the award, the settlement and the model assumptions', () => {
    const req = specialtyEngineRequest('ifrs2', answers);
    expect(req.path).toBe('/engine/v1/ifrs2');
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.settlement).toBe('cash_settled');
    expect(inputs.expected_volatility).toBe(0.6);
    expect(inputs.options_granted).toBe(100_000);
  });

  it('passes the vesting condition through rather than collapsing it', () => {
    // It decides which paragraph governs — a market condition lives in the
    // grant-date fair value and a service condition does not.
    const req = specialtyEngineRequest('ifrs2', answers);
    expect((req.body.inputs as Record<string, unknown>).vesting_condition).toBe('market');
  });

  it('defaults settlement and condition to the ordinary case', () => {
    const req = specialtyEngineRequest('ifrs2', { exercise_price: 10 });
    const inputs = req.body.inputs as Record<string, unknown>;
    expect(inputs.settlement).toBe('equity_settled');
    expect(inputs.vesting_condition).toBe('service');
  });

  it('refuses a run with no exercise price', () => {
    expect(() => specialtyEngineRequest('ifrs2', { share_price: 10 })).toThrow(SpecialtyInputError);
  });

  it('lets a run override supply a lattice fair value', () => {
    const req = specialtyEngineRequest('ifrs2', answers, { fair_value_per_award: 3.25 });
    expect((req.body.inputs as Record<string, unknown>).fair_value_per_award).toBe(3.25);
  });
});

describe('specialtyHeadline', () => {
  it('reports the figures each kind actually concludes', () => {
    expect(
      specialtyHeadline(
        'esop',
        { path: '', body: { inputs: { equity_value: 10_000_000 } } },
        { fmv_per_share: 7.65 },
      ),
    ).toEqual({ equityValue: 10_000_000, fmvPerShare: 7.65 });

    expect(specialtyHeadline('fmv', { path: '', body: {} }, { equity_value: 512_500 })).toEqual({
      equityValue: 512_500,
      fmvPerShare: null,
    });

    expect(
      specialtyHeadline(
        'emi',
        { path: '', body: { params: { equity_value: 1_000_000 } } },
        { umv_per_share: 10, amv_per_share: 8.5 },
      ),
    ).toEqual({ equityValue: 1_000_000, fmvPerShare: 8.5 });

    expect(specialtyHeadline('qsbs', { path: '', body: {} }, { eligible: true })).toEqual({
      equityValue: null,
      fmvPerShare: null,
    });
  });

  it('reports a total for the three kinds that conclude no per-share figure', () => {
    // None of these values shares; a per-share column filled here would be a
    // number the deliverable never concluded.
    expect(
      specialtyHeadline('820', { path: '', body: {} }, { total_fair_value: 7_000_000 }),
    ).toEqual({ equityValue: 7_000_000, fmvPerShare: null });

    expect(
      specialtyHeadline(
        'gifts',
        { path: '', body: {} },
        // The transferred interest, deliberately not the entity value it came
        // from — that is the figure a reader would mistake for the appraisal.
        { entity_value: 10_000_000, concluded_value: 1_400_000 },
      ),
    ).toEqual({ equityValue: 1_400_000, fmvPerShare: null });

    expect(
      specialtyHeadline(
        'ifrs2',
        { path: '', body: {} },
        { total_expense: 275_000, fair_value_per_award: 2.75 },
      ),
    ).toEqual({ equityValue: 275_000, fmvPerShare: null });
  });
});

describe('isSpecialtyKind', () => {
  it('accepts exactly the specialty kinds', () => {
    for (const kind of [
      'qsbs',
      'ppa',
      'goodwill',
      'esop',
      'fmv',
      'emi',
      'csop',
      'ip',
      '820',
      'gifts',
      'ifrs2',
    ] as const) {
      expect(isSpecialtyKind(kind)).toBe(true);
    }
    expect(isSpecialtyKind('409a')).toBe(false);
    expect(isSpecialtyKind('debt')).toBe(false);
    // 718 stays on the generic path — it has its own ASC 718 route.
    expect(isSpecialtyKind('718')).toBe(false);
  });

  it('has a request builder for every kind it claims to support', () => {
    // The switch is exhaustive by type, but a kind added to the list without a
    // case would only surface at runtime on that kind's first run.
    for (const kind of SPECIALTY_KINDS) {
      let path: string | null = null;
      try {
        path = specialtyEngineRequest(kind, {}, {}).path;
      } catch (err) {
        // A missing-input refusal is a builder doing its job; anything else is
        // a kind with no dispatch behind it.
        expect(err).toBeInstanceOf(SpecialtyInputError);
        continue;
      }
      expect(path).toMatch(/^\/engine\/v1\//);
    }
  });
});
