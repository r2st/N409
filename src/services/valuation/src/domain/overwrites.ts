/**
 * Overwrites registry (features.md §3.6): the 68 fields an analyst may
 * manually override on a valuation, across 6 categories. This is the
 * self-documenting schema behind the explorer UI and the validation source
 * for PUT /valuations/:id/overwrites/:field_key.
 *
 * Category sizes mirror the documented production set:
 * company_info 7 · financial_metrics 17 · forecasts 12 · valuation_params 15
 * · market_comparables 16 · reporting 1 — 68 total.
 */

import { isIsoCalendarDate } from '@n409/shared';

export const OVERWRITE_CATEGORIES = [
  'company_info',
  'financial_metrics',
  'forecasts',
  'valuation_params',
  'market_comparables',
  'reporting',
] as const;
export type OverwriteCategory = (typeof OVERWRITE_CATEGORIES)[number];

export const OVERWRITE_CLASSES = ['numeric', 'date', 'character'] as const;
export type OverwriteClass = (typeof OVERWRITE_CLASSES)[number];

export interface OverwriteFieldDef {
  key: string;
  category: OverwriteCategory;
  class: OverwriteClass;
  label: string;
  description: string;
  min?: number;
  max?: number;
  example: string | number;
}

const f = (
  category: OverwriteCategory,
  cls: OverwriteClass,
  key: string,
  label: string,
  description: string,
  example: string | number,
  range?: { min?: number; max?: number },
): OverwriteFieldDef => ({ key, category, class: cls, label, description, example, ...range });

export const OVERWRITE_FIELDS: readonly OverwriteFieldDef[] = [
  // ── Company Information (7) ────────────────────────────────────────────────
  f(
    'company_info',
    'character',
    'company_legal_name',
    'Company legal name',
    'Registered legal entity name used on the report cover and certificates.',
    'Acme Robotics, Inc.',
  ),
  f(
    'company_info',
    'numeric',
    'industry_id',
    'Industry ID',
    'Numeric industry classification driving comparable selection and betas.',
    7372,
    { min: 1, max: 9999 },
  ),
  f(
    'company_info',
    'character',
    'incorporation_state',
    'State of incorporation',
    'US state (or country) of incorporation shown in the report.',
    'Delaware',
  ),
  f(
    'company_info',
    'date',
    'valuation_date',
    'Valuation date',
    'The as-of date of the valuation ("measurement date").',
    '2026-06-30',
  ),
  f(
    'company_info',
    'date',
    'yearend',
    'Fiscal year end',
    'Fiscal year-end date used to align financial periods.',
    '2026-12-31',
  ),
  f(
    'company_info',
    'character',
    'currency',
    'Currency',
    'ISO-4217 reporting currency for all monetary values.',
    'USD',
  ),
  f(
    'company_info',
    'character',
    'service_countries',
    'Service countries',
    'Comma-separated ISO country codes the company operates in.',
    'US,GB,DE',
  ),

  // ── Financial Metrics (17) ─────────────────────────────────────────────────
  f(
    'financial_metrics',
    'numeric',
    'last_year_revenue',
    'Last FY revenue',
    'Total revenue for the last completed fiscal year.',
    4_200_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'ytd_revenue',
    'YTD revenue',
    'Revenue from fiscal year start through the valuation date.',
    2_600_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'ltm_revenue',
    'LTM revenue',
    'Revenue over the trailing twelve months.',
    5_100_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'ntm_revenue',
    'NTM revenue',
    'Projected revenue over the next twelve months.',
    7_800_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'ltm_ebitda',
    'LTM EBITDA',
    'EBITDA over the trailing twelve months (may be negative).',
    -1_200_000,
  ),
  f(
    'financial_metrics',
    'numeric',
    'gross_profit',
    'Gross profit',
    'LTM revenue minus cost of goods sold.',
    3_400_000,
  ),
  f(
    'financial_metrics',
    'numeric',
    'operating_expenses',
    'Operating expenses',
    'LTM total operating expenses (S&M, R&D, G&A).',
    4_600_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'net_income',
    'Net income',
    'LTM net income (may be negative).',
    -1_500_000,
  ),
  f(
    'financial_metrics',
    'numeric',
    'cash_balance',
    'Cash balance',
    'Cash and cash equivalents at the valuation date.',
    3_800_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'monthly_burn',
    'Monthly burn',
    'Average monthly net cash outflow over the last quarter.',
    220_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'runway_months',
    'Runway (months)',
    'Months of runway implied by cash balance and burn.',
    17,
    { min: 0, max: 240 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'total_debt',
    'Total debt',
    'Interest-bearing debt outstanding at the valuation date.',
    500_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'preferred_liquidation',
    'Preferred liquidation preference',
    'Aggregate liquidation preference of preferred stock.',
    12_000_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'working_capital',
    'Working capital',
    'Current assets minus current liabilities.',
    900_000,
  ),
  f('financial_metrics', 'numeric', 'capex', 'Capital expenditure', 'LTM capital expenditure.', 150_000, {
    min: 0,
  }),
  f(
    'financial_metrics',
    'numeric',
    'deferred_revenue',
    'Deferred revenue',
    'Deferred/unearned revenue balance at the valuation date.',
    640_000,
    { min: 0 },
  ),
  f(
    'financial_metrics',
    'numeric',
    'accounts_receivable',
    'Accounts receivable',
    'Trade receivables at the valuation date.',
    480_000,
    { min: 0 },
  ),

  // ── Forecasts & Projections (12) ───────────────────────────────────────────
  f(
    'forecasts',
    'numeric',
    'fy1_revenue',
    'FY+1 revenue forecast',
    'Management revenue forecast for the next fiscal year.',
    9_000_000,
    { min: 0 },
  ),
  f(
    'forecasts',
    'numeric',
    'fy2_revenue',
    'FY+2 revenue forecast',
    'Management revenue forecast two fiscal years out.',
    14_500_000,
    { min: 0 },
  ),
  f(
    'forecasts',
    'numeric',
    'fy3_revenue',
    'FY+3 revenue forecast',
    'Management revenue forecast three fiscal years out.',
    22_000_000,
    { min: 0 },
  ),
  f(
    'forecasts',
    'numeric',
    'fy1_ebitda',
    'FY+1 EBITDA forecast',
    'EBITDA forecast for the next fiscal year (may be negative).',
    -800_000,
  ),
  f(
    'forecasts',
    'numeric',
    'fy2_ebitda',
    'FY+2 EBITDA forecast',
    'EBITDA forecast two fiscal years out.',
    600_000,
  ),
  f(
    'forecasts',
    'numeric',
    'fy3_ebitda',
    'FY+3 EBITDA forecast',
    'EBITDA forecast three fiscal years out.',
    3_100_000,
  ),
  f(
    'forecasts',
    'numeric',
    'revenue_growth_rate',
    'Revenue growth rate',
    'Assumed annual revenue growth across the forecast horizon (fraction).',
    0.55,
    { min: -1, max: 10 },
  ),
  f(
    'forecasts',
    'numeric',
    'terminal_growth_rate',
    'Terminal growth rate',
    'Perpetuity growth rate for terminal value (fraction).',
    0.03,
    { min: -0.05, max: 0.15 },
  ),
  f(
    'forecasts',
    'date',
    'forecast_start',
    'Forecast start date',
    'First day of the projection period.',
    '2026-07-01',
  ),
  f(
    'forecasts',
    'numeric',
    'forecast_horizon_years',
    'Forecast horizon (years)',
    'Number of explicitly projected years before terminal value.',
    5,
    { min: 1, max: 15 },
  ),
  f(
    'forecasts',
    'date',
    'breakeven_date',
    'Breakeven date',
    'Projected date of EBITDA breakeven.',
    '2028-03-31',
  ),
  f(
    'forecasts',
    'numeric',
    'projected_headcount',
    'Projected headcount',
    'Headcount at the end of the forecast horizon.',
    120,
    { min: 0, max: 1_000_000 },
  ),

  // ── Valuation Parameters (15) ──────────────────────────────────────────────
  f(
    'valuation_params',
    'date',
    'exit_timeline',
    'Exit timeline',
    'Assumed liquidity-event date (drives OPM term).',
    '2030-06-30',
  ),
  f(
    'valuation_params',
    'numeric',
    'time_to_exit_years',
    'Time to exit (years)',
    'Years from the valuation date to the assumed exit.',
    4,
    { min: 0.1, max: 20 },
  ),
  f(
    'valuation_params',
    'numeric',
    'risk_free_rate',
    'Risk-free rate',
    'Treasury rate matched to the OPM term (fraction).',
    0.042,
    { min: 0, max: 0.2 },
  ),
  f(
    'valuation_params',
    'numeric',
    'volatility',
    'Volatility',
    'Equity volatility from guideline companies (fraction).',
    0.65,
    { min: 0.05, max: 3 },
  ),
  f('valuation_params', 'numeric', 'dlom', 'DLOM', 'Discount for lack of marketability (fraction).', 0.28, {
    min: 0,
    max: 0.9,
  }),
  f('valuation_params', 'numeric', 'dloc', 'DLOC', 'Discount for lack of control (fraction).', 0.1, {
    min: 0,
    max: 0.9,
  }),
  f(
    'valuation_params',
    'character',
    'dlom_method',
    'DLOM method',
    'Model used for DLOM: chaffee, finnerty, or qualitative.',
    'finnerty',
  ),
  f(
    'valuation_params',
    'numeric',
    'weight_asset',
    'Asset approach weight',
    'Weight given to the asset approach (fraction; weights sum to 1).',
    0,
    { min: 0, max: 1 },
  ),
  f(
    'valuation_params',
    'numeric',
    'weight_opm',
    'OPM backsolve weight',
    'Weight given to the OPM backsolve (fraction; weights sum to 1).',
    0.7,
    { min: 0, max: 1 },
  ),
  f(
    'valuation_params',
    'numeric',
    'weight_income',
    'Income approach weight',
    'Weight given to the income approach (fraction; weights sum to 1).',
    0.15,
    { min: 0, max: 1 },
  ),
  f(
    'valuation_params',
    'numeric',
    'weight_market',
    'Market approach weight',
    'Weight given to the market approach (fraction; weights sum to 1).',
    0.15,
    { min: 0, max: 1 },
  ),
  f(
    'valuation_params',
    'numeric',
    'discount_rate',
    'Discount rate',
    'Required rate of return applied in the income approach (fraction).',
    0.32,
    { min: 0, max: 1 },
  ),
  f('valuation_params', 'numeric', 'tax_rate', 'Tax rate', 'Effective corporate tax rate (fraction).', 0.21, {
    min: 0,
    max: 0.6,
  }),
  f(
    'valuation_params',
    'character',
    'revenue_status',
    'Revenue status',
    'pre_revenue or post_revenue — gates methodology defaults.',
    'post_revenue',
  ),
  f(
    'valuation_params',
    'numeric',
    'bootstrap_assets',
    'Bootstrap assets',
    'Asset base used when bootstrapping the asset approach.',
    250_000,
    { min: 0 },
  ),

  // ── Market & Comparables (16) ──────────────────────────────────────────────
  f(
    'market_comparables',
    'numeric',
    'revenue_multiple',
    'Revenue multiple',
    'Selected EV/Revenue multiple applied in the market approach.',
    6.5,
    { min: 0, max: 1000 },
  ),
  f(
    'market_comparables',
    'numeric',
    'ebitda_multiple',
    'EBITDA multiple',
    'Selected EV/EBITDA multiple applied in the market approach.',
    14,
    { min: 0, max: 1000 },
  ),
  f(
    'market_comparables',
    'numeric',
    'multiple_percentile',
    'Multiple percentile',
    'Percentile of the comparable-set multiple distribution used (0–1).',
    0.25,
    { min: 0, max: 1 },
  ),
  f(
    'market_comparables',
    'character',
    'comparable_set',
    'Comparable set',
    'Named guideline-company set applied to this valuation.',
    'saas_smid_2026q2',
  ),
  f('market_comparables', 'numeric', 'beta', 'Beta', 'Relevered equity beta from the guideline set.', 1.3, {
    min: -2,
    max: 5,
  }),
  f(
    'market_comparables',
    'numeric',
    'size_premium',
    'Size premium',
    'Small-company size premium added to the cost of equity (fraction).',
    0.05,
    { min: 0, max: 0.2 },
  ),
  f(
    'market_comparables',
    'numeric',
    'country_risk_premium',
    'Country risk premium',
    'Premium for non-US operations (fraction).',
    0.01,
    { min: 0, max: 0.2 },
  ),
  f(
    'market_comparables',
    'numeric',
    'equity_risk_premium',
    'Equity risk premium',
    'Market equity risk premium (fraction).',
    0.055,
    { min: 0, max: 0.2 },
  ),
  f(
    'market_comparables',
    'numeric',
    'market_cap_floor',
    'Market-cap floor',
    'Minimum comparable market cap admitted to the set.',
    50_000_000,
    { min: 0 },
  ),
  f(
    'market_comparables',
    'numeric',
    'market_cap_ceiling',
    'Market-cap ceiling',
    'Maximum comparable market cap admitted to the set.',
    2_000_000_000,
    { min: 0 },
  ),
  f(
    'market_comparables',
    'numeric',
    'ltm_multiple_weight',
    'LTM multiple weight',
    'Weight on trailing multiples vs forward (fraction).',
    0.5,
    { min: 0, max: 1 },
  ),
  f(
    'market_comparables',
    'numeric',
    'ntm_multiple_weight',
    'NTM multiple weight',
    'Weight on forward multiples vs trailing (fraction).',
    0.5,
    { min: 0, max: 1 },
  ),
  f(
    'market_comparables',
    'character',
    'selected_tickers',
    'Selected tickers',
    'Comma-separated tickers of accepted guideline companies.',
    'CRM,NOW,HUBS,DDOG',
  ),
  f(
    'market_comparables',
    'numeric',
    'industry_beta',
    'Industry beta',
    'Unlevered industry beta before relevering.',
    1.1,
    { min: -2, max: 5 },
  ),
  f(
    'market_comparables',
    'numeric',
    'control_premium',
    'Control premium',
    'Premium applied when moving from minority to control basis (fraction).',
    0.2,
    { min: 0, max: 1 },
  ),
  f(
    'market_comparables',
    'numeric',
    'illiquidity_adjustment',
    'Illiquidity adjustment',
    'Additional multiple haircut for private-company illiquidity (fraction).',
    0.15,
    { min: 0, max: 1 },
  ),

  // ── Reporting & Filing (1) ─────────────────────────────────────────────────
  f(
    'reporting',
    'character',
    'report_disclaimer',
    'Report disclaimer',
    'Custom disclaimer paragraph appended to the report conclusion.',
    'This valuation is intended solely for IRC 409A compliance…',
  ),
];

export const OVERWRITE_FIELDS_BY_KEY: ReadonlyMap<string, OverwriteFieldDef> = new Map(
  OVERWRITE_FIELDS.map((def) => [def.key, def]),
);

export type OverwriteValue = number | string;

/**
 * Validates a candidate value against a field's class (and numeric range).
 * Returns a problem message or null when valid.
 */
export function validateOverwriteValue(def: OverwriteFieldDef, value: unknown): string | null {
  switch (def.class) {
    case 'numeric': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number';
      if (def.min !== undefined && value < def.min) return `must be ≥ ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be ≤ ${def.max}`;
      return null;
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return 'must be an ISO date (YYYY-MM-DD)';
      }
      if (!isIsoCalendarDate(value)) return 'must be a real calendar date';
      return null;
    }
    case 'character': {
      if (typeof value !== 'string') return 'must be a string';
      if (value.length === 0) return 'must not be empty';
      if (value.length > 2000) return 'must be at most 2000 characters';
      return null;
    }
  }
}
