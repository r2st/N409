/**
 * Worked examples of the specialty engines' output, for the sample report and
 * for the exhibit tests.
 *
 * These are not hand-written objects. Each is the verbatim JSON the engine in
 * `src/services/engine-wrapper/app/engine/` returned for the inputs recorded
 * above it, captured by calling the Python directly. The inputs are part of the
 * record so any of them can be regenerated and diffed when an engine changes:
 *
 *     cd src/services/engine-wrapper
 *     .venv/bin/python -c "import sys; sys.path.insert(0,'.'); \
 *       from app.engine.gift_estate import gift_estate_valuation; \
 *       import json; print(json.dumps(gift_estate_valuation(**INPUTS), indent=1))"
 *
 * Fabricating these by hand is what the capture avoids, and the reason is not
 * tidiness. Three of the field names an exhibit needs were guessed wrong the
 * first time — the ASC 820 NAV line reads `fair_value`/`note`, not
 * `amount`/`basis`; `percent_interest` is a percentage, not a fraction; and the
 * IFRS 2 schedule's `period` is an amount while `year` is the label. Every one
 * of those renders a plausible, wrong exhibit against an invented payload and
 * is caught immediately against a real one.
 *
 * The subject is `Northwind Robotics, Inc.`, the same fictitious company the
 * 409A sample uses (domain/sampleReportPdf.ts), so a prospect comparing two
 * sample deliverables is looking at one company.
 */

/** The shape every specialty engine returns: a bare result object. */
export type SpecialtyResult = Record<string, unknown>;

/**
 * A five-position portfolio measured at 2026-03-31: two observable holdings, a
 * private preferred stake whose stated Level 2 the engine overrides, a
 * convertible note, and a fund interest carried at NAV.
 *
 * Chosen so the exhibit has something to say. The preferred position is the
 * whole point of ASC 820-10-35-37A — a Level 2 quote with a significant Level 3
 * adjustment is a Level 3 measurement — and a sample where every position sat
 * in the level its holder claimed would print a hierarchy table and no finding.
 * `app/engine/fair_value_820.py: fair_value_measurement`.
 */
export const SAMPLE_820_INPUTS = {
  measurement_date: '2026-03-31',
  positions: [
    {
      name: 'US Treasury note 4.25% 2029',
      fair_value: 4200000,
      level: 'level_1',
      inputs: [
        {
          name: 'Quoted price',
          level: 'level_1',
          value: 99.4,
        },
      ],
    },
    {
      name: 'Investment-grade corporate bonds',
      fair_value: 2650000,
      level: 'level_2',
      inputs: [
        {
          name: 'Matrix price',
          level: 'level_2',
          value: 101.2,
        },
      ],
    },
    {
      name: 'Series B preferred — Northwind Robotics',
      fair_value: 6400000,
      level: 'level_2',
      inputs: [
        {
          name: 'Discount for lack of marketability',
          level: 'level_3',
          value: 0.275,
        },
        {
          name: 'EV / revenue multiple',
          level: 'level_3',
          value: 3.5,
        },
      ],
    },
    {
      name: 'Convertible note — Halcyon Bio',
      fair_value: 1150000,
      level: 'level_3',
      inputs: [
        {
          name: 'Discount for lack of marketability',
          level: 'level_3',
          value: 0.32,
        },
        {
          name: 'Discount rate',
          level: 'level_3',
          value: 0.185,
        },
      ],
    },
    {
      name: 'Venture fund interest',
      fair_value: 3100000,
      measured_at_nav: true,
    },
  ],
  level_3_rollforward: {
    beginning_balance: 6900000,
    purchases: 1150000,
    sales: 250000,
    realized_gains_losses: 40000,
    unrealized_gains_losses: -290000,
  },
  sensitivity: [
    { input: 'Discount for lack of marketability', shift: -0.05 },
    { input: 'EV / revenue multiple', shift: 0.1 },
  ],
} as const;

export const SAMPLE_820_RESULT: SpecialtyResult = {
  measurement_date: '2026-03-31',
  positions: [
    {
      name: 'US Treasury note 4.25% 2029',
      fair_value: 4200000.0,
      level: 'level_1',
      nav_practical_expedient: false,
      basis: 'lowest significant input is level 1',
      significant_unobservable_inputs: [],
    },
    {
      name: 'Investment-grade corporate bonds',
      fair_value: 2650000.0,
      level: 'level_2',
      nav_practical_expedient: false,
      basis: 'lowest significant input is level 2',
      significant_unobservable_inputs: [],
    },
    {
      name: 'Series B preferred — Northwind Robotics',
      fair_value: 6400000.0,
      level: 'level_3',
      nav_practical_expedient: false,
      basis: 'lowest significant input is level 3; stated level 2 does not govern (ASC 820-10-35-37A)',
      significant_unobservable_inputs: [
        {
          name: 'Discount for lack of marketability',
          value: 0.275,
          fair_value: 6400000.0,
        },
        {
          name: 'EV / revenue multiple',
          value: 3.5,
          fair_value: 6400000.0,
        },
      ],
    },
    {
      name: 'Convertible note — Halcyon Bio',
      fair_value: 1150000.0,
      level: 'level_3',
      nav_practical_expedient: false,
      basis: 'lowest significant input is level 3',
      significant_unobservable_inputs: [
        {
          name: 'Discount for lack of marketability',
          value: 0.32,
          fair_value: 1150000.0,
        },
        {
          name: 'Discount rate',
          value: 0.185,
          fair_value: 1150000.0,
        },
      ],
    },
    {
      name: 'Venture fund interest',
      fair_value: 3100000.0,
      level: null,
      nav_practical_expedient: true,
      basis: 'measured at NAV per share — not categorised in the fair value hierarchy',
      significant_unobservable_inputs: [],
    },
  ],
  by_level: {
    level_1: 4200000.0,
    level_2: 2650000.0,
    level_3: 7550000.0,
  },
  categorized_fair_value: 14400000.0,
  nav_practical_expedient: {
    fair_value: 3100000.0,
    position_count: 1,
    note: 'Investments measured at net asset value per share as a practical expedient are not categorised in the fair value hierarchy (ASC 820-10-35-59); the amount is presented to reconcile the hierarchy table to the statement total.',
  },
  total_fair_value: 17500000.0,
  predominant_level: 'level_3',
  level_3_pct_of_total: 0.43142857142857144,
  reclassified_positions: [
    {
      name: 'Series B preferred — Northwind Robotics',
      level: 'level_3',
      basis: 'lowest significant input is level 3; stated level 2 does not govern (ASC 820-10-35-37A)',
    },
  ],
  unobservable_inputs: [
    {
      input: 'Discount for lack of marketability',
      low: 0.275,
      high: 0.32,
      weighted_average: 0.2818543046357616,
      weighted: true,
      position_count: 2,
      fair_value: 7550000.0,
    },
    {
      input: 'Discount rate',
      low: 0.185,
      high: 0.185,
      weighted_average: 0.185,
      weighted: true,
      position_count: 1,
      fair_value: 1150000.0,
    },
    {
      input: 'EV / revenue multiple',
      low: 3.5,
      high: 3.5,
      weighted_average: 3.5,
      weighted: true,
      position_count: 1,
      fair_value: 6400000.0,
    },
  ],
  level_3_rollforward: {
    beginning_balance: 6900000.0,
    purchases: 1150000.0,
    issuances: 0.0,
    sales: 250000.0,
    settlements: 0.0,
    transfers_into_level_3: 0.0,
    transfers_out_of_level_3: 0.0,
    realized_gains_losses: 40000.0,
    unrealized_gains_losses: -290000.0,
    computed_ending_balance: 7550000.0,
    measured_ending_balance: 7550000.0,
    difference: 0.0,
    ties: true,
  },
  sensitivity: [
    {
      input: 'Discount for lack of marketability',
      shift: -0.05,
      fair_value_effect: -377500.0,
      fair_value_after: 7172500.0,
    },
    {
      input: 'EV / revenue multiple',
      shift: 0.1,
      fair_value_effect: 755000.0,
      fair_value_after: 8305000.0,
    },
  ],
};

/**
 * A 15% interest in a $24m entity, gifted to two donees, with a control and a
 * marketability discount and $1.25m of prior taxable gifts.
 *
 * Both discounts are non-zero because the compounding is the thing a reader
 * checks: 1 − (1 − 0.12)(1 − 0.28) is 36.64%, and a reader who adds them gets
 * 40%. `app/engine/gift_estate.py: gift_estate_valuation`.
 */
export const SAMPLE_GIFTS_INPUTS = {
  entity_value: 24000000,
  percent_interest: 15,
  transfer_type: 'gift',
  dloc: 0.12,
  dlom: 0.28,
  transfer_date: '2026-03-31',
  annual_exclusion: 19000,
  donees: 2,
  prior_taxable_gifts: 1250000,
  factors_addressed: [
    'nature_and_history',
    'economic_outlook',
    'book_value',
    'earning_capacity',
    'dividend_capacity',
    'goodwill',
    'prior_sales',
  ],
} as const;

export const SAMPLE_GIFTS_RESULT: SpecialtyResult = {
  transfer_type: 'gift',
  transfer_date: '2026-03-31',
  entity_value: 24000000.0,
  percent_interest: 15.0,
  value_bridge: [
    {
      step: 'pro_rata_interest',
      value: 3600000.0,
    },
    {
      step: 'less_dloc',
      rate: 0.12,
      amount: 432000.0,
      value: 3168000.0,
    },
    {
      step: 'less_dlom',
      rate: 0.28,
      amount: 887040.0,
      value: 2280960.0,
    },
  ],
  pro_rata_value: 3600000.0,
  dloc: 0.12,
  value_after_dloc: 3168000.0,
  dlom: 0.28,
  concluded_value: 2280960.0,
  effective_discount: 0.36640000000000006,
  total_discount_amount: 1319040.0,
  annual_exclusion: {
    determined: true,
    per_donee: 19000.0,
    donees: 2,
    split_gift: false,
    available: 38000.0,
    applied: 38000.0,
    applies: true,
  },
  prior_taxable_gifts: 1250000.0,
  taxable_gift: 2242960.0,
  cumulative_taxable_gifts: 3492960.0,
  rev_rul_59_60: {
    stated: true,
    factors: [
      {
        key: 'nature_and_history',
        label: 'The nature of the business and the history of the enterprise',
        addressed: true,
      },
      {
        key: 'economic_outlook',
        label: 'The economic outlook generally and the condition of the specific industry',
        addressed: true,
      },
      {
        key: 'book_value',
        label: 'The book value of the stock and the financial condition of the business',
        addressed: true,
      },
      {
        key: 'earning_capacity',
        label: 'The earning capacity of the company',
        addressed: true,
      },
      {
        key: 'dividend_capacity',
        label: 'The dividend-paying capacity of the company',
        addressed: true,
      },
      {
        key: 'goodwill',
        label: 'Whether the enterprise has goodwill or other intangible value',
        addressed: true,
      },
      {
        key: 'prior_sales',
        label: 'Sales of the stock and the size of the block to be valued',
        addressed: true,
      },
      {
        key: 'comparable_companies',
        label: 'The market price of comparable listed corporations',
        addressed: false,
      },
    ],
    addressed_count: 7,
    total_count: 8,
    unaddressed: ['comparable_companies'],
  },
};

/**
 * 750,000 equity-settled options over four annual instalments, struck at the
 * money on the 409A sample's own concluded FMV of $1.2242.
 *
 * Instalment vesting on purpose: IFRS 2.IG11 requires graded attribution and
 * offers no straight-line election, so the schedule is front-loaded in a way an
 * ASC 718 reader will not expect. One unaddressed factor short of a clean sheet
 * is likewise deliberate. `app/engine/ifrs2.py: ifrs2_valuation`.
 */
export const SAMPLE_IFRS2_INPUTS = {
  settlement: 'equity_settled',
  vesting_condition: 'service',
  options_granted: 750000,
  vesting_years: 4,
  tranches: 4,
  grant_date: '2026-03-31',
  share_price: 1.2242,
  exercise_price: 1.2242,
  expected_term_years: 6.0,
  expected_volatility: 0.62,
  risk_free_rate: 0.0418,
  expected_forfeiture_rate: 0.08,
} as const;

export const SAMPLE_IFRS2_RESULT: SpecialtyResult = {
  grant_date: '2026-03-31',
  settlement: 'equity_settled',
  vesting_condition: 'service',
  model: 'black_scholes',
  fair_value_per_award: 0.7436505473760395,
  options_granted: 750000.0,
  grant_date_fair_value_total: 557737.9105320297,
  expected_forfeiture_rate: 0.08,
  forfeiture_determined: true,
  expected_to_vest: 690000.0,
  total_expense: 513118.8776894673,
  attribution: 'graded',
  tranches: 4,
  expense_schedule: [
    {
      year: 1,
      cumulative_pct: 0.5208333333333334,
      cumulative: 267249.4154632642,
      period: 267249.4154632642,
    },
    {
      year: 2,
      cumulative_pct: 0.7916666666666666,
      cumulative: 406219.11150416156,
      period: 138969.69604089734,
    },
    {
      year: 3,
      cumulative_pct: 0.9375,
      cumulative: 481048.94783387554,
      period: 74829.83632971399,
    },
    {
      year: 4,
      cumulative_pct: 1.0,
      cumulative: 513118.8776894673,
      period: 32069.929855591734,
    },
  ],
  remeasurement: {
    required: false,
    basis:
      'equity-settled awards are measured at grant-date fair value and are not subsequently remeasured (IFRS 2.11-13)',
  },
  true_up: {
    applies: true,
    condition_in_fair_value: false,
    basis:
      'service and non-market performance conditions are not in the fair value (IFRS 2.19); the expense is trued up to the number of awards that actually vest',
  },
  warnings: [],
};

/**
 * A trademark valued by relief from royalty over a five-year forecast with a
 * terminal period, at a 5% royalty rate and a 17% discount rate, with the tax
 * amortization benefit included.
 *
 * Captured because there was no IP sample, and the absence is what let
 * `intangibleExhibit` go on reading six field names the engine has never
 * returned — `pv_before_tab`, `pv`, `tab`, `discount_rate`, `royalty_rate`,
 * `tax_rate`. Every row it built was dropped, so every IP deliverable printed
 * a single sentence with a number in it and no schedule at all. A captured
 * payload contradicts an assumed shape immediately; three of the other kinds
 * were caught that way when they were written.
 * `app/engine/intangibles.py: value_intangible`.
 */
export const SAMPLE_IP_INPUTS = {
  method: 'relief_from_royalty',
  params: {
    revenues: [8400000, 9240000, 10164000, 10672200, 11205810],
    royalty_rate: 0.05,
    discount_rate: 0.17,
    tax_rate: 0.21,
    terminal_growth: 0.02,
    include_tab: true,
  },
} as const;

export const SAMPLE_IP_RESULT: SpecialtyResult = {
  method: 'relief_from_royalty',
  assumptions: {
    royalty_rate: 0.05,
    tax_rate: 0.21,
    discount_rate: 0.17,
    terminal_growth: 0.02,
  },
  schedule: [
    {
      year: 1,
      revenue: 8400000,
      royalty_savings: 420000,
      after_tax: 331800,
      pv: 283589.7435897436,
    },
    {
      year: 2,
      revenue: 9240000,
      royalty_savings: 462000,
      after_tax: 364980,
      pv: 266622.8358536051,
    },
    {
      year: 3,
      revenue: 10164000,
      royalty_savings: 508200,
      after_tax: 401478,
      pv: 250671.04225552618,
    },
    {
      year: 4,
      revenue: 10672200,
      royalty_savings: 533610,
      after_tax: 421551.9,
      pv: 224961.19176777996,
    },
    {
      year: 5,
      revenue: 11205810,
      royalty_savings: 560290.5,
      after_tax: 442629.495,
      pv: 201888.24902236662,
    },
  ],
  pv_explicit: 1227733.0624890216,
  pv_terminal: 1372840.093352093,
  value_before_tab: 2600573.1558411145,
  tab_multiplier: 1.0805421198054161,
  fair_value: 2810028.8305216185,
};

// ── §1202 QSBS ───────────────────────────────────────────────────────────────

/**
 * Stock issued 15 September 2025 — after P.L. 119-21 — assessed at 31 March
 * 2030, four and a half years in.
 *
 * Post-enactment on purpose: it is the only regime with a tiered schedule, and
 * the tier table only renders when there is more than one step. Every figure
 * the exhibit prints twice is different here — 75% available now against a
 * 100% ceiling, a $15,000,000 lifetime cap against $12,000,000 remaining
 * against $24,000,000 of ten-times-basis — so a row wired to the wrong field
 * prints a wrong number rather than the right one by coincidence.
 * `app/engine/qsbs.py: qsbs_eligibility`.
 */
export const SAMPLE_QSBS_INPUTS = {
  entity_type: 'c_corp',
  is_domestic: true,
  gross_assets_before_issuance: 41000000,
  gross_assets_after_issuance: 56500000,
  industry: 'technology',
  active_business_asset_pct: 0.91,
  acquired_at_original_issue: true,
  acquisition_date: '2025-09-15',
  assessment_date: '2030-03-31',
  aggregate_basis: 2400000,
  prior_1202_exclusions: 3000000,
  redemptions_within_window: false,
} as const;

export const SAMPLE_QSBS_RESULT: SpecialtyResult = {
  eligible: true,
  exclusion_available_now: true,
  regime: 'obbba',
  tests: {
    c_corporation: {
      passed: true,
      detail: 'entity_type=c_corp, domestic=True',
    },
    gross_asset_test: {
      passed: true,
      detail: 'before issuance $41,000,000, immediately after $56,500,000, limit $75,000,000',
    },
    qualified_trade_or_business: {
      passed: true,
      detail: 'industry=technology',
    },
    active_business_test: {
      passed: true,
      detail: '91% of assets in active qualified use (threshold 80%)',
    },
    original_issuance: {
      passed: true,
      detail: 'acquired at original issue',
    },
    no_disqualifying_redemptions: {
      passed: true,
      detail: 'no significant issuer redemptions in the testing window',
    },
  },
  holding_period: {
    years_held: 4.5394,
    required_years: 3,
    met: true,
    five_year_date: '2030-09-15',
    threshold_date: '2028-09-15',
    exclusion_percentage: 0.75,
    maximum_exclusion_percentage: 1,
    tiers: [
      {
        years: 3,
        exclusion_percentage: 0.5,
        date: '2028-09-15',
        met: true,
      },
      {
        years: 4,
        exclusion_percentage: 0.75,
        date: '2029-09-15',
        met: true,
      },
      {
        years: 5,
        exclusion_percentage: 1,
        date: '2030-09-15',
        met: false,
      },
    ],
  },
  exclusion_percentage: 0.75,
  maximum_exclusion_percentage: 1,
  gain_exclusion_cap: 24000000,
  cap_components: {
    lifetime_cap: 15000000,
    prior_exclusions: 3000000,
    lifetime_remaining: 12000000,
    ten_times_basis: 24000000,
  },
  failed_tests: [],
};

// ── ASC 805 purchase price allocation ────────────────────────────────────────

/**
 * A $48m acquisition allocated across three intangibles priced by two methods,
 * with goodwill as the residual.
 *
 * `purchase_price_allocation` does not take fair values — it takes each
 * intangible's method and that method's own parameters, runs the IP engine per
 * asset and splices the whole result in beside the name. So every row of
 * `intangibles` carries a full method payload: a year-by-year schedule, the
 * value before the tax amortization benefit, the TAB multiplier, and for
 * relief-from-royalty the split between explicit and terminal present value.
 * Two methods rather than one, because the row shapes differ and an exhibit
 * that handles only the first would render the second blank.
 * `app/engine/intangibles.py: purchase_price_allocation`.
 */
export const SAMPLE_PPA_INPUTS = {
  consideration_transferred: 48000000,
  net_working_capital: 3200000,
  fixed_assets: 1850000,
  other_tangible_assets: 400000,
  assumed_liabilities: 2100000,
  deferred_revenue_haircut: 650000,
  intangibles: [
    {
      name: 'Developed technology',
      method: 'relief_from_royalty',
      params: {
        revenues: [12400000, 14600000, 16900000, 18800000, 20100000],
        royalty_rate: 0.06,
        tax_rate: 0.21,
        discount_rate: 0.185,
      },
    },
    {
      name: 'Customer relationships',
      method: 'meem',
      params: {
        revenues: [12400000, 14600000, 16900000, 18800000, 20100000],
        attrition_rate: 0.15,
        ebit_margin: 0.22,
        contributory_charges_pct: 0.08,
        tax_rate: 0.21,
        discount_rate: 0.165,
      },
    },
    {
      name: 'Trade name',
      method: 'relief_from_royalty',
      params: {
        revenues: [12400000, 14600000, 16900000, 18800000, 20100000],
        royalty_rate: 0.01,
        tax_rate: 0.21,
        discount_rate: 0.17,
        terminal_growth: 0.025,
      },
    },
  ],
} as const;

export const SAMPLE_PPA_RESULT: SpecialtyResult = {
  consideration_transferred: 48000000,
  tangible_net_assets: 2700000,
  intangibles: [
    {
      name: 'Developed technology',
      method: 'relief_from_royalty',
      assumptions: {
        royalty_rate: 0.06,
        tax_rate: 0.21,
        discount_rate: 0.185,
        terminal_growth: null,
      },
      schedule: [
        {
          year: 1,
          revenue: 12400000,
          royalty_savings: 744000,
          after_tax: 587760,
          pv: 496000,
        },
        {
          year: 2,
          revenue: 14600000,
          royalty_savings: 876000,
          after_tax: 692040,
          pv: 492827.00421940925,
        },
        {
          year: 3,
          revenue: 16900000,
          royalty_savings: 1014000,
          after_tax: 801060,
          pv: 481404.33335113665,
        },
        {
          year: 4,
          revenue: 18800000,
          royalty_savings: 1128000,
          after_tax: 891120,
          pv: 451921.2776571727,
        },
        {
          year: 5,
          revenue: 20100000,
          royalty_savings: 1206000,
          after_tax: 952740,
          pv: 407739.3698226578,
        },
      ],
      pv_explicit: 2329891.9850503765,
      pv_terminal: 0,
      value_before_tab: 2329891.9850503765,
      tab_multiplier: 1.0749728529979823,
      fair_value: 2504570.6343467357,
    },
    {
      name: 'Customer relationships',
      method: 'meem',
      assumptions: {
        attrition_rate: 0.15,
        ebit_margin: 0.22,
        contributory_charges_pct: 0.08,
        tax_rate: 0.21,
        discount_rate: 0.165,
      },
      schedule: [
        {
          year: 1,
          revenue: 12400000,
          survival: 1,
          attributable_revenue: 12400000,
          ebit: 2728000,
          after_tax_earnings: 2155120,
          contributory_charge: 992000,
          excess_earnings: 1163120,
          pv: 998386.2660944206,
        },
        {
          year: 2,
          revenue: 14600000,
          survival: 0.85,
          attributable_revenue: 12410000,
          ebit: 2730200,
          after_tax_earnings: 2156858,
          contributory_charge: 992800,
          excess_earnings: 1164058,
          pv: 857675.0354583801,
        },
        {
          year: 3,
          revenue: 16900000,
          survival: 0.7224999999999999,
          attributable_revenue: 12210249.999999998,
          ebit: 2686254.9999999995,
          after_tax_earnings: 2122141.4499999997,
          contributory_charge: 976819.9999999999,
          excess_earnings: 1145321.4499999997,
          pv: 724351.9245316966,
        },
        {
          year: 4,
          revenue: 18800000,
          survival: 0.6141249999999999,
          attributable_revenue: 11545549.999999998,
          ebit: 2540020.9999999995,
          after_tax_earnings: 2006616.5899999996,
          contributory_charge: 923643.9999999999,
          excess_earnings: 1082972.5899999999,
          pv: 587913.9474320803,
        },
        {
          year: 5,
          revenue: 20100000,
          survival: 0.5220062499999999,
          attributable_revenue: 10492325.624999998,
          ebit: 2308311.6374999997,
          after_tax_earnings: 1823566.1936249998,
          contributory_charge: 839386.0499999998,
          excess_earnings: 984180.143625,
          pv: 458611.53282244055,
        },
      ],
      value_before_tab: 3626938.706339018,
      tab_multiplier: 1.0825594360400963,
      fair_value: 3926376.720486364,
    },
    {
      name: 'Trade name',
      method: 'relief_from_royalty',
      assumptions: {
        royalty_rate: 0.01,
        tax_rate: 0.21,
        discount_rate: 0.17,
        terminal_growth: 0.025,
      },
      schedule: [
        {
          year: 1,
          revenue: 12400000,
          royalty_savings: 124000,
          after_tax: 97960,
          pv: 83726.49572649573,
        },
        {
          year: 2,
          revenue: 14600000,
          royalty_savings: 146000,
          after_tax: 115340,
          pv: 84257.4329753817,
        },
        {
          year: 3,
          revenue: 16900000,
          royalty_savings: 169000,
          after_tax: 133510,
          pv: 83359.71298934263,
        },
        {
          year: 4,
          revenue: 18800000,
          royalty_savings: 188000,
          after_tax: 148520,
          pv: 79257.70516358882,
        },
        {
          year: 5,
          revenue: 20100000,
          royalty_savings: 201000,
          after_tax: 158790,
          pv: 72425.88987943878,
        },
      ],
      pv_explicit: 403027.23673424765,
      pv_terminal: 511976.1181132741,
      value_before_tab: 915003.3548475218,
      tab_multiplier: 1.0805421198054161,
      fair_value: 988699.6646760085,
    },
  ],
  total_intangible_value: 7419647.019509109,
  identifiable_net_assets: 10119647.019509109,
  goodwill: 37880352.98049089,
  bargain_purchase_gain: 0,
};

// ── ASC 350 goodwill impairment ──────────────────────────────────────────────

/**
 * A reporting unit carried at $34.5m whose fair value is $31.2m — impaired,
 * with $12.8m of goodwill to absorb the $3.3m loss.
 *
 * Impaired rather than not, because the headroom row and the foot both change
 * wording on that flag and a passing unit exercises neither branch.
 * `app/engine/impairment.py: goodwill_impairment`.
 */
export const SAMPLE_GOODWILL_INPUTS = {
  test: 'goodwill',
  reporting_unit: 'Robotics Systems',
  carrying_amount: 34500000,
  fair_value: 31200000,
  goodwill_carrying_amount: 12800000,
} as const;

export const SAMPLE_GOODWILL_RESULT: SpecialtyResult = {
  standard: 'ASC 350-20',
  reporting_unit: 'Robotics Systems',
  carrying_amount: 34500000,
  fair_value: 31200000,
  headroom: -3300000,
  impaired: true,
  impairment_loss: 3300000,
  goodwill_after: 9500000,
  qualitative_only: false,
};

// ── ESOP level of value ──────────────────────────────────────────────────────

/**
 * A 30% ESOP stake in a $62m company appraised on a control basis, with a
 * ten-year repurchase projection.
 *
 * Control basis rather than minority: it is the direction that steps *down*
 * through both discounts, so the ladder is a chain rather than a disclosure
 * gross-up, and the exhibit words all three rows differently between the two.
 * The DLOC is not supplied — it is derived from a 22% control premium, which is
 * the input an appraiser actually has — so the 18.03% on the exhibit is an
 * engine figure and not an echo.
 * `app/engine/esop.py: esop_share_value` + `repurchase_obligation`.
 */
export const SAMPLE_ESOP_INPUTS = {
  equity_value: 62000000,
  shares_outstanding: 4000000,
  value_basis: 'control',
  control_premium: 0.22,
  dlom: 0.12,
  esop_shares: 1200000,
  repurchase: {
    esop_share_balance: 1200000,
    share_value_growth: 0.05,
    annual_redemption_rate: 0.06,
    years: 10,
    discount_rate: 0.11,
  },
} as const;

export const SAMPLE_ESOP_RESULT: SpecialtyResult = {
  value_basis: 'control',
  levels: {
    control: 62000000,
    marketable_minority: 50819672.13114754,
    nonmarketable_minority: 44721311.475409836,
  },
  dloc: 0.180327868852459,
  dlom: 0.12,
  shares_outstanding: 4000000,
  fmv_per_share: 11.180327868852459,
  esop_stake_value: 13416393.44262295,
  repurchase_obligation: {
    schedule: [
      {
        year: 1,
        share_price: 11.739344262295083,
        shares_redeemed: 72000,
        repurchase_cost: 845232.7868852459,
        remaining_shares: 1128000,
        pv: 761470.9791758972,
      },
      {
        year: 2,
        share_price: 12.326311475409836,
        shares_redeemed: 67680,
        repurchase_cost: 834244.7606557377,
        remaining_shares: 1060320,
        pv: 677091.762564514,
      },
      {
        year: 3,
        share_price: 12.942627049180329,
        shares_redeemed: 63619.2,
        repurchase_cost: 823399.5787672132,
        remaining_shares: 996700.8,
        pv: 602062.6753614191,
      },
      {
        year: 4,
        share_price: 13.589758401639346,
        shares_redeemed: 59802.048,
        repurchase_cost: 812695.3842432394,
        remaining_shares: 936898.7520000001,
        pv: 535347.6221456943,
      },
      {
        year: 5,
        share_price: 14.269246321721315,
        shares_redeemed: 56213.92512000001,
        repurchase_cost: 802130.3442480776,
        remaining_shares: 880684.8268800001,
        pv: 476025.3180700904,
      },
      {
        year: 6,
        share_price: 14.98270863780738,
        shares_redeemed: 52841.0896128,
        repurchase_cost: 791702.6497728524,
        remaining_shares: 827843.7372672,
        pv: 423276.56660826947,
      },
      {
        year: 7,
        share_price: 15.73184406969775,
        shares_redeemed: 49670.624236032,
        repurchase_cost: 781410.5153258054,
        remaining_shares: 778173.113031168,
        pv: 376372.94706519094,
      },
      {
        year: 8,
        share_price: 16.518436273182637,
        shares_redeemed: 46690.38678187008,
        repurchase_cost: 771252.1786265699,
        remaining_shares: 731482.726249298,
        pv: 334666.7556336428,
      },
      {
        year: 9,
        share_price: 17.34435808684177,
        shares_redeemed: 43888.963574957874,
        repurchase_cost: 761225.9003044245,
        remaining_shares: 687593.76267434,
        pv: 297582.0610904553,
      },
      {
        year: 10,
        share_price: 18.21157599118386,
        shares_redeemed: 41255.6257604604,
        repurchase_cost: 751329.9636004671,
        remaining_shares: 646338.1369138797,
        pv: 264606.7516182697,
      },
    ],
    total_obligation: 7974624.062429633,
    pv_of_obligation: 4748503.439333443,
    ending_share_balance: 646338.1369138797,
  },
};

// ── SMB fair market value ────────────────────────────────────────────────────

/**
 * A main-street business at $4.15m of revenue, valued by all three SMB methods
 * and weighted.
 *
 * All three run, and every one of them is driven by a rate or a multiple the
 * result reports in its own sub-object: a 19.9% build-up less 3% growth for the
 * capitalization method, 3.1x for the SDE multiple, 0.85x on revenue. The
 * normalization is deliberately not the tidy case either — it carries both
 * deductions, including the replacement wage for a second working owner, which
 * is the entry that makes SDE mean what it says.
 * `app/engine/smb.py: smb_valuation`.
 */
export const SAMPLE_FMV_INPUTS = {
  sde_inputs: {
    pretax_income: 640000,
    owner_compensation: 285000,
    interest_expense: 42000,
    depreciation_amortization: 114000,
    one_time_expenses: 38000,
    discretionary_expenses: 34000,
    one_time_income: 25000,
    fair_market_replacement_wage: 96000,
  },
  annual_revenue: 4150000,
  cap_rate_inputs: {
    risk_free_rate: 0.043,
    equity_risk_premium: 0.055,
    size_premium: 0.061,
    company_specific_premium: 0.04,
    long_term_growth: 0.03,
  },
  sde_multiple: 3.1,
  revenue_multiple: 0.85,
  weights: {
    capitalization_of_earnings: 0.35,
    sde_multiple: 0.5,
    revenue_multiple: 0.15,
  },
} as const;

export const SAMPLE_FMV_RESULT: SpecialtyResult = {
  sde_normalization: {
    pretax_income: 640000,
    addbacks: {
      owner_compensation: 285000,
      interest_expense: 42000,
      depreciation_amortization: 114000,
      one_time_expenses: 38000,
      discretionary_expenses: 34000,
    },
    deductions: {
      one_time_income: 25000,
      fair_market_replacement_wage: 96000,
    },
    sde: 1032000,
  },
  methods: {
    capitalization_of_earnings: {
      discount_rate: 0.199,
      long_term_growth: 0.03,
      cap_rate: 0.169,
      benefit_stream: 1032000,
      equity_value: 6106508.875739644,
    },
    sde_multiple: {
      sde: 1032000,
      multiple: 3.1,
      equity_value: 3199200,
    },
    revenue_multiple: {
      revenue: 4150000,
      multiple: 0.85,
      equity_value: 3527500,
    },
  },
  weights: {
    capitalization_of_earnings: 0.35,
    sde_multiple: 0.5,
    revenue_multiple: 0.15,
  },
  equity_value: 4266003.106508875,
};

// ── EMI / CSOP ───────────────────────────────────────────────────────────────

/**
 * A 90,000-share EMI grant over a £26m company, qualifying on all seven checks.
 *
 * The individual limit is the one worth having real numbers for: £60,000 of
 * prior grants sit under £175,500 of new grant, so the £235,500 the check tests
 * is neither of the two figures beside it. An exhibit that printed the grant
 * and called it the tested total would look right.
 * `app/engine/emi_csop.py: emi_csop_valuation`.
 */
export const SAMPLE_EMI_INPUTS = {
  scheme: 'emi',
  equity_value: 26000000,
  total_shares: 10000000,
  restriction_discount: 0.1,
  minority_discount: 0.25,
  gross_assets: 18400000,
  employee_count: 84,
  options_granted: 90000,
  individual_prior_grants_umv: 60000,
  company_unexercised_umv: 1400000,
} as const;

export const SAMPLE_EMI_RESULT: SpecialtyResult = {
  pro_rata_per_share: 2.6,
  minority_discount: 0.25,
  restriction_discount: 0.1,
  umv_per_share: 1.9500000000000002,
  amv_per_share: 1.7550000000000001,
  qualification: {
    scheme: 'emi',
    grant_umv: 175500.00000000003,
    individual_total_umv: 235500.00000000003,
    company_total_umv: 1575500,
    checks: {
      gross_assets: {
        passed: true,
        detail: '£18,400,000 against the £30,000,000 limit',
      },
      employee_count: {
        passed: true,
        detail: '84 FTEs against the fewer-than-250 limit',
      },
      company_independence: {
        passed: true,
        detail: 'independent',
      },
      qualifying_trade: {
        passed: true,
        detail: 'qualifying trade',
      },
      working_time: {
        passed: true,
        detail: 'meets the 25-hours/75% working-time requirement',
      },
      individual_limit: {
        passed: true,
        detail: '£235,500 UMV in the 3-year window against the £250,000 limit',
      },
      company_limit: {
        passed: true,
        detail: '£1,575,500 unexercised UMV against the £3,000,000 limit',
      },
    },
    qualifies: true,
    failed_checks: [],
  },
};

/**
 * The same shares under CSOP, where the grant fails the £60,000 individual
 * limit.
 *
 * A failing sample on purpose, and the only one here: `qualifies: false` with a
 * populated `failed_checks` is the branch the qualification paragraph and the
 * Pass/Fail column exist for, and every other captured payload passes
 * everything. The exercise price is set above UMV so exactly one check fails
 * and the table is not a column of Fails.
 * `app/engine/emi_csop.py: emi_csop_valuation`.
 */
export const SAMPLE_CSOP_INPUTS = {
  scheme: 'csop',
  equity_value: 26000000,
  total_shares: 10000000,
  restriction_discount: 0.1,
  minority_discount: 0.25,
  options_granted: 90000,
  exercise_price: 2.1,
  individual_prior_grants_umv: 0,
} as const;

export const SAMPLE_CSOP_RESULT: SpecialtyResult = {
  pro_rata_per_share: 2.6,
  minority_discount: 0.25,
  restriction_discount: 0.1,
  umv_per_share: 1.9500000000000002,
  amv_per_share: 1.7550000000000001,
  qualification: {
    scheme: 'csop',
    grant_umv: 175500.00000000003,
    individual_total_umv: 175500.00000000003,
    checks: {
      individual_limit: {
        passed: false,
        detail: '£175,500 UMV against the £60,000 limit',
      },
      exercise_price_not_below_umv: {
        passed: true,
        detail: 'exercise price £2.1000 vs UMV £1.9500 at grant',
      },
    },
    qualifies: false,
    failed_checks: ['individual_limit'],
  },
};

// ── Second payloads, for shapes one run cannot produce ───────────────────────

/**
 * The cash-settled half of IFRS 2, on a non-market performance condition.
 *
 * A second payload for one kind, and the reason is the block R134 found
 * dropped: `remeasurement` only has contents when the award is a liability, so
 * the equity-settled sample above carries `{required: false, basis: ...}` and
 * nothing else. Its four figures — the fair value now, the liability now, the
 * change through profit or loss — were unswept by any census while being the
 * exact fields that finding was about. The condition is non-market, so
 * `true_up` applies as well, which the equity-settled sample does not exercise.
 * `app/engine/ifrs2.py: ifrs2_valuation`.
 */
export const SAMPLE_IFRS2_CASH_INPUTS = {
  settlement: 'cash_settled',
  vesting_condition: 'performance_non_market',
  options_granted: 400000,
  vesting_years: 3,
  tranches: 3,
  grant_date: '2026-03-31',
  share_price: 1.2242,
  exercise_price: 1.0,
  expected_term_years: 5.0,
  expected_volatility: 0.62,
  risk_free_rate: 0.0418,
  expected_forfeiture_rate: 0.06,
  current_fair_value_per_award: 0.9125,
} as const;

export const SAMPLE_IFRS2_CASH_RESULT: SpecialtyResult = {
  grant_date: '2026-03-31',
  settlement: 'cash_settled',
  vesting_condition: 'performance_non_market',
  model: 'black_scholes',
  fair_value_per_award: 0.7463202437730645,
  options_granted: 400000,
  grant_date_fair_value_total: 298528.0975092258,
  expected_forfeiture_rate: 0.06,
  forfeiture_determined: true,
  expected_to_vest: 376000,
  total_expense: 280616.41165867227,
  attribution: 'graded',
  tranches: 3,
  expense_schedule: [
    {
      year: 1,
      cumulative_pct: 0.611111111111111,
      cumulative: 171487.80712474414,
      period: 171487.80712474414,
    },
    {
      year: 2,
      cumulative_pct: 0.8888888888888888,
      cumulative: 249436.81036326423,
      period: 77949.00323852009,
    },
    {
      year: 3,
      cumulative_pct: 1,
      cumulative: 280616.41165867227,
      period: 31179.601295408036,
    },
  ],
  remeasurement: {
    required: true,
    current_fair_value_per_award: 0.9125,
    current_total: 343100,
    change_in_liability: 62483.58834132773,
    basis:
      'cash-settled awards are liabilities remeasured to fair value at each reporting date, with the change recognised in profit or loss (IFRS 2.30-33)',
  },
  true_up: {
    applies: true,
    condition_in_fair_value: false,
    basis:
      'service and non-market performance conditions are not in the fair value (IFRS 2.19); the expense is trued up to the number of awards that actually vest',
  },
  warnings: [],
};

/**
 * The cost approach, with all three obsolescence layers taken.
 *
 * The other IP sample is an income method, so `obsolescence` — named in R135 as
 * a nested block nothing sweeps — had no payload at all. All three layers are
 * non-zero because they compound: 10%, then 18% of what is left, then 7% of
 * what is left after that, which is 31.4% of cost new and not the 35% a reader
 * gets by adding them. `app/engine/intangibles.py: cost_approach`.
 */
export const SAMPLE_IP_COST_INPUTS = {
  method: 'cost_approach',
  params: {
    replacement_cost: 4600000,
    developer_profit_pct: 0.12,
    opportunity_cost_pct: 0.05,
    physical_obsolescence_pct: 0.1,
    functional_obsolescence_pct: 0.18,
    economic_obsolescence_pct: 0.07,
  },
} as const;

export const SAMPLE_IP_COST_RESULT: SpecialtyResult = {
  method: 'cost_approach',
  assumptions: {
    developer_profit_pct: 0.12,
    opportunity_cost_pct: 0.05,
    obsolescence_pct: {
      physical: 0.1,
      functional: 0.18,
      economic: 0.07,
    },
  },
  replacement_cost_new: 5382000.000000001,
  obsolescence: {
    physical: 538200.0000000001,
    functional: 871884.0000000001,
    economic: 278034.1200000001,
  },
  fair_value: 3693881.880000001,
};

/**
 * ASC 360-10 on an asset group that fails the recoverability screen.
 *
 * The goodwill sample cannot produce `recoverable`,
 * `undiscounted_cash_flows_total` or `carrying_after` — they belong to the
 * long-lived test, which is a different function behind the same endpoint and
 * the same exhibit. Failing the screen on purpose: a group that passes it
 * reports `impairment_loss: 0` however far fair value is below carrying, and
 * the exhibit's screen row would read the same either way if it were never
 * shown the failing case. `app/engine/impairment.py: long_lived_impairment`.
 */
export const SAMPLE_IMPAIRMENT_LONG_LIVED_INPUTS = {
  test: 'long_lived',
  asset_group: 'Fabrication line — Chandler',
  carrying_amount: 18200000,
  undiscounted_cash_flows: [3100000, 3050000, 2900000, 2700000, 2450000, 2100000],
  fair_value: 14400000,
} as const;

export const SAMPLE_IMPAIRMENT_LONG_LIVED_RESULT: SpecialtyResult = {
  standard: 'ASC 360-10',
  asset_group: 'Fabrication line — Chandler',
  carrying_amount: 18200000,
  undiscounted_cash_flows_total: 16300000,
  recoverable: false,
  fair_value: 14400000,
  impaired: true,
  impairment_loss: 3800000,
  carrying_after: 14400000,
};
