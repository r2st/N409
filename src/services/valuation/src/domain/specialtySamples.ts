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
  sensitivity: [],
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
