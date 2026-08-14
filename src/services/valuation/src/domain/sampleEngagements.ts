import type { ParamsPatch } from '../routes/params.js';
import type { EngineInputsPatch } from '../routes/engineInputs.js';
import type { Asc718Portfolio } from './asc718.js';

/**
 * Three worked engagements, as reference data.
 *
 * The platform had nothing to show. A visitor who logged in saw an empty
 * valuations list — or, worse, four "pending" rows named `M1 SmokeCo` and
 * `Smoke M3 Co` left behind by a deployment check — and every screen behind
 * them (the workbook, the exhibits, the calculation inspector, the report
 * editor) renders as an empty frame until an engagement has actually been run
 * through the engine. None of the work the engine does was visible anywhere.
 *
 * These are the fixtures for that, and they are deliberately *definitions*
 * rather than a SQL dump: `tools/seed-samples.mjs` drives them through the same
 * public API an analyst uses, so a sample is only ever as good as the endpoints
 * that made it. A field the API would refuse cannot be seeded, and a sample
 * that stops matching the schema fails the unit test in
 * `test/unit/sampleEngagements.test.ts` at build time rather than at seed time
 * on a production host.
 *
 * The three are chosen to cover the paths that otherwise only exist in tests:
 *
 *   * **Meridian Data Systems** — a Series B SaaS company at roughly $50M ARR.
 *     Backsolve from a priced round, moved by a benchmark; a three-series
 *     preference stack with a participation cap; a weighted DLOM blended across
 *     two option-based models and the restricted-stock studies; a DLOC inverted
 *     from a control premium net of synergies. OPM allocation.
 *   * **Helix Therapeutics** — pre-revenue clinical-stage biotech. No income
 *     and no market approach, because there is nothing to strike a multiple
 *     against; a hybrid allocation blending the OPM continuation case with four
 *     discrete PWERM outcomes; a pre-IPO study DLOM; a *downward* market
 *     movement, which the SaaS engagement does not exercise.
 *   * **Cascade Precision Manufacturing** — a profitable, closely held
 *     manufacturer. No priced round at all, so no backsolve: asset, income and
 *     market approaches only, a mid-year-convention DCF, EBITDA multiples, a
 *     current-value allocation over a single common class, and a DLOC blended
 *     from control-premium studies.
 *
 * Every figure below is invented for a company that does not exist. The study
 * names are the engine's own built-in tables (`engine/dlom.py`,
 * `engine/dloc.py`); nothing here cites a source that is not already cited
 * there.
 */

/** A company profile patch, as `PATCH /valuations/:id/company-profile` takes it. */
export interface SampleCompanyProfile {
  legal_name: string;
  website: string;
  address_line1: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  industry: string;
  founded_on: string;
  employee_count: number;
  revenue_range: 'pre_revenue' | 'under_1m' | '1m_10m' | '10m_50m' | '50m_100m' | 'over_100m';
  cap_table_summary: string;
}

/** One workbook input cell, as `PATCH /valuations/:id/workbook` takes it. */
export interface SampleWorkbookCell {
  sheet: string;
  row_key: string;
  column_key: string;
  value: number;
}

/** One peer, as `POST /valuations/:id/comparables` takes it. */
export interface SampleComparable {
  ticker: string;
  name: string;
  included: boolean;
  exclude_reason?: string;
  revenue_ltm?: number;
  revenue_ntm?: number;
  ebitda_ltm?: number;
  ebitda_ntm?: number;
  ev: number;
}

/** An option grant, as `POST /valuations/:id/asc718` takes it. */
export interface SampleGrant {
  label: string;
  options_granted: number;
  grant_date: string;
  vesting_months: number;
  exercise_price: number;
  risk_free_rate: number;
  forfeiture_rate: number;
  contractual_term_years: number;
}

export interface SampleEngagement {
  /** Stable handle for the CLI (`--only=saas`) and for the tests. */
  key: string;
  companyName: string;
  serviceName: string;
  /** One line for the seeding log, so a run reads as a list of what it built. */
  summary: string;
  profile: SampleCompanyProfile;
  params: ParamsPatch;
  engineInputs: EngineInputsPatch;
  workbook: SampleWorkbookCell[];
  comparables: SampleComparable[];
  grants: SampleGrant[];
  /**
   * Authored chapter bodies, keyed by the 409A skeleton's section key.
   *
   * Only the chapters the skeleton leaves to the analyst are here. The rest of
   * the template — the purpose, the standard of value, the limiting
   * conditions, the certification — is boilerplate that is already complete,
   * and restating it per company would be three copies of one paragraph
   * drifting apart.
   *
   * `{{placeholder}}` is not only allowed but wanted: those resolve against the
   * calculation at render time (domain/reportFigures.ts), so a re-render after
   * a recalculation restates the prose instead of leaving a stale figure in it.
   * An *ellipsis* is the one thing that must not appear — that is the marker
   * meaning "nobody wrote this yet", and the publish gate reads it as such.
   */
  narrative: Record<string, string>;
  signature: { signer_name: string; signer_title: string; signature_text: string };
}

const P = (html: string): string => `<p>${html}</p>`;
const UL = (items: string[]): string => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

// ── workbook helpers ─────────────────────────────────────────────────────────
//
// The workbook is five fiscal periods wide and the interesting part of a sample
// is the numbers, not the addressing. These turn a row-keyed object of
// five-element arrays into the flat cell list the PATCH endpoint takes, so a
// sample reads as a financial statement rather than as sixty coordinate
// triples. A `null` entry leaves that cell unset.

const FISCAL_COLUMNS = ['fy_minus_2', 'fy_minus_1', 'fy_current', 'fy_plus_1', 'fy_plus_2'] as const;

function sheetCells(sheet: string, rows: Record<string, ReadonlyArray<number | null>>): SampleWorkbookCell[] {
  const cells: SampleWorkbookCell[] = [];
  for (const [row_key, values] of Object.entries(rows)) {
    values.forEach((value, i) => {
      const column_key = FISCAL_COLUMNS[i];
      if (value === null || column_key === undefined) return;
      cells.push({ sheet, row_key, column_key, value });
    });
  }
  return cells;
}

function incomeStatement(rows: Record<string, ReadonlyArray<number | null>>): SampleWorkbookCell[] {
  return sheetCells('income_statement', rows);
}

function balanceSheet(rows: Record<string, ReadonlyArray<number | null>>): SampleWorkbookCell[] {
  return sheetCells('balance_sheet', rows);
}

/** The assumptions sheet is one column wide, so it takes scalars. */
function assumptions(rows: Record<string, number>): SampleWorkbookCell[] {
  return Object.entries(rows).map(([row_key, value]) => ({
    sheet: 'assumptions',
    row_key,
    column_key: 'value',
    value,
  }));
}

// ── Meridian Data Systems — Series B SaaS ────────────────────────────────────

const MERIDIAN: SampleEngagement = {
  key: 'saas',
  companyName: 'Meridian Data Systems, Inc.',
  serviceName: '409A Valuation — FY2026 Q2',
  summary: 'Series B SaaS, ~$50M ARR — OPM backsolve, market movement, blended DLOM',
  profile: {
    legal_name: 'Meridian Data Systems, Inc.',
    website: 'https://www.meridiandata.example',
    address_line1: '1100 Harrison Street, Suite 400',
    city: 'San Francisco',
    region: 'CA',
    postal_code: '94103',
    country: 'United States',
    industry: 'Enterprise software — data observability (SaaS)',
    founded_on: '2018-03-12',
    employee_count: 284,
    revenue_range: '10m_50m',
    cap_table_summary:
      'Three preferred series (Seed, A, B) totalling 27,875,000 shares against $90.0M of ' +
      'liquidation preference, 38,000,000 common shares, and a 9,200,000-share option pool ' +
      'under the 2018 Stock Plan. The Seed series participates, capped at 2.0x its preference.',
  },
  params: {
    rolling_forward: false,
    inception_date: '2018-03-12',
    fiscal_year_end: '2026-12-31',
    exit_timeline: '2030-12-31',
    business_overview:
      'Meridian Data Systems sells a data-observability platform that monitors freshness, ' +
      'schema drift and quality across enterprise data warehouses. Annual recurring revenue ' +
      'reached $50.4M at 30 June 2026 across 412 customers, with net revenue retention of 121% ' +
      'and gross margin of 78%.',
    revenue_status: 'post_revenue',
    development_stage: 5,
    last_round_date: '2025-11-14',
    last_year_revenue_cents: 3_190_000_000,
    ytd_revenue_cents: 2_460_000_000,
    runway_months: 34,
    weight_asset: 0,
    weight_opm: 0.5,
    weight_income: 0.2,
    weight_market: 0.3,
    // Inverted from an observed acquisition premium, with the share of that
    // premium attributable to synergies removed first.
    dloc_method: 'control_premium',
    control_premium: 0.22,
    dloc_synergy_share: 0.35,
    // Weighted across two option-based models and the empirical studies rather
    // than concluded on one.
    dlom_methods: [
      { method: 'finnerty', weight: 0.5 },
      { method: 'chaffee', weight: 0.25 },
      { method: 'restricted_stock', weight: 0.25 },
    ],
    dlom_studies: [
      'Management Planning Inc.',
      'FMV Opinions',
      'Johnson',
      'Columbia Financial Advisors (post-amendment)',
    ],
    dlom_statistic: 'median',
    market_method: 'revenue',
    market_horizon: 'ltm',
    allocation_method: 'opm',
  },
  engineInputs: {
    valuation_date: '2026-06-30',
    shares_outstanding_common: 38_000_000,
    options_outstanding: 9_200_000,
    shares_outstanding_preferred: 27_875_000,
    liquidation_preference: 90_000_000,
    volatility: 0.55,
    risk_free_rate: 0.0421,
    cash: 71_400_000,
    debt: 4_000_000,
    last_round_post_money: 480_000_000,
    last_round_price_per_share: 6.4,
    last_round_class: 'Series B Preferred',
    market_movement: {
      index_name: 'S&P North American Technology Software Index',
      index_start: 4_812.6,
      index_end: 5_164.3,
      period_start: '2025-11-14',
      period_end: '2026-06-30',
      beta: 1.2,
    },
    income: {
      free_cash_flows: [-14_200_000, -6_800_000, 8_400_000, 28_500_000, 52_000_000, 74_000_000, 96_000_000],
      revenues: [62_500_000, 84_400_000, 109_700_000, 137_100_000, 164_500_000, 189_200_000, 212_900_000],
      discount_rate: 0.185,
      terminal_growth: 0.035,
      mid_year_convention: true,
      terminal_method: 'gordon',
    },
    market: { metric: 43_800_000, multiples: [8.9, 7.2, 11.4, 6.5, 9.8] },
    share_classes: [
      {
        kind: 'preferred',
        name: 'Series B Preferred',
        shares: 9_375_000,
        preference: 60_000_000,
        seniority: 1,
        participating: false,
        conversion_ratio: 1,
      },
      {
        kind: 'preferred',
        name: 'Series A Preferred',
        shares: 12_000_000,
        preference: 24_000_000,
        seniority: 2,
        participating: false,
        conversion_ratio: 1,
      },
      {
        kind: 'preferred',
        name: 'Seed Preferred',
        shares: 6_500_000,
        preference: 6_000_000,
        seniority: 3,
        participating: true,
        participation_cap: 12_000_000,
        conversion_ratio: 1,
      },
      { kind: 'common', name: 'Common Stock', shares: 38_000_000 },
      { kind: 'option', name: 'Option pool (2018 Stock Plan)', shares: 9_200_000, strike: 1.1 },
    ],
  },
  workbook: [
    ...incomeStatement({
      revenue: [14_800_000, 31_900_000, 43_800_000, 62_500_000, 84_400_000],
      cogs: [4_100_000, 7_700_000, 9_600_000, 13_100_000, 17_300_000],
      operating_expenses: [21_400_000, 34_800_000, 40_100_000, 49_700_000, 58_900_000],
      depreciation_amortization: [900_000, 1_400_000, 1_900_000, 2_400_000, 2_900_000],
      interest_expense: [120_000, 260_000, 340_000, 320_000, 300_000],
      taxes: [0, 0, 0, 0, 1_600_000],
    }),
    ...balanceSheet({
      cash: [22_600_000, 18_900_000, 71_400_000, 58_200_000, 54_800_000],
      accounts_receivable: [2_900_000, 6_400_000, 9_100_000, 12_800_000, 17_100_000],
      other_current_assets: [1_100_000, 1_800_000, 2_400_000, 3_000_000, 3_600_000],
      ppe_net: [1_800_000, 2_600_000, 3_100_000, 3_800_000, 4_400_000],
      intangibles: [0, 0, 0, 0, 0],
      other_long_term_assets: [1_400_000, 2_100_000, 2_700_000, 3_100_000, 3_400_000],
      accounts_payable: [1_600_000, 2_900_000, 3_700_000, 4_900_000, 6_200_000],
      short_term_debt: [0, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
      other_current_liabilities: [7_400_000, 15_600_000, 22_300_000, 30_100_000, 39_400_000],
      long_term_debt: [4_000_000, 4_000_000, 3_000_000, 2_000_000, 1_000_000],
      other_long_term_liabilities: [900_000, 1_300_000, 1_600_000, 1_900_000, 2_200_000],
    }),
    ...assumptions({
      discount_rate: 0.185,
      tax_rate: 0.21,
      terminal_growth_rate: 0.035,
      revenue_multiple: 8.76,
      dlom: 0.28,
      dloc: 0.125,
      volatility: 0.55,
      risk_free_rate: 0.0421,
      time_to_exit_years: 4.5,
    }),
  ],
  comparables: [
    {
      ticker: 'DDOG',
      name: 'Datadog, Inc.',
      included: true,
      revenue_ltm: 2_680_000_000,
      revenue_ntm: 3_240_000_000,
      ebitda_ltm: 466_000_000,
      ev: 30_500_000_000,
    },
    {
      ticker: 'MDB',
      name: 'MongoDB, Inc.',
      included: true,
      revenue_ltm: 1_940_000_000,
      revenue_ntm: 2_290_000_000,
      ebitda_ltm: 96_000_000,
      ev: 22_100_000_000,
    },
    {
      ticker: 'CFLT',
      name: 'Confluent, Inc.',
      included: true,
      revenue_ltm: 964_000_000,
      revenue_ntm: 1_150_000_000,
      ebitda_ltm: 41_000_000,
      ev: 8_580_000_000,
    },
    {
      ticker: 'ESTC',
      name: 'Elastic N.V.',
      included: true,
      revenue_ltm: 1_380_000_000,
      revenue_ntm: 1_580_000_000,
      ebitda_ltm: 152_000_000,
      ev: 8_970_000_000,
    },
    {
      ticker: 'DT',
      name: 'Dynatrace, Inc.',
      included: true,
      revenue_ltm: 1_610_000_000,
      revenue_ntm: 1_860_000_000,
      ebitda_ltm: 372_000_000,
      ev: 15_780_000_000,
    },
    {
      ticker: 'SNOW',
      name: 'Snowflake Inc.',
      included: false,
      exclude_reason:
        'Consumption-model revenue at more than 60x the subject’s scale; growth and margin profile not comparable',
      revenue_ltm: 3_620_000_000,
      revenue_ntm: 4_450_000_000,
      ebitda_ltm: -240_000_000,
      ev: 51_400_000_000,
    },
  ],
  grants: [
    {
      label: 'FY2026 new-hire grants',
      options_granted: 1_240_000,
      grant_date: '2026-07-15',
      vesting_months: 48,
      exercise_price: 2.9,
      risk_free_rate: 0.0421,
      forfeiture_rate: 0.11,
      contractual_term_years: 10,
    },
    {
      label: 'FY2026 refresh grants',
      options_granted: 620_000,
      grant_date: '2026-07-15',
      vesting_months: 36,
      exercise_price: 2.9,
      risk_free_rate: 0.0421,
      forfeiture_rate: 0.07,
      contractual_term_years: 10,
    },
  ],
  narrative: {
    company_overview:
      P(
        'Meridian Data Systems, Inc. was incorporated in Delaware on 12 March 2018 and is ' +
          'headquartered in San Francisco, California. The company sells a data-observability ' +
          'platform that monitors data freshness, schema drift and quality across enterprise data ' +
          'warehouses and streaming pipelines, and alerts data teams before a broken pipeline ' +
          'reaches a downstream report.',
      ) +
      P(
        'The product is delivered as a multi-tenant SaaS subscription priced on monitored table ' +
          'volume, sold to data-platform teams at mid-market and enterprise accounts. At the ' +
          'valuation date the company served 412 paying customers, employed 284 people, and had ' +
          'raised $96.0M of preferred equity across a seed round (2019), a Series A (2022) and a ' +
          'Series B (November 2025).',
      ) +
      P(
        'Annual recurring revenue was $50.4M at 30 June 2026, against $34.1M twelve months ' +
          'earlier. Revenue on a trailing twelve-month basis was $43.8M. Net revenue retention was ' +
          '121% and gross margin 78%. The company is not profitable and does not expect to be ' +
          'before FY2028.',
      ),
    company_analysis:
      P(
        'Revenue Ruling 59-60 §4.01 sets out the factors to be considered in valuing the stock of ' +
          'a closely held corporation. Each is addressed below.',
      ) +
      UL([
        '<strong>Nature and history of the business</strong> — eight years old, venture-funded ' +
          'throughout, with no discontinuity in the operating record. The platform shipped in 2019 ' +
          'and has been sold on substantially the same commercial model since.',
        '<strong>Economic and industry outlook</strong> — addressed in the two sections that follow.',
        '<strong>Book value and financial condition</strong> — $71.4M of cash against $4.0M of ' +
          'venture debt at the valuation date, and 34 months of runway on the current plan. Book ' +
          'value is not informative for a business of this kind: substantially all of the value a ' +
          'buyer would pay for is the customer base, the product and the assembled team, none of ' +
          'which appears on the balance sheet.',
        '<strong>Earning capacity</strong> — negative on a trailing basis. Management projects ' +
          'operating breakeven in FY2028 on a plan reviewed with us and summarised under the income ' +
          'approach below.',
        '<strong>Dividend-paying capacity</strong> — none. The company has never paid a dividend, ' +
          'is contractually restricted from doing so by the Series B charter, and would not have ' +
          'the capacity to pay one while it is consuming cash.',
        '<strong>Goodwill and other intangible value</strong> — the platform, the customer ' +
          'relationships and the engineering organisation. These are captured by the income and ' +
          'market approaches and are the reason the asset approach carries no weight.',
        '<strong>Prior sales of stock and the size of the block</strong> — the Series B closed on ' +
          '14 November 2025 at $6.40 per share for $60.0M. We are aware of no secondary ' +
          'transactions in common stock. The subject interest is a single share of common, a ' +
          'minority block with no ability to compel a liquidity event.',
        '<strong>Comparable companies</strong> — the guideline set is addressed under the market ' +
          'approach and named in Exhibit D-1.',
      ]) +
      P(
        'The risks a buyer of common stock would price are concentration of new bookings in the ' +
          'enterprise segment, competition from observability suites bundled by the cloud ' +
          'hyperscalers, dependence on a small senior engineering group, and the need for a ' +
          'further financing round before the plan reaches self-funding.',
      ),
    capital_structure:
      P(
        'The capitalization of Meridian Data Systems, Inc. as of the valuation date is set out in ' +
          '<strong>Exhibit A</strong>. Three series of preferred stock rank ahead of the common:',
      ) +
      UL([
        '<strong>Series B Preferred</strong> — 9,375,000 shares, $60.0M liquidation preference, ' +
          'senior to all other classes, non-participating, convertible one-for-one.',
        '<strong>Series A Preferred</strong> — 12,000,000 shares, $24.0M liquidation preference, ' +
          'second in rank, non-participating, convertible one-for-one.',
        '<strong>Seed Preferred</strong> — 6,500,000 shares, $6.0M liquidation preference, third ' +
          'in rank, <em>participating</em> with total proceeds capped at $12.0M (2.0x its ' +
          'preference), convertible one-for-one.',
        '<strong>Common Stock</strong> — 38,000,000 shares outstanding, the subject class.',
        '<strong>Options</strong> — 9,200,000 shares reserved and outstanding under the 2018 Stock ' +
          'Plan at a weighted-average exercise price of $1.10.',
      ]) +
      P(
        'No convertible notes or SAFEs were outstanding at the valuation date, and no anti-dilution ' +
          'adjustment was in effect. The aggregate liquidation preference is $90.0M. These rights ' +
          'determine the payoff of each class at a liquidity event and are the direct inputs to the ' +
          'allocation described below; the Seed participation cap is the reason that class stops ' +
          'sharing in value above $12.0M of proceeds and its breakpoint closes.',
      ),
    economic_outlook: P(
      'At the valuation date US real GDP growth was running in the low single digits, headline ' +
        'inflation had settled near the Federal Reserve’s target, and the yield on the five-year ' +
        'Treasury — the maturity matched to the expected time to liquidity applied below — was ' +
        '4.21%, which is the risk-free rate used throughout this analysis. Venture funding volumes ' +
        'had recovered from the 2023 trough but remained concentrated: late-stage rounds were ' +
        'available to companies with durable growth and a credible path to profitability, and ' +
        'materially harder to raise for those without one. Both conditions bear directly on this ' +
        'valuation, the first through the discount rate and the second through the time and ' +
        'probability assigned to a liquidity event.',
    ),
    industry_market: P(
      'Data observability is a segment of the broader IT-operations monitoring market, which ' +
        'independent estimates place in the region of $30B globally and growing in the high teens ' +
        'annually. Adoption is driven by the migration of analytics workloads to cloud warehouses ' +
        'and by the operational dependence of machine-learning systems on pipeline reliability. ' +
        'The competitive field has three tiers: broad observability platforms extending into data ' +
        '(Datadog, Dynatrace), warehouse-native tooling from the data platforms themselves, and ' +
        'independent specialists, of which the subject is one. Meridian competes on depth of ' +
        'warehouse coverage and on time-to-detection rather than on price, and its 121% net ' +
        'revenue retention indicates the land-and-expand motion is working within its installed base.',
    ),
    financial_analysis:
      P(
        'The historical financial statements the analysis rests on are reproduced in ' +
          '<strong>Appendix II</strong>. Revenue grew from $14.8M in FY2024 to $31.9M in FY2025 and ' +
          '$43.8M on a trailing twelve-month basis at the valuation date — 116% and 37% ' +
          'year-over-year respectively. Gross margin was 78%, consistent with an efficiently ' +
          'operated multi-tenant SaaS platform.',
      ) +
      P(
        'Operating expenses of $40.1M on a trailing basis exceeded gross profit, producing negative ' +
          'EBITDA of $5.9M. Cash burn was funded by the Series B; cash stood at $71.4M against ' +
          '$4.0M of venture debt, giving 34 months of runway on management’s current plan. ' +
          'Deferred revenue of $22.3M is carried within other current liabilities and is the ' +
          'largest single item there.',
      ) +
      P(
        'Management’s projections carry revenue to $212.9M in FY2032 at a decelerating growth rate ' +
          'and free cash flow positive from FY2028. We reviewed the plan for internal consistency ' +
          'against the historical record and against the retention and sales-productivity ' +
          'assumptions underlying it; we have not audited it, and it remains management’s forecast ' +
          'rather than ours.',
      ),
    methodology:
      P(
        'We considered all three traditional approaches to value together with the ' +
          'option-pricing backsolve, and applied three of the four. The weights assigned are set ' +
          'out in <strong>Exhibit B</strong>.',
      ) +
      UL([
        '<strong>Option-pricing backsolve — 50%.</strong> An arm’s-length priced round closed ' +
          'seven and a half months before the valuation date. That transaction is the strongest ' +
          'single piece of evidence available about what this company is worth, and it is weighted ' +
          'accordingly, adjusted for market movement in the interval.',
        '<strong>Market approach — 30%.</strong> Five publicly traded guideline companies with ' +
          'observable revenue multiples support a second, independent indication.',
        '<strong>Income approach — 20%.</strong> Management’s projections are internally coherent ' +
          'and were prepared for board use rather than for this valuation, but they extend seven ' +
          'years and carry the company from loss-making to substantial profitability. The weight ' +
          'reflects that the indication is real evidence and that most of its value sits in a ' +
          'terminal figure.',
        '<strong>Asset approach — 0%.</strong> Excluded, for the reason given below.',
      ]),
    income_approach:
      P(
        'The income approach measures value as the present worth of the future economic benefits ' +
          'of the business. We applied the discounted cash flow method to management’s seven-year ' +
          'plan, discounting free cash flow at 18.5% under a mid-year convention and capitalising ' +
          'a terminal value at 3.5% perpetual growth. The forecast, the discount factors and the ' +
          'bridge from enterprise to equity value are set out in <strong>Exhibit C</strong>.',
      ) +
      P(
        'The projections were prepared by management for board planning and were provided to us ' +
          'without modification. The discount rate is a venture rate of return appropriate to an ' +
          'expansion-stage enterprise (AICPA stage 5) and sits within the range reported for that ' +
          'stage in <strong>Appendix III</strong>; the build-up is set out in ' +
          '<strong>Appendix I</strong>. The terminal growth rate is set at 3.5%, above long-run ' +
          'nominal GDP growth but below the segment’s expected growth, reflecting a business ' +
          'expected still to be growing faster than the economy at the end of the explicit ' +
          'forecast period.',
      ),
    market_approach:
      P(
        'The market approach measures value by reference to prices at which comparable businesses ' +
          'have changed hands. We applied the guideline public company method, striking trailing ' +
          'twelve-month revenue multiples observed for five listed infrastructure-software ' +
          'companies against the subject’s trailing revenue of $43.8M. The guideline transaction ' +
          'method was considered and not applied: the recent private transactions we identified ' +
          'did not disclose revenue, so no multiple could be computed from them.',
      ) +
      P(
        'The guideline set and the basis for including or excluding each company is set out in ' +
          '<strong>Exhibit D-1</strong>; the multiples and the resulting indication are in ' +
          '<strong>Exhibit D</strong>. The companies retained are all subscription infrastructure ' +
          'businesses selling to the same buyer with comparable gross margins. Snowflake Inc. was ' +
          'screened out: at more than sixty times the subject’s revenue and on a consumption ' +
          'rather than a subscription model, its multiple is not evidence about this company. No ' +
          'size or growth adjustment was applied to the retained multiples; the spread across them ' +
          'is wide enough that a point adjustment would imply a precision the data does not support.',
      ),
    asset_approach: P(
      'The asset approach measures value as the value of the underlying assets net of ' +
        'liabilities. It was considered and assigned <strong>no weight</strong>. Meridian is a ' +
        'going concern whose value rests on its platform, its customer relationships and its ' +
        'engineering organisation; its recorded net assets are cash and receivables less deferred ' +
        'revenue, and a net-asset indication would value the business at less than the cash on its ' +
        'balance sheet. A cost-to-replicate indication would capture the development spend but not ' +
        'the customer base or the market position, and would understate the business for the same ' +
        'reason. No Exhibit E is included, because the approach was not applied.',
    ),
    market_movement:
      P(
        'The backsolve reads a value out of the Series B, which priced on 14 November 2025 at ' +
          '$6.40 per share. That transaction is evidence of what the company was worth on the day ' +
          'it closed; this valuation is dated 30 June 2026, seven and a half months later. ' +
          'Concluding on the round price unadjusted would assert that the market for companies of ' +
          'this profile did not move in the interval, and it did.',
      ) +
      P(
        'We measured the interval against the S&amp;P North American Technology Software Index, ' +
          'which is the benchmark whose constituents most closely match the subject’s sector and ' +
          'buyer. The index rose from 4,812.60 to 5,164.30 over the period. The subject’s beta of ' +
          '1.20 is the median levered beta of the guideline companies in Exhibit D-1, which is the ' +
          'appropriate proxy for a private company with no traded equity of its own.',
      ) +
      P(
        'Benchmark: {{market_movement_index}}. Return over the period: {{market_movement_return}}. ' +
          'Adjustment factor: {{market_movement_factor}}. Both the unadjusted and the adjusted ' +
          'indications are set out in <strong>Exhibit B</strong>.',
      ),
    reconciliation:
      P(
        'The approaches applied produce separate indications of total equity value. ' +
          '<strong>Exhibit B</strong> sets out each indication, the weight assigned to it, and the ' +
          'resulting concluded equity value.',
      ) +
      P(
        'The backsolve carries half the weight because it rests on an actual arm’s-length ' +
          'transaction in this company’s own stock, which no other approach can claim; the ' +
          'adjustment for market movement addresses its one weakness, which is its date. The ' +
          'market approach carries 30% — the guideline companies are genuinely comparable in model ' +
          'and buyer, but all are an order of magnitude larger and publicly traded. The income ' +
          'approach carries 20%: the plan is credible and independently prepared, but the majority ' +
          'of its indicated value sits in a terminal value seven years out. The asset approach ' +
          'carries none, for the reason stated above.',
      ) +
      P('Concluded total equity value: <strong>{{equity_value}}</strong>.'),
    allocation:
      P(
        'Equity value was allocated across the share classes using the option-pricing method under ' +
          'the breakpoint approach. Each class’s payoff is piecewise linear in exit equity value, ' +
          'so its value is the sum of Black-Scholes call spreads struck at the consecutive ' +
          'breakpoints created by the preference stack, the Seed participation cap and the option ' +
          'pool’s exercise price. The breakpoints, the value of each tranche and the resulting ' +
          'value of each class are set out in <strong>Exhibit F</strong>.',
      ) +
      P(
        'Expected volatility of 55% is the median two-year equity volatility of the guideline ' +
          'companies in Exhibit D-1, which is the standard proxy for a private company with no ' +
          'traded history. The expected time to a liquidity event of 4.5 years reflects the ' +
          'board’s stated planning horizon and the company’s position two rounds short of the ' +
          'scale at which its guideline companies listed. Note that the volatility applied to the ' +
          'marketability discount below is <em>not</em> this figure: common is a levered claim ' +
          'behind $90.0M of preference, and its own volatility is higher. Both are set out in ' +
          '<strong>Exhibit H-1</strong>.',
      ) +
      P(
        'Inputs applied: expected volatility {{volatility}}, expected time to liquidity ' +
          '{{time_to_exit_years}} years, risk-free rate {{risk_free_rate}}. The allocation ' +
          'indicates a {{allocated_level}} value of <strong>{{marketable_value_per_share}}</strong> ' +
          'per common share before the discounts below.',
      ),
    dloc:
      P(
        'The allocation above produces the value of a common share on a {{allocated_level}} basis. A ' +
          'holder of Meridian common stock holds a minority interest: the preferred classes ' +
          'control the board, the charter requires a Series B majority to approve a sale, a ' +
          'recapitalisation or a new senior series, and a common holder can neither compel a ' +
          'liquidity event nor direct the business. A discount for lack of control is therefore ' +
          'applied.',
      ) +
      P(
        'The discount is derived by inverting an observed control premium rather than asserted. We ' +
          'applied a 22.0% premium, drawn from acquisition premia observed for listed ' +
          'infrastructure-software targets, and removed 35% of it as attributable to buyer ' +
          'synergies rather than to control — a premium paid for cost or revenue synergies is ' +
          'evidence about that buyer, not about what control is worth to a financial holder. The ' +
          'residual premium is then inverted once, on the premium scale. The concluded discount is ' +
          '<strong>{{dloc}}</strong>, applied as set out in <strong>Exhibit H</strong>.',
      ),
    dlom:
      P(
        'No public market exists for the common stock of Meridian Data Systems, Inc. Transfer is ' +
          'further restricted by a right of first refusal in the charter and by the transfer ' +
          'provisions of the 2018 Stock Plan. A discount for lack of marketability is applied to ' +
          'reflect the cost and delay of achieving liquidity.',
      ) +
      P(
        'The discount is concluded as a weighted blend of three methods rather than on any one of ' +
          'them, because each measures a different aspect of the same illiquidity and none is ' +
          'complete on its own. The derivation is set out in <strong>Exhibit H-1</strong>:',
      ) +
      UL([
        '<strong>Finnerty average-strike put — 50%.</strong> Prices the value of giving up the ' +
          'choice of when to sell over the expected holding period, which is the closest ' +
          'description of what a common holder actually loses.',
        '<strong>Chaffee protective put — 25%.</strong> Prices a put over the holding period, ' +
          'the upper bound of the option-based family, included so the blend is not concluded on ' +
          'one model’s functional form.',
        '<strong>Restricted-stock studies — 25%.</strong> Blends the median of four published ' +
          'studies of private placements. Only observations from 1997 onward are included: the ' +
          'earlier studies measured a two-year Rule 144 holding period that no longer exists, and ' +
          'blending them with post-amendment data would measure a restriction the subject does not ' +
          'face.',
      ]) +
      P(
        'The option-based legs are struck on the volatility of the <em>common</em> class rather ' +
          'than of the enterprise, for the reason given under the allocation above. The concluded ' +
          'discount is <strong>{{dlom}}</strong>; its derivation is in <strong>Exhibit H-1</strong> ' +
          'and its application in <strong>Exhibit H</strong>.',
      ),
    qualifications:
      P(
        'This valuation was prepared by the N409 valuation practice. The analyst responsible for ' +
          'the analyses and conclusions reported here is:',
      ) +
      UL([
        '<strong>Jordan Avery Reyes, ASA, CFA</strong> — Director of Valuation, N409.',
        'Accredited Senior Appraiser (Business Valuation) of the American Society of Appraisers; ' +
          'Chartered Financial Analyst.',
        'Fourteen years of experience in the valuation of privately held equity securities, ' +
          'including more than four hundred engagements under IRC §409A and ASC 718 for ' +
          'venture-backed technology companies.',
        'The analyst performed the analyses, reached the conclusions and prepared this report. ' +
          'A second qualified reviewer independently reviewed the model and the report before ' +
          'issue.',
      ]),
  },
  signature: {
    signer_name: 'Jordan Avery Reyes',
    signer_title: 'Director of Valuation, ASA, CFA',
    signature_text: 'Jordan Avery Reyes',
  },
};

// ── Helix Therapeutics — pre-revenue biotech ─────────────────────────────────

const HELIX: SampleEngagement = {
  key: 'biotech',
  companyName: 'Helix Therapeutics, Inc.',
  serviceName: '409A Valuation — post Series B',
  summary: 'Pre-revenue clinical-stage biotech — hybrid OPM/PWERM allocation, pre-IPO study DLOM',
  profile: {
    legal_name: 'Helix Therapeutics, Inc.',
    website: 'https://www.helixtx.example',
    address_line1: '640 Memorial Drive, 3rd Floor',
    city: 'Cambridge',
    region: 'MA',
    postal_code: '02139',
    country: 'United States',
    industry: 'Biotechnology — clinical-stage oncology therapeutics',
    founded_on: '2019-06-04',
    employee_count: 62,
    revenue_range: 'pre_revenue',
    cap_table_summary:
      'Two preferred series (A, B) totalling 39,250,000 shares against $121.0M of liquidation ' +
      'preference, 24,000,000 common shares, and a 6,500,000-share option pool under the 2019 ' +
      'Equity Incentive Plan. No participation rights; both series convert one-for-one.',
  },
  params: {
    rolling_forward: false,
    inception_date: '2019-06-04',
    fiscal_year_end: '2026-12-31',
    exit_timeline: '2031-06-30',
    business_overview:
      'Helix Therapeutics is a clinical-stage biotechnology company developing HTX-401, a ' +
      'selective allosteric inhibitor in Phase 2b for relapsed solid tumours, and a preclinical ' +
      'second programme. The company has no revenue and does not expect any before a first ' +
      'approval or a licensing transaction.',
    revenue_status: 'pre_revenue',
    development_stage: 2,
    last_round_date: '2025-10-08',
    last_year_revenue_cents: 0,
    ytd_revenue_cents: 0,
    runway_months: 29,
    weight_asset: 0,
    weight_opm: 1,
    weight_income: 0,
    weight_market: 0,
    dloc_method: 'qualitative',
    dloc: 0.1,
    dlom_method: 'pre_ipo',
    dlom_pre_ipo_studies: [
      'Emory 1997-2000',
      'Emory 1980-2000 (combined)',
      'Willamette 1994-1996',
      'Willamette 1997',
    ],
    dlom_statistic: 'median',
    allocation_method: 'hybrid',
  },
  engineInputs: {
    valuation_date: '2026-06-30',
    shares_outstanding_common: 24_000_000,
    options_outstanding: 6_500_000,
    shares_outstanding_preferred: 39_250_000,
    liquidation_preference: 121_000_000,
    volatility: 0.85,
    risk_free_rate: 0.0421,
    cash: 96_500_000,
    debt: 0,
    last_round_post_money: 279_000_000,
    last_round_price_per_share: 4,
    last_round_class: 'Series B Preferred',
    market_movement: {
      index_name: 'NASDAQ Biotechnology Index',
      index_start: 4_312.8,
      index_end: 3_985.4,
      period_start: '2025-10-08',
      period_end: '2026-06-30',
      beta: 0.95,
    },
    hybrid: { opm_weight: 0.35, pwerm_weight: 0.65 },
    pwerm: {
      discount_rate: 0.3,
      scenarios: [
        {
          name: 'Phase 3 success — strategic acquisition',
          type: 'acquisition',
          probability: 0.2,
          equity_value: 1_150_000_000,
          time_to_exit_years: 4.5,
        },
        {
          name: 'Phase 2b readout positive — initial public offering',
          type: 'ipo',
          probability: 0.25,
          equity_value: 620_000_000,
          time_to_exit_years: 3,
        },
        {
          name: 'Partial efficacy — regional licence and continuation',
          type: 'continuation',
          probability: 0.35,
          equity_value: 210_000_000,
          time_to_exit_years: 4,
        },
        {
          name: 'Primary endpoint missed — orderly wind-down',
          type: 'dissolution',
          probability: 0.2,
          equity_value: 24_000_000,
          time_to_exit_years: 1.5,
        },
      ],
    },
    share_classes: [
      {
        kind: 'preferred',
        name: 'Series B Preferred',
        shares: 21_250_000,
        preference: 85_000_000,
        seniority: 1,
        participating: false,
        conversion_ratio: 1,
      },
      {
        kind: 'preferred',
        name: 'Series A Preferred',
        shares: 18_000_000,
        preference: 36_000_000,
        seniority: 2,
        participating: false,
        conversion_ratio: 1,
      },
      { kind: 'common', name: 'Common Stock', shares: 24_000_000 },
      { kind: 'option', name: 'Option pool (2019 Equity Incentive Plan)', shares: 6_500_000, strike: 0.62 },
    ],
  },
  workbook: [
    ...incomeStatement({
      revenue: [0, 0, 0, 0, 0],
      cogs: [0, 0, 0, 0, 0],
      operating_expenses: [28_400_000, 41_700_000, 52_300_000, 61_800_000, 68_400_000],
      depreciation_amortization: [1_600_000, 2_100_000, 2_600_000, 2_900_000, 3_100_000],
      interest_expense: [0, 0, 0, 0, 0],
      taxes: [0, 0, 0, 0, 0],
    }),
    ...balanceSheet({
      cash: [61_300_000, 34_800_000, 96_500_000, 51_200_000, 14_900_000],
      accounts_receivable: [0, 0, 0, 0, 0],
      other_current_assets: [3_100_000, 3_600_000, 4_200_000, 4_400_000, 4_500_000],
      ppe_net: [8_900_000, 11_400_000, 13_700_000, 15_100_000, 15_800_000],
      intangibles: [2_400_000, 2_300_000, 2_200_000, 2_100_000, 2_000_000],
      other_long_term_assets: [1_900_000, 2_200_000, 2_600_000, 2_700_000, 2_800_000],
      accounts_payable: [4_600_000, 6_100_000, 7_400_000, 8_200_000, 8_800_000],
      short_term_debt: [0, 0, 0, 0, 0],
      other_current_liabilities: [3_200_000, 4_100_000, 5_300_000, 5_900_000, 6_300_000],
      long_term_debt: [0, 0, 0, 0, 0],
      other_long_term_liabilities: [6_800_000, 8_900_000, 10_400_000, 11_200_000, 11_600_000],
    }),
    ...assumptions({
      discount_rate: 0.3,
      tax_rate: 0.21,
      terminal_growth_rate: 0,
      dlom: 0.455,
      dloc: 0.1,
      volatility: 0.85,
      risk_free_rate: 0.0421,
      time_to_exit_years: 5,
    }),
  ],
  comparables: [],
  grants: [
    {
      label: 'FY2026 scientific staff grants',
      options_granted: 1_450_000,
      grant_date: '2026-07-20',
      vesting_months: 48,
      exercise_price: 0.78,
      risk_free_rate: 0.0421,
      forfeiture_rate: 0.08,
      contractual_term_years: 10,
    },
  ],
  narrative: {
    company_overview:
      P(
        'Helix Therapeutics, Inc. was incorporated in Delaware on 4 June 2019 and operates from ' +
          'Cambridge, Massachusetts. The company is a clinical-stage biotechnology business ' +
          'developing HTX-401, a selective allosteric inhibitor for relapsed and refractory solid ' +
          'tumours, together with a preclinical second programme directed at the same pathway.',
      ) +
      P(
        'HTX-401 completed a Phase 1 dose-escalation study in 2025 and entered a Phase 2b ' +
          'efficacy trial in March 2026, with the primary endpoint readout expected in the second ' +
          'half of 2027. The company employed 62 people at the valuation date, of whom 44 are in ' +
          'research and clinical operations.',
      ) +
      P(
        'Helix has no product revenue, no collaboration revenue and no approved product. It has ' +
          'raised $121.0M of preferred equity across a Series A (2022) and a Series B that closed ' +
          'on 8 October 2025 at $4.00 per share. Cash of $96.5M at the valuation date funds the ' +
          'plan for 29 months, which management states carries the company through the Phase 2b ' +
          'readout.',
      ),
    company_analysis:
      P(
        'Revenue Ruling 59-60 §4.01 sets out the factors to be considered. For a pre-revenue ' +
          'clinical-stage company several of them carry little weight, and this section says so ' +
          'rather than omitting them.',
      ) +
      UL([
        '<strong>Nature and history of the business</strong> — seven years old, single lead ' +
          'programme, no commercial operations. The record is a research record: one completed ' +
          'Phase 1 study and one ongoing Phase 2b trial.',
        '<strong>Economic and industry outlook</strong> — addressed below. The financing ' +
          'environment for clinical-stage biotechnology is the single most important external ' +
          'factor for a company at this stage and is treated as such.',
        '<strong>Book value and financial condition</strong> — $96.5M of cash, no debt, and ' +
          'recorded net assets of approximately $105M consisting substantially of that cash. Book ' +
          'value is a floor of sorts here in a way it is not for an operating company, and it is ' +
          'the reason the wind-down scenario below is not valued at zero.',
        '<strong>Earning capacity</strong> — none, and none projected before an approval or a ' +
          'licensing transaction. Operating expenses of $52.3M in the current year are research ' +
          'spend.',
        '<strong>Dividend-paying capacity</strong> — none, now or within the forecast horizon.',
        '<strong>Goodwill and other intangible value</strong> — substantially all of the ' +
          'company’s value is the HTX-401 programme, its clinical data and its intellectual ' +
          'property. None of it is carried on the balance sheet at anything resembling its value ' +
          'to a buyer.',
        '<strong>Prior sales of stock and the size of the block</strong> — the Series B priced at ' +
          '$4.00 per share on 8 October 2025. No secondary transactions in common stock are known ' +
          'to us. The subject interest is a single common share, a minority interest.',
        '<strong>Comparable companies</strong> — no guideline set was assembled, for the reason ' +
          'given under the market approach.',
      ]) +
      P(
        'The dominant risk a buyer of common stock would price is binary clinical risk: the Phase ' +
          '2b readout either supports registration or it does not, and the two outcomes are ' +
          'separated by more than an order of magnitude of value. Secondary risks are the need to ' +
          'finance a Phase 3 programme, competitive entrants targeting the same pathway, and ' +
          'dependence on a small clinical leadership group.',
      ),
    capital_structure:
      P(
        'The capitalization of Helix Therapeutics, Inc. as of the valuation date is set out in ' +
          '<strong>Exhibit A</strong>:',
      ) +
      UL([
        '<strong>Series B Preferred</strong> — 21,250,000 shares, $85.0M liquidation preference, ' +
          'senior, non-participating, convertible one-for-one.',
        '<strong>Series A Preferred</strong> — 18,000,000 shares, $36.0M liquidation preference, ' +
          'junior to the Series B, non-participating, convertible one-for-one.',
        '<strong>Common Stock</strong> — 24,000,000 shares outstanding, the subject class.',
        '<strong>Options</strong> — 6,500,000 shares outstanding under the 2019 Equity Incentive ' +
          'Plan at a weighted-average exercise price of $0.62.',
      ]) +
      P(
        'No convertible notes, SAFEs, warrants or anti-dilution adjustments were outstanding at ' +
          'the valuation date. The aggregate liquidation preference of $121.0M is the single most ' +
          'important feature of this cap table for the subject class: in two of the four outcomes ' +
          'modelled below, the preference absorbs the whole of the proceeds and the common ' +
          'receives nothing.',
      ),
    economic_outlook: P(
      'At the valuation date the five-year Treasury yielded 4.21%, the rate applied throughout ' +
        'this analysis. For a company with no revenue and no near-term prospect of any, the ' +
        'macroeconomic variable that matters is not GDP growth but the cost and availability of ' +
        'capital for clinical-stage biotechnology. That market remained selective: crossover and ' +
        'public financing was available to programmes with de-risked human data, and scarce for ' +
        'those still awaiting a first efficacy readout. The subject is in the second category ' +
        'until its Phase 2b reports, and the probabilities and discount rate applied to the ' +
        'scenarios below reflect that.',
    ),
    industry_market: P(
      'Helix competes in targeted oncology therapeutics, a segment in which large pharmaceutical ' +
        'companies acquire or licence clinical-stage assets rather than originate them, and in ' +
        'which a positive randomised readout in a defined indication has repeatedly been followed ' +
        'by an acquisition at a substantial premium to the last private round. That structure is ' +
        'why the scenario-based allocation applied below is the appropriate one: value is not ' +
        'realised continuously as it is for an operating company, but at a small number of ' +
        'discrete, dated events with observable historical outcome frequencies. At least two ' +
        'competitor programmes address the same pathway and are, on public information, at a ' +
        'similar stage.',
    ),
    financial_analysis:
      P(
        'The historical financial statements are reproduced in <strong>Appendix II</strong>. ' +
          'There is no revenue in any period presented and none is projected within the forecast ' +
          'horizon, so the conventional ratios are not meaningful and are not reported.',
      ) +
      P(
        'Operating expenses rose from $28.4M in FY2024 to $52.3M on a trailing basis, driven by ' +
          'the Phase 2b trial start-up and the associated clinical headcount. Cash of $96.5M ' +
          'against no debt gives 29 months of runway at the current burn rate, which management ' +
          'states carries the company past the Phase 2b primary endpoint readout. Recorded net ' +
          'assets of approximately $105M are substantially cash, and the balance sheet therefore ' +
          'bears on this valuation only through the wind-down scenario, where it sets the floor.',
      ),
    methodology:
      P(
        'We considered all three traditional approaches together with the option-pricing ' +
          'backsolve, and applied one of them. The weights are set out in ' +
          '<strong>Exhibit B</strong>.',
      ) +
      UL([
        '<strong>Option-pricing backsolve — 100%.</strong> The Series B priced eight and a half ' +
          'months before the valuation date and is the only direct evidence of this company’s ' +
          'value. It carries the entire weight of the enterprise-value conclusion, adjusted for ' +
          'the movement in the sector benchmark over the interval.',
        '<strong>Income approach — 0%.</strong> There is no revenue and no cash flow to discount. ' +
          'A risk-adjusted NPV of the lead programme was considered and rejected as a primary ' +
          'indication: it would require assumed peak sales, penetration and approval probability, ' +
          'each of which is a judgement of the same order as the answer. Those judgements are ' +
          'instead made explicit as the discrete scenarios in the allocation below, where a ' +
          'reader can see and disagree with each one.',
        '<strong>Market approach — 0%.</strong> Not applied, for the reason given below.',
        '<strong>Asset approach — 0%.</strong> The recorded net assets are cash. A net-asset ' +
          'indication would value the business at its bank balance and assign nothing to the ' +
          'programme that is the reason the business exists.',
      ]),
    income_approach: P(
      'The income approach was <strong>considered and not applied</strong>. Helix has no revenue, ' +
        'no product and no cash inflows within the explicit forecast period, so there is no stream ' +
        'to discount. The forward-looking judgement that an income approach would express — what ' +
        'the programme is worth if it works, and how likely that is — is instead made explicit in ' +
        'the probability-weighted scenarios set out in <strong>Exhibit G</strong> and discussed ' +
        'under the allocation below. No Exhibit C is included, because no discounted cash flow was ' +
        'computed.',
    ),
    market_approach: P(
      'The market approach was <strong>considered and not applied</strong>. The guideline public ' +
        'company method requires a metric to strike a multiple against, and the subject has ' +
        'neither revenue nor earnings. Listed clinical-stage biotechnology companies trade on ' +
        'enterprise value per programme and per indication rather than on any financial metric, ' +
        'and the dispersion of those figures across companies at nominally the same phase is so ' +
        'wide that a multiple derived from them would carry no information about this company. The ' +
        'guideline transaction method has the same defect and the additional one that announced ' +
        'oncology transactions are structured with contingent milestone consideration whose ' +
        'disclosed headline value is not a price. No Exhibit D or D-1 is included, because no peer ' +
        'set was assembled.',
    ),
    asset_approach: P(
      'The asset approach was <strong>considered and not applied</strong>. Recorded net assets of ' +
        'approximately $105M are substantially the $96.5M cash balance; the HTX-401 programme, ' +
        'which is the whole of what a buyer would pay for, is carried at its historical research ' +
        'cost and not at anything resembling its value. A net-asset indication would therefore ' +
        'value this company at slightly more than its bank balance. The balance sheet does bear on ' +
        'the conclusion, but through the wind-down scenario in <strong>Exhibit G</strong>, where ' +
        'residual cash net of wind-down costs is what the estate distributes. No Exhibit E is ' +
        'included.',
    ),
    market_movement:
      P(
        'The backsolve reads a value out of the Series B, which priced on 8 October 2025 at $4.00 ' +
          'per share, eight and a half months before the valuation date. Over that interval the ' +
          'market for clinical-stage biotechnology fell, and concluding on the round price ' +
          'unadjusted would assert that it had not.',
      ) +
      P(
        'We measured the interval against the NASDAQ Biotechnology Index, which fell from 4,312.80 ' +
          'to 3,985.40. It is the appropriate benchmark because its constituents are the companies ' +
          'the subject competes with for capital and the ones a crossover investor would price it ' +
          'against. The beta of 0.95 reflects that a pre-readout single-asset company is driven ' +
          'more by its own clinical risk than by the sector index; a beta of 1.0 would attribute ' +
          'more of its value movement to the market than is defensible.',
      ) +
      P(
        'Benchmark: {{market_movement_index}}. Return over the period: {{market_movement_return}}. ' +
          'Adjustment factor: {{market_movement_factor}}. This is a downward adjustment, and it is ' +
          'stated as one: both the unadjusted and the adjusted indications are set out in ' +
          '<strong>Exhibit B</strong>.',
      ),
    reconciliation:
      P(
        'Only one approach was applied, so the reconciliation in <strong>Exhibit B</strong> ' +
          'carries a single weighted indication rather than a blend. The three approaches assigned ' +
          'no weight are discussed in their own sections above; each was considered and rejected ' +
          'for a stated reason rather than omitted.',
      ) + P('Concluded total equity value: <strong>{{equity_value}}</strong>.'),
    allocation:
      P(
        'Equity value was allocated to the common stock using a <strong>hybrid</strong> method, ' +
          'blending an option-pricing allocation of the continuation case with a ' +
          'probability-weighted expected return allocation across four discrete outcomes. The two ' +
          'legs are weighted 35% to the OPM and 65% to the scenarios.',
      ) +
      P(
        'The weighting reflects what is actually known about this company. A single-asset ' +
          'clinical-stage business does not realise value continuously; it realises it at a small ' +
          'number of dated events whose outcomes are separated by more than an order of magnitude, ' +
          'which is exactly the case the scenario method exists for and exactly the case a ' +
          'lognormal diffusion describes badly. The OPM leg is retained at 35% because the ' +
          'scenarios are themselves judgements, and a continuous model disciplined by the actual ' +
          'round price is a useful check on them.',
      ) +
      UL([
        '<strong>Phase 3 success — strategic acquisition (20%).</strong> Positive Phase 2b, ' +
          'registration path agreed, acquisition at 4.5 years on terms consistent with recent ' +
          'oncology transactions at that stage.',
        '<strong>Phase 2b readout positive — initial public offering (25%).</strong> A crossover ' +
          'round and listing at 3.0 years, at a valuation supported by the readout but short of ' +
          'the acquisition case.',
        '<strong>Partial efficacy — regional licence and continuation (35%).</strong> A signal ' +
          'insufficient for registration in the lead indication but sufficient to support a ' +
          'regional licensing transaction and continued development, realised at 4.0 years.',
        '<strong>Primary endpoint missed — orderly wind-down (20%).</strong> The trial fails, the ' +
          'programme is discontinued, and residual cash net of wind-down costs is distributed at ' +
          '1.5 years. In this outcome the $121.0M preference absorbs the entire distribution and ' +
          'the common receives nothing.',
      ]) +
      P(
        'Each scenario is allocated through the full preference waterfall at its own exit value ' +
          'and discounted at 30% over its own horizon; the scenarios, their probabilities and the ' +
          'resulting common value are set out in <strong>Exhibit G</strong>, and the OPM leg in ' +
          '<strong>Exhibit F</strong>. Inputs applied: expected volatility {{volatility}}, ' +
          'expected time to liquidity {{time_to_exit_years}} years, risk-free rate ' +
          '{{risk_free_rate}}. The blended allocation indicates a {{allocated_level}} value of ' +
          '<strong>{{marketable_value_per_share}}</strong> per common share before the discounts ' +
          'below.',
      ),
    dloc:
      P(
        'A holder of Helix common stock holds a minority interest. The preferred classes control ' +
          'the board, hold protective provisions over a sale, a liquidation and any new senior ' +
          'security, and a common holder cannot influence the conduct of the clinical programme, ' +
          'the timing of a transaction or the terms of one.',
      ) +
      P(
        'The concluded discount for lack of control is <strong>{{dloc}}</strong>, applied as set ' +
          'out in <strong>Exhibit H</strong>. It is stated as a matter of judgement rather than ' +
          'derived from control-premium studies, and the reason is specific to this company: the ' +
          'allocation above already prices the economics of control, because the scenarios ' +
          'enumerate the exits a controlling holder could choose between and weight them by ' +
          'probability. Layering an acquisition-premium-derived discount on top of that would ' +
          'deduct twice for the same fact. The 10% applied reflects the residual governance rights ' +
          'a common holder lacks and is deliberately at the low end.',
      ),
    dlom:
      P(
        'No public market exists for the common stock of Helix Therapeutics, Inc., and transfer is ' +
          'restricted by the charter and by the 2019 Equity Incentive Plan. A discount for lack of ' +
          'marketability is applied.',
      ) +
      P(
        'The discount is concluded from the <strong>pre-IPO studies</strong> rather than from an ' +
          'option-based model or the restricted-stock studies, and the choice is deliberate. The ' +
          'restricted-stock studies measure the discount on stock of an <em>already public</em> ' +
          'issuer that cannot be resold for a period — a liquidity that exists but is delayed. ' +
          'That is not the position of a Helix common holder, for whom no market exists at all and ' +
          'whose route to one runs through a clinical readout. The pre-IPO studies measure exactly ' +
          'that transition: the discount at which shares in companies that subsequently listed ' +
          'changed hands beforehand.',
      ) +
      P(
        'Four windows are blended, drawn from both published families so the conclusion does not ' +
          'rest on one authority’s methodology, and the median is taken. The derivation, including ' +
          'the age of each window, is set out in <strong>Exhibit H-1</strong>. The concluded ' +
          'discount is <strong>{{dlom}}</strong>, applied as set out in <strong>Exhibit H</strong>. ' +
          'It is a large discount, and it should be: the holder of this security cannot sell it, ' +
          'and cannot expect to be able to for several years.',
      ),
    qualifications:
      P(
        'This valuation was prepared by the N409 valuation practice. The analyst responsible for ' +
          'the analyses and conclusions reported here is:',
      ) +
      UL([
        '<strong>Priya Nandakumar, ABV, CVA</strong> — Principal, Life Sciences Valuation, N409.',
        'Accredited in Business Valuation (AICPA); Certified Valuation Analyst (NACVA).',
        'Eleven years of experience valuing privately held life-sciences companies, including ' +
          'clinical-stage single-asset issuers under IRC §409A and ASC 820.',
        'The analyst performed the analyses, reached the conclusions and prepared this report. ' +
          'A second qualified reviewer independently reviewed the scenario model and the report ' +
          'before issue.',
      ]),
  },
  signature: {
    signer_name: 'Priya Nandakumar',
    signer_title: 'Principal, Life Sciences Valuation, ABV, CVA',
    signature_text: 'Priya Nandakumar',
  },
};

// ── Cascade Precision Manufacturing — profitable manufacturer ────────────────

const CASCADE: SampleEngagement = {
  key: 'manufacturing',
  companyName: 'Cascade Precision Manufacturing, Inc.',
  serviceName: '409A Valuation — FY2026 annual',
  summary: 'Profitable closely held manufacturer — asset/income/market weighting, CVM allocation',
  profile: {
    legal_name: 'Cascade Precision Manufacturing, Inc.',
    website: 'https://www.cascadeprecision.example',
    address_line1: '4820 South Frontage Road',
    city: 'Portland',
    region: 'OR',
    postal_code: '97218',
    country: 'United States',
    industry: 'Precision machining — aerospace and defence components',
    founded_on: '1994-08-19',
    employee_count: 540,
    revenue_range: 'over_100m',
    cap_table_summary:
      'A single class of common stock, 4,200,000 shares, held by the founding family and by ' +
      'current and former employees. 350,000 options outstanding under the 2016 Stock Plan at a ' +
      '$12.00 weighted-average exercise price. No preferred stock has ever been issued.',
  },
  params: {
    rolling_forward: true,
    inception_date: '1994-08-19',
    fiscal_year_end: '2026-12-31',
    exit_timeline: '2031-12-31',
    business_overview:
      'Cascade Precision Manufacturing machines close-tolerance structural and engine components ' +
      'for aerospace and defence primes from three plants in Oregon and Arizona. Trailing ' +
      'twelve-month revenue was $128.4M with $21.3M of EBITDA. The company has been profitable in ' +
      'every year since 2011 and has never raised outside equity.',
    revenue_status: 'post_revenue',
    development_stage: 6,
    last_year_revenue_cents: 11_910_000_000,
    ytd_revenue_cents: 6_640_000_000,
    runway_months: 600,
    weight_asset: 0.15,
    weight_opm: 0,
    weight_income: 0.45,
    weight_market: 0.4,
    dloc_method: 'studies',
    dloc_studies: ['US public targets, 2010s', 'US public targets, 2020s'],
    dloc_statistic: 'median',
    dloc_synergy_share: 0.3,
    dlom_method: 'restricted_stock',
    dlom_studies: [
      'Management Planning Inc.',
      'FMV Opinions',
      'Johnson',
      'Columbia Financial Advisors (post-amendment)',
    ],
    dlom_statistic: 'median',
    market_method: 'ebitda',
    market_horizon: 'ltm',
    asset_method: 'nav',
    allocation_method: 'cvm',
  },
  engineInputs: {
    valuation_date: '2026-06-30',
    shares_outstanding_common: 4_200_000,
    options_outstanding: 350_000,
    shares_outstanding_preferred: 0,
    liquidation_preference: 0,
    volatility: 0.32,
    risk_free_rate: 0.0421,
    cash: 8_200_000,
    debt: 26_500_000,
    asset: { total_assets: 96_400_000, total_liabilities: 38_700_000 },
    income: {
      free_cash_flows: [9_800_000, 11_200_000, 12_400_000, 13_300_000, 14_100_000],
      revenues: [134_800_000, 141_500_000, 147_200_000, 152_100_000, 156_700_000],
      discount_rate: 0.115,
      terminal_growth: 0.025,
      mid_year_convention: true,
      terminal_method: 'gordon',
    },
    market: { metric: 21_300_000, multiples: [7.8, 6.9, 8.4, 7.1, 9.2] },
    share_classes: [
      { kind: 'common', name: 'Common Stock', shares: 4_200_000 },
      { kind: 'option', name: 'Option pool (2016 Stock Plan)', shares: 350_000, strike: 12 },
    ],
  },
  workbook: [
    ...incomeStatement({
      revenue: [109_600_000, 119_100_000, 128_400_000, 134_800_000, 141_500_000],
      cogs: [80_100_000, 86_400_000, 92_500_000, 96_800_000, 101_300_000],
      operating_expenses: [13_400_000, 14_200_000, 14_600_000, 15_300_000, 16_000_000],
      depreciation_amortization: [5_900_000, 6_300_000, 6_800_000, 7_100_000, 7_400_000],
      interest_expense: [1_700_000, 1_800_000, 1_900_000, 1_800_000, 1_700_000],
      taxes: [2_100_000, 2_600_000, 3_100_000, 3_400_000, 3_700_000],
    }),
    ...balanceSheet({
      cash: [5_400_000, 6_800_000, 8_200_000, 9_600_000, 11_400_000],
      accounts_receivable: [16_900_000, 18_400_000, 19_800_000, 20_700_000, 21_700_000],
      inventory: [21_300_000, 23_100_000, 24_600_000, 25_800_000, 27_000_000],
      other_current_assets: [2_100_000, 2_300_000, 2_500_000, 2_600_000, 2_700_000],
      ppe_net: [34_800_000, 37_200_000, 38_900_000, 40_100_000, 41_200_000],
      intangibles: [1_600_000, 1_500_000, 1_400_000, 1_300_000, 1_200_000],
      other_long_term_assets: [900_000, 1_000_000, 1_000_000, 1_100_000, 1_100_000],
      accounts_payable: [11_200_000, 12_100_000, 12_900_000, 13_500_000, 14_100_000],
      short_term_debt: [3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000],
      other_current_liabilities: [4_800_000, 5_200_000, 5_600_000, 5_900_000, 6_200_000],
      long_term_debt: [26_400_000, 24_900_000, 23_500_000, 21_900_000, 20_200_000],
      other_long_term_liabilities: [3_400_000, 3_600_000, 3_700_000, 3_800_000, 3_900_000],
    }),
    ...assumptions({
      discount_rate: 0.115,
      tax_rate: 0.24,
      terminal_growth_rate: 0.025,
      ebitda_multiple: 7.88,
      dlom: 0.215,
      dloc: 0.176,
      volatility: 0.32,
      risk_free_rate: 0.0421,
      time_to_exit_years: 5.5,
    }),
  ],
  comparables: [
    {
      ticker: 'HWM',
      name: 'Howmet Aerospace Inc.',
      included: true,
      revenue_ltm: 7_430_000_000,
      ebitda_ltm: 1_890_000_000,
      ev: 42_600_000_000,
    },
    {
      ticker: 'HEI',
      name: 'HEICO Corporation',
      included: true,
      revenue_ltm: 3_860_000_000,
      ebitda_ltm: 1_020_000_000,
      ev: 31_200_000_000,
    },
    {
      ticker: 'DCO',
      name: 'Ducommun Incorporated',
      included: true,
      revenue_ltm: 811_000_000,
      ebitda_ltm: 108_000_000,
      ev: 1_340_000_000,
    },
    {
      ticker: 'AIR',
      name: 'AAR Corp.',
      included: true,
      revenue_ltm: 2_780_000_000,
      ebitda_ltm: 306_000_000,
      ev: 3_490_000_000,
    },
    {
      ticker: 'TGI',
      name: 'Triumph Group, Inc.',
      included: true,
      revenue_ltm: 1_190_000_000,
      ebitda_ltm: 187_000_000,
      ev: 2_270_000_000,
    },
    {
      ticker: 'TDG',
      name: 'TransDigm Group Incorporated',
      included: false,
      exclude_reason:
        'Proprietary aftermarket franchise with sole-source pricing power; 50%+ EBITDA margin is not comparable to build-to-print machining',
      revenue_ltm: 8_240_000_000,
      ebitda_ltm: 4_130_000_000,
      ev: 92_700_000_000,
    },
  ],
  grants: [
    {
      label: 'FY2026 management incentive grants',
      options_granted: 85_000,
      grant_date: '2026-07-01',
      vesting_months: 60,
      exercise_price: 19.5,
      risk_free_rate: 0.0421,
      forfeiture_rate: 0.04,
      contractual_term_years: 10,
    },
  ],
  narrative: {
    company_overview:
      P(
        'Cascade Precision Manufacturing, Inc. was incorporated in Oregon on 19 August 1994 and ' +
          'operates three plants: two in the Portland metropolitan area and one in Mesa, Arizona. ' +
          'The company machines close-tolerance structural and engine components — titanium and ' +
          'nickel-alloy parts to print — for aerospace and defence prime contractors and their ' +
          'first-tier suppliers.',
      ) +
      P(
        'Trailing twelve-month revenue at the valuation date was $128.4M with EBITDA of $21.3M, a ' +
          '16.6% margin. The company employed 540 people. It has been profitable in every fiscal ' +
          'year since 2011, has never raised outside equity, and is owned by the founding family ' +
          'together with current and former employees who acquired shares through the stock plan.',
      ) +
      P(
        'The valuation is prepared to support the exercise price of options granted under the 2016 ' +
          'Stock Plan. The company is a rolling engagement: this is the annual refresh, and the ' +
          'prior conclusion was issued as of 30 June 2025.',
      ),
    company_analysis:
      P(
        'Revenue Ruling 59-60 §4.01 sets out the factors to be considered in valuing the stock of ' +
          'a closely held corporation. For a mature, profitable, closely held business every one ' +
          'of them carries real weight, and each is addressed below.',
      ) +
      UL([
        '<strong>Nature and history of the business</strong> — thirty-two years of continuous ' +
          'operation in the same trade, with two plant expansions (2007, 2019) and one acquisition ' +
          '(2015, the Mesa facility). There is no discontinuity in the record.',
        '<strong>Economic and industry outlook</strong> — addressed in the two sections that ' +
          'follow. Build rates at the two large commercial airframers are the dominant external ' +
          'driver.',
        '<strong>Book value and financial condition</strong> — total assets of $96.4M against ' +
          'liabilities of $38.7M, for recorded net assets of $57.7M. Unlike a software or ' +
          'clinical-stage business, book value is genuinely informative here: the plant, the ' +
          'machine tools and the inventory are real, productive and separately saleable, and they ' +
          'are the reason the asset approach carries weight below.',
        '<strong>Earning capacity</strong> — $21.3M of EBITDA and $11.4M of net income on a ' +
          'trailing basis, with fifteen consecutive profitable years. Earning capacity is the ' +
          'principal determinant of value for this business and the reason the income approach ' +
          'carries the largest single weight.',
        '<strong>Dividend-paying capacity</strong> — substantial and, unusually, exercised: the ' +
          'company has distributed between 20% and 30% of net income annually since 2018. The ' +
          'capacity is real rather than nominal, which distinguishes this company from every ' +
          'venture-backed issuer.',
        '<strong>Goodwill and other intangible value</strong> — the qualifications and ' +
          'certifications held (AS9100, Nadcap for three special processes), the approved-supplier ' +
          'positions on named programmes, and the machining workforce. These are captured by the ' +
          'income and market approaches and are the reason the asset approach does not carry more ' +
          'weight than it does.',
        '<strong>Prior sales of stock and the size of the block</strong> — no priced financing ' +
          'has ever occurred. Repurchases from departing employees have transacted at the prior ' +
          'year’s concluded fair market value, which is not an arm’s-length market price and is ' +
          'not treated as evidence of value here. The subject interest is a single common share, a ' +
          'minority block.',
        '<strong>Comparable companies</strong> — five listed aerostructures and component ' +
          'suppliers, named in <strong>Exhibit D-1</strong>.',
      ]) +
      P(
        'The risks a buyer of a minority common interest would price are customer concentration ' +
          '(the two largest customers were 46% of trailing revenue), exposure to commercial ' +
          'aircraft build rates, the capital intensity of the machining base, and the absence of ' +
          'any mechanism by which a minority holder could realise value.',
      ),
    capital_structure:
      P(
        'The capitalization of Cascade Precision Manufacturing, Inc. as of the valuation date is ' +
          'set out in <strong>Exhibit A</strong>. It is a single-class structure:',
      ) +
      UL([
        '<strong>Common Stock</strong> — 4,200,000 shares outstanding, the only class ever ' +
          'issued, held by the founding family (61%), a family trust (14%) and current and former ' +
          'employees (25%).',
        '<strong>Options</strong> — 350,000 shares outstanding under the 2016 Stock Plan at a ' +
          'weighted-average exercise price of $12.00, all currently in the money.',
      ]) +
      P(
        'No preferred stock, convertible note, SAFE or warrant has ever been issued, and there is ' +
          'no liquidation preference of any kind. That fact determines the allocation method used ' +
          'below: with no preference stack, no participation right and no conversion decision, ' +
          'there is no contingent claim to price, and the option-pricing method would reduce to a ' +
          'pro-rata split in any event. Third-party debt of $26.5M is bank term debt secured on ' +
          'the machine tools and is deducted in the bridge from enterprise to equity value rather ' +
          'than treated as a claim in the allocation.',
      ),
    economic_outlook: P(
      'At the valuation date US real GDP growth was in the low single digits, inflation had ' +
        'settled close to target, and the five-year Treasury — matched to the horizon applied ' +
        'here — yielded 4.21%. For a capital-intensive manufacturer two features of the ' +
        'environment matter more than the headline rate. The first is the cost of secured ' +
        'borrowing, which sets the hurdle for the machine-tool investment the plan assumes and ' +
        'feeds the weighted average cost of capital built up in <strong>Appendix I</strong>. The ' +
        'second is industrial input and labour cost inflation, which has run ahead of headline ' +
        'inflation for skilled machining labour in both of the company’s markets and is the ' +
        'principal risk to the margin assumption in the forecast.',
    ),
    industry_market: P(
      'The company supplies the aerospace structures and engine-component market, whose demand is ' +
        'set by commercial aircraft build rates, by aftermarket spares consumption and by defence ' +
        'procurement. Build rates at both large airframers had recovered towards pre-2020 levels ' +
        'by the valuation date with published plans to increase further, and the engine ' +
        'aftermarket was running ahead of that on high utilisation of the installed fleet. The ' +
        'supply base is fragmented among several hundred machining shops, of which perhaps a ' +
        'few dozen hold the Nadcap special-process approvals required for the work the subject ' +
        'does; that qualification is the principal barrier to entry and the reason margins in this ' +
        'tier have held. Competition is on capacity, on-time delivery and quality escape rate ' +
        'rather than on price at the margin, and switching a qualified part to another supplier ' +
        'requires re-qualification, which is slow and expensive for the customer.',
    ),
    financial_analysis:
      P(
        'The historical financial statements are reproduced in <strong>Appendix II</strong>. ' +
          'Revenue grew from $109.6M in FY2024 to $119.1M in FY2025 and $128.4M on a trailing ' +
          'twelve-month basis — 8.7% and 7.8% year over year, consistent with build-rate growth ' +
          'plus modest share gain rather than with any step change.',
      ) +
      P(
        'Gross margin was 28.0% and EBITDA margin 16.6%, both stable within a point over the three ' +
          'reported years. Net income was $11.4M. Working capital of $30.6M is heavily weighted to ' +
          'inventory, which is inherent to long-lead titanium stock. Total debt of $26.5M against ' +
          '$21.3M of trailing EBITDA is 1.24x, comfortably inside the covenant, and the ' +
          'amortisation schedule is funded from operating cash flow.',
      ) +
      P(
        'Management’s five-year plan projects revenue to $156.7M and free cash flow from $9.8M to ' +
          '$14.1M, holding EBITDA margin approximately flat and assuming $8M to $9M of annual ' +
          'capital expenditure. We reviewed the plan against the historical record and against the ' +
          'published build-rate assumptions it depends on. It is a continuation forecast rather ' +
          'than a growth case, which is the appropriate basis for a business of this maturity, and ' +
          'it is the forecast discounted under the income approach below.',
      ),
    methodology:
      P(
        'We considered all three traditional approaches and applied all three. The option-pricing ' +
          'backsolve was not available: no priced financing round has ever occurred, so there is ' +
          'no transaction to solve back to. The weights assigned are set out in ' +
          '<strong>Exhibit B</strong>.',
      ) +
      UL([
        '<strong>Income approach — 45%.</strong> The business is mature, profitable and ' +
          'predictable, and its value to any buyer is the cash it generates. This is the approach ' +
          'with the most direct claim on that, and it carries the largest weight.',
        '<strong>Market approach — 40%.</strong> Five listed component suppliers give observable ' +
          'EBITDA multiples for genuinely similar work. The weight is nearly equal to the income ' +
          'approach because the guideline set is close in business model, and lower only because ' +
          'every member of it is larger and publicly traded.',
        '<strong>Asset approach — 15%.</strong> Unlike an asset-light business, this company’s ' +
          'recorded net assets are real, productive and separately saleable. The approach is a ' +
          'genuine floor rather than an irrelevance, and it carries a modest weight on that basis.',
        '<strong>Option-pricing backsolve — 0%.</strong> Not available; there has never been a ' +
          'priced round.',
      ]),
    income_approach:
      P(
        'We applied the discounted cash flow method to management’s five-year plan. Free cash flow ' +
          'is discounted at 11.5% under a <strong>mid-year convention</strong> — the company’s ' +
          'cash generation is spread through the year rather than arriving on the last day of it, ' +
          'and discounting as though it arrived at each year-end would understate value by roughly ' +
          'half a year of the discount rate. A terminal value is capitalised at 2.5% perpetual ' +
          'growth, in line with long-run nominal GDP growth, which is the right assumption for a ' +
          'mature supplier whose volume is set by industry build rates. The forecast, the discount ' +
          'factors and the bridge from enterprise to equity value are set out in ' +
          '<strong>Exhibit C</strong>.',
      ) +
      P(
        'The discount rate is a weighted average cost of capital built up from the risk-free rate, ' +
          'an equity risk premium, the guideline companies’ unlevered beta relevered at the ' +
          'subject’s capital structure, a size premium and a company-specific premium for customer ' +
          'concentration. The build-up is set out in <strong>Appendix I</strong>, and it sits ' +
          'within the range reported for a stage 6 enterprise in <strong>Appendix III</strong>. ' +
          'The projections were prepared by management for lender and board reporting, not for ' +
          'this valuation, which is one reason they carry the weight they do.',
      ),
    market_approach:
      P(
        'We applied the guideline public company method, striking trailing twelve-month EBITDA ' +
          'multiples observed for five listed aerospace component suppliers against the subject’s ' +
          'trailing EBITDA of $21.3M. EBITDA rather than revenue is the right metric here: the ' +
          'subject and its guideline companies differ materially in vertical integration and ' +
          'therefore in revenue per unit of value added, while their margins on the work itself ' +
          'are comparable.',
      ) +
      P(
        'The guideline set and the basis for each inclusion is set out in ' +
          '<strong>Exhibit D-1</strong>, and the multiples and the resulting indication in ' +
          '<strong>Exhibit D</strong>. TransDigm Group was screened out: its proprietary ' +
          'aftermarket franchise and sole-source pricing power produce an EBITDA margin above 50%, ' +
          'and a multiple struck on that business is not evidence about a build-to-print machining ' +
          'operation. The guideline transaction method was also considered; the private ' +
          'transactions we identified in this tier did not disclose EBITDA, so no multiple could ' +
          'be derived, and it was not applied.',
      ),
    asset_approach:
      P(
        'The asset approach was applied on a <strong>net asset value</strong> basis and assigned ' +
          '15% weight. Total assets of $96.4M less total liabilities of $38.7M gives recorded net ' +
          'assets of $57.7M; the computation is set out in <strong>Exhibit E</strong>.',
      ) +
      P(
        'The approach is included, rather than dismissed as it would be for an asset-light ' +
          'business, because this company’s balance sheet holds real productive capacity: three ' +
          'plants, a machine-tool base carried at depreciated cost well below replacement cost, ' +
          'and $24.6M of titanium and nickel-alloy inventory that is saleable independently of the ' +
          'business. It is nevertheless the least informative of the three, because it captures ' +
          'none of the qualification, approved-supplier position or assembled workforce that a ' +
          'buyer of the going concern would be paying for. It carries 15% on that basis: a ' +
          'meaningful floor, not a competing estimate of the whole.',
      ),
    market_movement: P(
      'No market-movement adjustment applies to this valuation. The adjustment exists to move a ' +
        'value read out of a dated financing round forward to the valuation date, and this company ' +
        'has never had a priced financing round: the option-pricing backsolve carries no weight ' +
        'here, so there is no round indication to adjust. The income and market approaches are ' +
        'both struck on data as of the valuation date and need no such adjustment. Benchmark: ' +
        '{{market_movement_index}}. Return over the period: {{market_movement_return}}. Adjustment ' +
        'factor: {{market_movement_factor}}.',
    ),
    reconciliation:
      P(
        'The three approaches applied produce separate indications of total equity value. ' +
          '<strong>Exhibit B</strong> sets out each indication, the weight assigned to it, and the ' +
          'resulting concluded equity value.',
      ) +
      P(
        'The income approach carries 45% because the value of a mature, profitable, predictable ' +
          'manufacturer is the cash it generates, and the plan discounted is a continuation ' +
          'forecast prepared for other purposes rather than a case built for this report. The ' +
          'market approach carries 40%: the guideline companies do the same work for the same ' +
          'customers, and their multiples are observable, but each is several times the subject’s ' +
          'size and each is liquid, which the subject is not. The asset approach carries 15% as a ' +
          'floor supported by real productive assets. The option-pricing backsolve carries none, ' +
          'because there has never been a priced round to solve back to.',
      ) +
      P('Concluded total equity value: <strong>{{equity_value}}</strong>.'),
    allocation:
      P(
        'Equity value was allocated to the common stock using the <strong>current value ' +
          'method</strong>. The choice follows directly from the capital structure described ' +
          'above: there is one class of stock, no liquidation preference, no participation right ' +
          'and no conversion decision, so there is no contingent claim whose value depends on the ' +
          'exit outcome. An option-pricing allocation prices the boundaries between classes, and ' +
          'here there are none to price; run over this cap table it would return the same pro-rata ' +
          'split, with a volatility and a term assumption doing no work. Using it anyway would ' +
          'imply a precision and a mechanism the structure does not contain.',
      ) +
      P(
        'The 350,000 outstanding options are in the money at the concluded value and are treated ' +
          'as their own class in the waterfall, receiving value net of their $12.00 exercise ' +
          'price rather than being folded into the common count. The allocation is set out in ' +
          '<strong>Exhibit F</strong>.',
      ) +
      P(
        'Inputs applied: expected volatility {{volatility}}, expected time to liquidity ' +
          '{{time_to_exit_years}} years, risk-free rate {{risk_free_rate}}. These do not enter the ' +
          'allocation itself under the current value method; they are stated because the ' +
          'marketability discount below is struck on them. The allocation indicates a ' +
          '{{allocated_level}} value of <strong>{{marketable_value_per_share}}</strong> per common share ' +
          'before the discounts below.',
      ),
    dloc:
      P(
        'The allocation above produces the value of a common share on a {{allocated_level}} basis. The ' +
          'subject interest is a minority one: the founding family holds 61% directly and a ' +
          'further 14% through a trust, so a minority common holder cannot elect a director, ' +
          'compel a sale or a distribution, set officer compensation, or influence the capital ' +
          'expenditure programme. The absence of a preference stack does not make the interest a ' +
          'controlling one, and a discount for lack of control is applied.',
      ) +
      P(
        'The discount is derived from published control-premium observations rather than asserted. ' +
          'We blended the median premium across the two most recent decades of observed premia for ' +
          'US public targets and removed 30% of it as attributable to buyer synergies rather than ' +
          'to control — a strategic acquirer of a component supplier pays in part for consolidation ' +
          'and cross-selling, and that portion is not evidence about what control is worth to a ' +
          'financial holder. The residual premium is inverted once, on the premium scale, rather ' +
          'than each observation being inverted and the discounts averaged, which would give a ' +
          'different and wrong answer. The derivation is set out in <strong>Exhibit H</strong> and ' +
          'the concluded discount is <strong>{{dloc}}</strong>.',
      ),
    dlom:
      P(
        'No public market exists for the common stock of Cascade Precision Manufacturing, Inc. ' +
          'The shareholders’ agreement imposes a right of first refusal in favour of the company ' +
          'and then the founding family on any proposed transfer, and the 2016 Stock Plan ' +
          'restricts transfer of plan shares entirely. A discount for lack of marketability is ' +
          'applied.',
      ) +
      P(
        'The discount is concluded from the <strong>restricted-stock studies</strong>, and for ' +
          'this company that is the better-fitting family. The studies measure the discount at ' +
          'which stock of a sound, profitable, dividend-paying issuer changes hands when resale is ' +
          'restricted for a period — which is close to the position of a Cascade shareholder, who ' +
          'holds an interest in a profitable business that distributes cash and has a realistic ' +
          'prospect of a liquidity event, but cannot sell today. The pre-IPO family, by contrast, ' +
          'measures the discount on companies heading for a listing, which this company is not.',
      ) +
      P(
        'Four studies are blended and the median taken. Only observations from 1997 onward are ' +
          'included: the earlier studies measured a two-year Rule 144 holding period that no ' +
          'longer exists, and including them would measure a restriction that no longer applies to ' +
          'anyone. The company’s distribution history and the existence of an internal repurchase ' +
          'market at the concluded value both mitigate illiquidity relative to the study ' +
          'population, and the conclusion sits at the lower end of the blended range for that ' +
          'reason. The derivation is set out in <strong>Exhibit H-1</strong> and the concluded ' +
          'discount is <strong>{{dlom}}</strong>.',
      ),
    qualifications:
      P(
        'This valuation was prepared by the N409 valuation practice. The analyst responsible for ' +
          'the analyses and conclusions reported here is:',
      ) +
      UL([
        '<strong>Marcus Oyelaran, ASA, CPA/ABV</strong> — Managing Director, Industrials ' +
          'Valuation, N409.',
        'Accredited Senior Appraiser (Business Valuation) of the American Society of Appraisers; ' +
          'Certified Public Accountant, Accredited in Business Valuation.',
        'Nineteen years of experience in the valuation of closely held industrial businesses, ' +
          'including annual §409A refreshes, ESOP adequate-consideration opinions and gift and ' +
          'estate tax valuations.',
        'The analyst performed the analyses, reached the conclusions and prepared this report. ' +
          'A second qualified reviewer independently reviewed the model and the report before ' +
          'issue.',
      ]),
  },
  signature: {
    signer_name: 'Marcus Oyelaran',
    signer_title: 'Managing Director, Industrials Valuation, ASA, CPA/ABV',
    signature_text: 'Marcus Oyelaran',
  },
};

export const SAMPLE_ENGAGEMENTS: readonly SampleEngagement[] = [MERIDIAN, HELIX, CASCADE];

/**
 * The ASC 718 chapter, written from a measurement the engine actually ran.
 *
 * The skeleton ships this table with four rows an ellipsis wide — expected
 * term, exercise price, fair value per option, total cost — because those four
 * belong to the *grants* rather than to the 409A, and the 409A cannot know
 * them. That is the correct default for a template, and it is also why every
 * rendered 409A carried visible ellipses in the one chapter an auditor reads
 * most closely.
 *
 * A sample engagement can do better, because it has grants on file: the seeder
 * posts them to `POST /valuations/:id/asc718`, which measures each one with the
 * concluded FMV as the underlying, and this function writes the answer into the
 * chapter. Nothing is invented here — every figure comes from the portfolio
 * argument.
 */
export function asc718SectionHtml(
  portfolio: Asc718Portfolio,
  opts: { currency: string; grantLabels?: readonly string[] },
): string {
  const money = (v: number, digits = 2) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: opts.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);
  const int = (v: number) => new Intl.NumberFormat('en-US').format(Math.round(v));
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  const rows = portfolio.grants
    .map((g, i) => {
      const label = g.label ?? opts.grantLabels?.[i] ?? `Grant ${i + 1}`;
      return (
        '<tr>' +
        `<td>${label}</td>` +
        `<td>${int(g.optionsGranted)}</td>` +
        `<td>${money(g.assumptions.exercisePrice, 4)}</td>` +
        `<td>${g.assumptions.expectedTermYears.toFixed(2)}</td>` +
        `<td>${money(g.fairValuePerOption, 4)}</td>` +
        `<td>${int(g.expectedToVestOptions)}</td>` +
        `<td>${money(g.totalCompensationCost, 0)}</td>` +
        '</tr>'
      );
    })
    .join('');

  const first = portfolio.grants[0];
  const scheduleRows = portfolio.expenseByYear
    .map(
      (y) =>
        `<tr><td>Year ${y.year}</td><td>${money(y.expense, 0)}</td><td>${money(y.cumulative, 0)}</td></tr>`,
    )
    .join('');

  return (
    P(
      'This section presents the grant-date fair value of option awards and the related ' +
        'stock-based compensation expense recognized under ASC 718, measured using the concluded ' +
        '409A fair market value above as the grant-date price of the underlying common stock.',
    ) +
    P(
      'Grant-date fair value is estimated with the Black-Scholes-Merton option-pricing model. The ' +
        'expected term is derived by the SAB 107 simplified method from each award’s vesting and ' +
        'contractual terms; expected volatility and the risk-free rate are those applied in the ' +
        'allocation above; no dividend is expected over the term. Compensation cost is recognized ' +
        'on a straight-line basis over each award’s requisite service period, net of expected ' +
        'forfeitures, which compound over the vesting period rather than being applied once.',
    ) +
    '<table><thead><tr><th>Assumption</th><th>Input</th><th>Source</th></tr></thead><tbody>' +
    '<tr><td>Underlying fair value (409A)</td><td>{{asc718_underlying}} per share</td><td>Concluded above</td></tr>' +
    '<tr><td>Expected volatility</td><td>{{volatility}}</td><td>As applied in the allocation</td></tr>' +
    '<tr><td>Risk-free rate</td><td>{{risk_free_rate}}</td><td>As applied in the allocation</td></tr>' +
    `<tr><td>Dividend yield</td><td>${pct(first?.assumptions.dividendYield ?? 0)}</td><td>No dividends expected over the term</td></tr>` +
    '</tbody></table>' +
    P('The awards measured, and the resulting compensation cost:') +
    '<table><thead><tr>' +
    '<th>Award</th><th>Options granted</th><th>Exercise price</th><th>Expected term (years)</th>' +
    '<th>Fair value per option</th><th>Expected to vest</th><th>Compensation cost</th>' +
    '</tr></thead><tbody>' +
    rows +
    `<tr><td><strong>Total</strong></td><td></td><td></td><td></td><td></td><td></td><td><strong>${money(portfolio.totalCompensationCost, 0)}</strong></td></tr>` +
    '</tbody></table>' +
    P('Expense is recognized over the requisite service periods as follows:') +
    '<table><thead><tr><th>Service year</th><th>Expense</th><th>Cumulative</th></tr></thead><tbody>' +
    scheduleRows +
    '</tbody></table>' +
    P(
      'The measurement above is of the awards on file at the date of this report. Awards granted ' +
        'after that date are measured against the fair market value in effect on their own grant ' +
        'date, which may be this conclusion or a later one.',
    )
  );
}
