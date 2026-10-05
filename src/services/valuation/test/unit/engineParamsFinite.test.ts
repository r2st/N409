import { describe, expect, it } from 'vitest';
import { engineParams } from '../../src/routes/calculations.js';
import type { ValuationParamsRow } from '../../src/repos/params.js';

/**
 * `engineParams` converts database `numeric` strings to JavaScript numbers for
 * the engine payload. PostgreSQL `numeric` can hold NaN and Infinity, and the
 * pg driver returns them as strings. Before R367 the `num()` helper did not
 * check `Number.isFinite()`, so a corrupt column value would silently feed NaN
 * or Infinity into the engine — the same file already checked the engine's
 * OUTPUT for finiteness (line 153) but not its INPUT.
 */

const MINIMAL_ROW: ValuationParamsRow = {
  valuation_id: '01JTEST000000000000000000',
  rolling_forward: false,
  inception_date: null,
  fiscal_year_end: null,
  exit_timeline: null,
  business_overview: null,
  revenue_status: null,
  development_stage: null,
  last_round_date: null,
  last_year_revenue_cents: null,
  ytd_revenue_cents: null,
  runway_months: null,
  weight_asset: '0.25',
  weight_opm: '0.25',
  weight_income: '0.25',
  weight_market: '0.25',
  dloc: '0.15',
  dloc_method: null,
  control_premium: null,
  dloc_synergy_share: null,
  dloc_studies: null,
  dloc_statistic: null,
  dloc_study_table: null,
  dlom: '0.20',
  dlom_method: null,
  dlom_methods: null,
  dlom_qualitative: null,
  dlom_studies: null,
  dlom_statistic: null,
  dlom_study_table: null,
  dlom_pre_ipo_studies: null,
  dlom_pre_ipo_table: null,
  required_return_table: null,
  wacc_inputs: null,
  auto_wacc: false,
  market_method: null,
  market_horizon: null,
  market_custom_ranges: null,
  asset_method: null,
  allocation_method: 'opm' as const,
  version: 1,
  updated_at: new Date(),
};

describe('engineParams rejects non-finite numeric strings from the database', () => {
  it('converts valid numeric strings to numbers', () => {
    const result = engineParams(MINIMAL_ROW);
    expect(result.weight_asset).toBe(0.25);
    expect(result.dloc).toBe(0.15);
    expect(result.dlom).toBe(0.20);
  });

  it('nullifies a NaN string — the shape a pg numeric NaN arrives as', () => {
    const row = { ...MINIMAL_ROW, weight_asset: 'NaN' };
    const result = engineParams(row);
    expect(result.weight_asset).toBeNull();
  });

  it('nullifies an Infinity string', () => {
    const row = { ...MINIMAL_ROW, dloc: 'Infinity' };
    const result = engineParams(row);
    expect(result.dloc).toBeNull();
  });

  it('nullifies a negative Infinity string', () => {
    const row = { ...MINIMAL_ROW, dlom: '-Infinity' };
    const result = engineParams(row);
    expect(result.dlom).toBeNull();
  });

  it('preserves null columns as null', () => {
    const row = { ...MINIMAL_ROW, control_premium: null };
    const result = engineParams(row);
    expect(result.control_premium).toBeNull();
  });
});
