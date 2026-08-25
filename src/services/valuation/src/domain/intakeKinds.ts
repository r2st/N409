/**
 * Per-report-type intake schemas (remaining-gaps §report-types).
 *
 * Each valuation kind collects the facts ITS engine and deliverable need, not
 * the 409A questionnaire with the title swapped. The field keys are aligned
 * with the engine keyword names (engine-wrapper: qsbs.py, esop.py, smb.py,
 * emi_csop.py, intangibles.py, impairment.py) so a submitted questionnaire can
 * be assembled into an engine payload without a translation table — see
 * domain/specialty.ts, which is that assembly.
 *
 * Every kind shares the 409A company section: whoever the client is, the firm
 * needs to know who it is valuing. The 409A kind keeps its full questionnaire
 * (financials, cap table, legal); kinds with no entry here fall back to it.
 */

import {
  EARLIEST_PLAUSIBLE_DATE,
  INTAKE_CROSS_RULES,
  INTAKE_SECTIONS,
  MAX_TEXT_LENGTH,
  MAX_TEXTAREA_LENGTH,
  type IntakeCrossRule,
  type IntakeSection,
} from './intake.js';
import { IP_METHODS } from './specialty.js';
import type { ValuationKind } from './valuation.js';

/** The shared "who are we valuing" section — INTAKE_SECTIONS[0] by contract. */
const COMPANY_SECTION: IntakeSection = INTAKE_SECTIONS.find((s) => s.key === 'company')!;

const date = { notFuture: true, minDate: EARLIEST_PLAUSIBLE_DATE } as const;
const text = { maxLength: MAX_TEXT_LENGTH } as const;
const textarea = { maxLength: MAX_TEXTAREA_LENGTH } as const;
/** A discount expressed as a fraction — 0.35, never 35. */
const fraction = { min: 0, max: 0.99 } as const;
/** A rate that can plausibly sit anywhere inside 0–100%. */
const rate = { min: 0, max: 1 } as const;

const QSBS_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'qsbs_stock',
    title: 'Stock issuance',
    description: 'The stock whose §1202 qualification is being assessed.',
    fields: [
      {
        key: 'entity_type',
        label: 'Entity type of the issuer',
        type: 'select',
        required: true,
        options: ['c_corp', 's_corp', 'llc', 'partnership', 'other'],
      },
      {
        key: 'is_domestic',
        label: 'Is the issuer a domestic (U.S.) corporation?',
        type: 'boolean',
        required: true,
      },
      {
        key: 'acquisition_date',
        label: 'Date the stock was acquired',
        type: 'date',
        required: true,
        rules: date,
      },
      {
        key: 'acquired_at_original_issue',
        label: 'Acquired at original issuance (not from another holder)?',
        type: 'boolean',
        required: true,
      },
      {
        key: 'aggregate_basis',
        label: 'Aggregate adjusted basis in the stock',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
  {
    key: 'qsbs_tests',
    title: 'Section 1202 tests',
    description: 'Measurements the gross-asset and active-business tests run against.',
    fields: [
      {
        key: 'gross_assets_before_issuance',
        label: 'Aggregate gross assets immediately before the issuance',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'gross_assets_after_issuance',
        label: 'Aggregate gross assets immediately after the issuance',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'active_business_asset_pct',
        label: 'Fraction of assets used in the active business',
        type: 'number',
        required: true,
        hint: 'A fraction between 0 and 1 — the §1202(e) threshold is 0.8.',
        rules: { min: 0, max: 1 },
      },
      {
        key: 'redemptions_within_window',
        label: 'Any significant stock redemptions around the issuance?',
        type: 'boolean',
        required: false,
      },
      {
        key: 'prior_1202_exclusions',
        label: 'Gain previously excluded under §1202 for this issuer',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
];

const QSBS_CROSS_RULES: readonly IntakeCrossRule[] = [
  {
    key: 'assets_fell_across_issuance',
    field: 'gross_assets_after_issuance',
    severity: 'warning',
    left: 'gross_assets_after_issuance',
    op: 'lt',
    right: 'gross_assets_before_issuance',
    message:
      'Gross assets fell across the issuance — issuing stock usually adds cash; confirm both measurements.',
  },
];

/** Black-Scholes assumption fields shared by the 718 and IFRS 2 questionnaires. */
const MODEL_ASSUMPTION_FIELDS: IntakeSection['fields'] = [
  {
    key: 'expected_term_years',
    label: 'Expected term (years)',
    type: 'number',
    required: true,
    rules: { min: 0, max: 20 },
  },
  {
    key: 'expected_volatility',
    label: 'Expected volatility',
    type: 'number',
    required: true,
    hint: 'A fraction — 0.55 for 55%.',
    rules: { min: 0, max: 3 },
  },
  { key: 'risk_free_rate', label: 'Risk-free rate', type: 'number', required: true, rules: rate },
  { key: 'dividend_yield', label: 'Dividend yield', type: 'number', required: false, rules: rate },
];

const ASC718_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'award',
    title: 'Award terms',
    description: 'The option or share awards being measured under ASC 718.',
    fields: [
      {
        key: 'measurement_date',
        label: 'Measurement (grant) date',
        type: 'date',
        required: true,
        rules: date,
      },
      {
        key: 'company_type',
        label: 'Company type',
        type: 'select',
        required: true,
        options: ['private', 'public'],
      },
      {
        key: 'underlying_fmv',
        label: 'Fair value of the underlying share',
        type: 'number',
        required: false,
        hint: 'Leave blank for a private company using its concluded 409A value.',
        rules: { min: 0 },
      },
      {
        key: 'exercise_price',
        label: 'Exercise price per share',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'options_granted',
        label: 'Options granted',
        type: 'number',
        required: true,
        rules: { min: 0, integer: true },
      },
      {
        key: 'vesting_years',
        label: 'Requisite service (vesting) period, years',
        type: 'number',
        required: false,
        rules: { min: 0, max: 10 },
      },
    ],
  },
  {
    key: 'assumptions',
    title: 'Model assumptions',
    description: 'Black-Scholes inputs for the grant-date fair value.',
    fields: MODEL_ASSUMPTION_FIELDS,
  },
];

const ASC718_CROSS_RULES: readonly IntakeCrossRule[] = [
  {
    key: 'in_the_money_grant',
    field: 'exercise_price',
    severity: 'warning',
    left: 'exercise_price',
    op: 'lt',
    right: 'underlying_fmv',
    message:
      'The exercise price is below the fair value of the underlying share — a discounted grant has ' +
      'Section 409A consequences; confirm both figures.',
  },
];

const ASC820_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'fund',
    title: 'Fund & measurement',
    description: 'The fund whose holdings are measured at fair value under ASC 820.',
    fields: [
      { key: 'fund_name', label: 'Fund legal name', type: 'text', required: true, rules: text },
      { key: 'measurement_date', label: 'Measurement date', type: 'date', required: true, rules: date },
      {
        key: 'fair_value_level',
        label: 'Predominant fair-value hierarchy level',
        type: 'select',
        required: true,
        options: ['level_1', 'level_2', 'level_3'],
      },
      {
        key: 'position_count',
        label: 'Number of portfolio positions',
        type: 'number',
        required: false,
        rules: { min: 1, integer: true },
      },
      {
        key: 'fund_nav',
        label: 'Reported net asset value',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'calibrate_to_round',
        label: 'Calibrate marks to the most recent financing round?',
        type: 'boolean',
        required: false,
      },
      {
        key: 'valuation_policy',
        label: 'Valuation policy summary',
        type: 'textarea',
        required: false,
        rules: textarea,
      },
    ],
  },
];

/** UMV/AMV inputs shared by the EMI and CSOP questionnaires (emi_csop.py share_values). */
const SHARE_VALUE_SECTION: IntakeSection = {
  key: 'share_value',
  title: 'Share value',
  description: 'The concluded equity value the UMV and AMV per share derive from.',
  fields: [
    {
      key: 'equity_value',
      label: 'Concluded equity value',
      type: 'number',
      required: true,
      rules: { min: 0 },
    },
    {
      key: 'total_shares',
      label: 'Total shares in issue',
      type: 'number',
      required: true,
      rules: { min: 1, integer: true },
    },
    {
      key: 'minority_discount',
      label: 'Minority discount',
      type: 'number',
      required: false,
      hint: 'A fraction — applies to both UMV and AMV.',
      rules: fraction,
    },
    {
      key: 'restriction_discount',
      label: 'Restriction discount',
      type: 'number',
      required: false,
      hint: 'A fraction — what separates AMV from UMV.',
      rules: fraction,
    },
  ],
};

/**
 * What VAL231 (EMI) and VAL230 (CSOP) ask for and nothing else already
 * collects — see domain/hmrcForms.ts, which is the only reader.
 *
 * These are facts about the *company and the grant* rather than inputs to the
 * valuation, so none of them reach emi_csop.py: the engine concludes UMV and
 * AMV without knowing the registered number or the share class, and adding
 * them to its payload would only give it fields to ignore. They are collected
 * here because HMRC will not process a form with them blank, and asking the
 * client once at intake is cheaper than an analyst chasing them after the
 * numbers are agreed.
 *
 * Shared verbatim by both questionnaires. The two forms differ in what they do
 * with the answers, not in what they need.
 */
const HMRC_REQUEST_SECTION: IntakeSection = {
  key: 'hmrc_request',
  title: 'HMRC valuation request',
  description: 'Details HMRC’s valuation-agreement form asks for — VAL231 for EMI, VAL230 for CSOP.',
  fields: [
    {
      key: 'company_registration_number',
      label: 'Company registration number',
      type: 'text',
      required: true,
      hint: 'The Companies House number, e.g. 09876543.',
      rules: text,
    },
    {
      key: 'registered_office_address',
      label: 'Registered office address',
      type: 'textarea',
      required: true,
      rules: textarea,
    },
    {
      key: 'share_class',
      label: 'Class of shares under option',
      type: 'text',
      required: true,
      hint: 'As it appears in the articles, e.g. “Ordinary shares of £0.0001 each”.',
      rules: text,
    },
    {
      key: 'shares_in_class',
      label: 'Shares in issue of that class',
      type: 'number',
      required: false,
      hint: 'Leave blank if the class is the whole issued share capital.',
      rules: { min: 0, integer: true },
    },
    {
      key: 'proposed_grant_date',
      label: 'Date of the proposed grant',
      type: 'date',
      required: true,
      // Deliberately NOT `date`: this one is in the future. A valuation is
      // agreed with HMRC ahead of the grant it supports, and the shared rule's
      // notFuture guard would reject every honest answer.
      hint: 'The date options are expected to be granted — normally in the future.',
      rules: { minDate: EARLIEST_PLAUSIBLE_DATE },
    },
    {
      key: 'share_restrictions',
      label: 'Restrictions attaching to the shares',
      type: 'textarea',
      required: true,
      hint: 'Leaver provisions, transfer restrictions, drag/tag. This is what separates AMV from UMV.',
      rules: textarea,
    },
    {
      key: 'previous_hmrc_agreement',
      label: 'Previous HMRC valuation agreement (reference and date)',
      type: 'text',
      required: false,
      hint: 'If a valuation of the same class has been agreed before.',
      rules: text,
    },
    {
      key: 'recent_share_transactions',
      label: 'Recent transactions in the company’s shares',
      type: 'textarea',
      required: false,
      hint: 'Funding rounds, buybacks or secondary sales in the last three years.',
      rules: textarea,
    },
  ],
};

const CSOP_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  SHARE_VALUE_SECTION,
  HMRC_REQUEST_SECTION,
  {
    key: 'csop_grant',
    title: 'Proposed grant',
    description: 'The grant tested against the Schedule 4 CSOP limits.',
    fields: [
      {
        key: 'options_granted',
        label: 'Options to be granted',
        type: 'number',
        required: true,
        rules: { min: 0, integer: true },
      },
      {
        key: 'exercise_price',
        label: 'Exercise price per share',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'individual_prior_grants_umv',
        label: 'UMV of the individual’s existing CSOP options',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
];

const EMI_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  SHARE_VALUE_SECTION,
  HMRC_REQUEST_SECTION,
  {
    key: 'emi_grant',
    title: 'Proposed grant & qualification',
    description: 'The grant and company facts tested against the Schedule 5 EMI limits.',
    fields: [
      {
        key: 'options_granted',
        label: 'Options to be granted',
        type: 'number',
        required: true,
        rules: { min: 0, integer: true },
      },
      {
        key: 'individual_prior_grants_umv',
        label: 'UMV of the individual’s existing EMI options',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'company_unexercised_umv',
        label: 'UMV of all unexercised EMI options company-wide',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      { key: 'gross_assets', label: 'Gross assets', type: 'number', required: true, rules: { min: 0 } },
      {
        // Not the company section's optional headcount: Schedule 5 counts
        // full-time equivalents, and the two figures legitimately differ.
        key: 'fte_employee_count',
        label: 'Full-time-equivalent employees',
        type: 'number',
        required: true,
        rules: { min: 0, integer: true },
      },
      {
        key: 'is_independent',
        label: 'Is the company independent (not controlled)?',
        type: 'boolean',
        required: true,
      },
      {
        key: 'has_qualifying_trade',
        label: 'Does the company carry on a qualifying trade?',
        type: 'boolean',
        required: true,
      },
      {
        key: 'works_25_hours_or_75_pct',
        label: 'Does the employee work 25h/week or 75% of working time?',
        type: 'boolean',
        required: true,
      },
    ],
  },
];

const EMI_CROSS_RULES: readonly IntakeCrossRule[] = [
  {
    key: 'gross_assets_over_limit',
    field: 'gross_assets',
    severity: 'warning',
    left: 'gross_assets',
    op: 'gt',
    right: 30_000_000,
    message: 'Gross assets exceed the £30m Schedule 5 limit — the company is unlikely to qualify for EMI.',
  },
  {
    key: 'employees_over_limit',
    field: 'fte_employee_count',
    severity: 'warning',
    left: 'fte_employee_count',
    op: 'gte',
    right: 250,
    message: 'The company has 250 or more full-time-equivalent employees — over the Schedule 5 limit.',
  },
];

/** SMB fair-market-value opinion — the 'fmv' kind (engine smb.py). */
const SMB_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'earnings',
    title: 'Owner earnings (SDE)',
    description: 'Figures from the tax-return P&L that normalize to seller’s discretionary earnings.',
    fields: [
      { key: 'pretax_income', label: 'Pre-tax income', type: 'number', required: true },
      {
        key: 'owner_compensation',
        label: 'Owner compensation',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'interest_expense',
        label: 'Interest expense',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'depreciation_amortization',
        label: 'Depreciation & amortization',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'one_time_expenses',
        label: 'One-time expenses',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'discretionary_expenses',
        label: 'Discretionary expenses',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'one_time_income',
        label: 'One-time income',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'fair_market_replacement_wage',
        label: 'Fair-market replacement wage for additional working owners',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
  {
    key: 'smb_market',
    title: 'Market & rates',
    description: 'Multiples and build-up rate inputs for the methods the analysis will weight.',
    fields: [
      { key: 'annual_revenue', label: 'Annual revenue', type: 'number', required: false, rules: { min: 0 } },
      {
        key: 'sde_multiple',
        label: 'SDE multiple',
        type: 'number',
        required: false,
        rules: { min: 0, max: 20 },
      },
      {
        key: 'revenue_multiple',
        label: 'Revenue multiple (rule of thumb)',
        type: 'number',
        required: false,
        rules: { min: 0, max: 20 },
      },
      { key: 'risk_free_rate', label: 'Risk-free rate', type: 'number', required: false, rules: rate },
      {
        key: 'equity_risk_premium',
        label: 'Equity risk premium',
        type: 'number',
        required: false,
        rules: rate,
      },
      { key: 'size_premium', label: 'Size premium', type: 'number', required: false, rules: rate },
      {
        key: 'company_specific_premium',
        label: 'Company-specific risk premium',
        type: 'number',
        required: false,
        rules: rate,
      },
      {
        key: 'long_term_growth',
        label: 'Long-term growth rate',
        type: 'number',
        required: false,
        rules: { min: -1, max: 1 },
      },
    ],
  },
];

const IFRS2_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'award',
    title: 'Award & settlement',
    description: 'The share-based payment measured under IFRS 2.',
    fields: [
      { key: 'grant_date', label: 'Grant date', type: 'date', required: true, rules: date },
      {
        key: 'settlement',
        label: 'Settlement',
        type: 'select',
        required: true,
        options: ['equity_settled', 'cash_settled'],
      },
      {
        key: 'vesting_condition',
        label: 'Vesting condition',
        type: 'select',
        required: true,
        options: ['service', 'performance_non_market', 'market'],
      },
      {
        key: 'vesting_years',
        label: 'Vesting period, years',
        type: 'number',
        required: false,
        rules: { min: 0, max: 10 },
      },
      {
        key: 'exercise_price',
        label: 'Exercise price per share',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'share_price',
        label: 'Share price at grant',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'options_granted',
        label: 'Awards granted',
        type: 'number',
        required: false,
        rules: { min: 0, integer: true },
      },
    ],
  },
  {
    key: 'assumptions',
    title: 'Model assumptions',
    description: 'Option-pricing inputs for the grant-date fair value.',
    fields: MODEL_ASSUMPTION_FIELDS,
  },
];

const GIFTS_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'transfer',
    title: 'Transfer details',
    description: 'The interest being transferred and the occasion of the transfer.',
    fields: [
      { key: 'transfer_date', label: 'Date of transfer / death', type: 'date', required: true, rules: date },
      {
        key: 'transfer_type',
        label: 'Nature of the transfer',
        type: 'select',
        required: true,
        options: ['gift', 'estate', 'gst', 'sale_to_grantor_trust'],
      },
      {
        key: 'interest_transferred',
        label: 'Description of the interest transferred',
        type: 'textarea',
        required: true,
        rules: textarea,
      },
      {
        key: 'percent_interest',
        label: 'Percentage interest transferred',
        type: 'number',
        required: true,
        hint: 'As a percentage — 25 for a quarter interest.',
        rules: { min: 0, max: 100 },
      },
      // §2503(b). The engine has taken these three since it was written and
      // nothing ever sent them, so every gift return the deliverable supported
      // was struck at the full appraised value with the exclusion shown as
      // nil. The figure is indexed for inflation, so it is asked for rather
      // than assumed — it belongs to the year of the transfer above.
      {
        key: 'donees',
        label: 'Number of donees receiving the interest',
        type: 'number',
        required: false,
        hint: 'The annual exclusion is per donee. Leave blank for a single donee.',
        rules: { min: 1, max: 1000 },
      },
      {
        key: 'annual_exclusion',
        label: 'Annual exclusion per donee for the year of transfer',
        type: 'number',
        required: false,
        hint: 'IRC §2503(b), indexed each year — the figure in force on the transfer date. Leave blank if the exclusion has not been determined; it is not assumed to be nil.',
        rules: { min: 0 },
      },
      {
        key: 'split_gift',
        label: 'Is a spousal split-gift election being made (§2513)?',
        type: 'boolean',
        required: false,
      },
    ],
  },
  {
    key: 'discounts',
    title: 'Valuation discounts',
    description: 'Entity-level discounts the concluded value will reflect.',
    fields: [
      {
        key: 'dloc',
        label: 'Discount for lack of control',
        type: 'number',
        required: false,
        rules: fraction,
      },
      {
        key: 'dlom',
        label: 'Discount for lack of marketability',
        type: 'number',
        required: false,
        rules: fraction,
      },
      {
        key: 'prior_gifts_value',
        label: 'Value of prior gifts of this interest',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
  {
    // Rev. Rul. 59-60 §4.01 — the eight factors "to be considered" in valuing
    // closely held stock, and the checklist the deliverable is graded against.
    // The engine has always reported which of them the file addresses; nothing
    // ever told it, so every gift appraisal printed "0 of 8" with a No against
    // each factor. An unaddressed factor is a finding the analyst resolves
    // before issuing — but only once somebody has been asked.
    key: 'rev_rul_59_60',
    title: 'Revenue Ruling 59-60 factors',
    description:
      'Which of the eight §4.01 factors the appraisal addresses. Completed by the appraiser; an unaddressed factor is resolved before the report is issued, not left for the reader to notice.',
    fields: [
      {
        key: 'factor_nature_and_history',
        label: 'Nature of the business and history of the enterprise',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_economic_outlook',
        label: 'Economic outlook generally and the condition of the industry',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_book_value',
        label: 'Book value of the stock and the financial condition of the business',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_earning_capacity',
        label: 'Earning capacity of the company',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_dividend_capacity',
        label: 'Dividend-paying capacity of the company',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_goodwill',
        label: 'Goodwill or other intangible value',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_prior_sales',
        label: 'Sales of the stock and the size of the block to be valued',
        type: 'boolean',
        required: false,
      },
      {
        key: 'factor_comparable_companies',
        label: 'Market price of comparable listed corporations',
        type: 'boolean',
        required: false,
      },
    ],
  },
];

const PPA_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'transaction',
    title: 'Transaction',
    description: 'The business combination whose consideration is being allocated.',
    fields: [
      { key: 'acquirer_name', label: 'Acquirer legal name', type: 'text', required: true, rules: text },
      { key: 'closing_date', label: 'Closing date', type: 'date', required: true, rules: date },
      {
        key: 'consideration_transferred',
        label: 'Consideration transferred',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'contingent_consideration',
        label: 'Contingent consideration (earn-outs) included above',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
  {
    key: 'balance_sheet',
    title: 'Acquired balance sheet',
    description: 'Tangible positions of the acquiree at fair value; goodwill is the residual.',
    fields: [
      { key: 'net_working_capital', label: 'Net working capital', type: 'number', required: false },
      { key: 'fixed_assets', label: 'Fixed assets', type: 'number', required: false, rules: { min: 0 } },
      {
        key: 'other_tangible_assets',
        label: 'Other tangible assets',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'assumed_liabilities',
        label: 'Assumed liabilities',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'deferred_revenue_haircut',
        label: 'Deferred revenue haircut',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'intangibles_description',
        label: 'Identifiable intangibles',
        type: 'textarea',
        required: false,
        hint: 'Customer relationships, technology, trade names — the analyst sets up the detailed schedule.',
        rules: textarea,
      },
    ],
  },
];

const IMPAIRMENT_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'impairment_test',
    title: 'Impairment test',
    description: 'Which standard applies and the carrying and fair values it tests.',
    fields: [
      {
        key: 'impairment_test',
        label: 'Test',
        type: 'select',
        required: true,
        options: ['goodwill', 'indefinite_lived', 'long_lived'],
        hint: 'Goodwill (ASC 350-20), indefinite-lived intangible (ASC 350-30), long-lived asset group (ASC 360-10).',
      },
      {
        key: 'reporting_unit',
        label: 'Reporting unit / asset (group) name',
        type: 'text',
        required: false,
        rules: text,
      },
      { key: 'carrying_amount', label: 'Carrying amount', type: 'number', required: true },
      { key: 'fair_value', label: 'Fair value', type: 'number', required: true, rules: { min: 0 } },
      {
        key: 'goodwill_carrying_amount',
        label: 'Goodwill on the books (goodwill test only)',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'qualitative_only',
        label: 'Stopping at the qualitative (step zero) assessment?',
        type: 'boolean',
        required: false,
      },
      {
        key: 'undiscounted_cash_flows',
        label: 'Undiscounted annual cash flows (long-lived test only)',
        type: 'text',
        required: false,
        hint: 'Comma-separated annual amounts, e.g. 120000, 130000, 90000.',
        rules: text,
      },
    ],
  },
];

const ESOP_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'esop_value',
    title: 'Equity value & plan',
    description: 'The concluded equity value and the level of value it sits at.',
    fields: [
      {
        key: 'equity_value',
        label: 'Concluded equity value',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'shares_outstanding',
        label: 'Shares outstanding',
        type: 'number',
        required: true,
        rules: { min: 1 },
      },
      {
        key: 'value_basis',
        label: 'Level of the input equity value',
        type: 'select',
        required: true,
        options: ['control', 'minority'],
      },
      {
        key: 'control_premium',
        label: 'Control premium',
        type: 'number',
        required: false,
        hint: 'A fraction. Provide this or the DLOC, not both.',
        rules: { min: 0, max: 2 },
      },
      {
        key: 'dloc',
        label: 'Discount for lack of control',
        type: 'number',
        required: false,
        rules: fraction,
      },
      {
        key: 'dlom',
        label: 'Discount for lack of marketability',
        type: 'number',
        required: false,
        rules: fraction,
      },
      {
        key: 'esop_shares',
        label: 'Shares held by the ESOP',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
    ],
  },
  {
    key: 'repurchase',
    title: 'Repurchase obligation',
    description: 'Optional projection of the plan’s buy-back liability.',
    fields: [
      {
        key: 'esop_share_balance',
        label: 'ESOP share balance to project',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'annual_redemption_rate',
        label: 'Annual redemption rate',
        type: 'number',
        required: false,
        rules: rate,
      },
      {
        key: 'share_value_growth',
        label: 'Annual share-value growth',
        type: 'number',
        required: false,
        rules: { min: -1, max: 1 },
      },
      {
        key: 'projection_years',
        label: 'Projection horizon, years',
        type: 'number',
        required: false,
        rules: { min: 1, max: 30, integer: true },
      },
      {
        key: 'repurchase_discount_rate',
        label: 'Discount rate for the obligation',
        type: 'number',
        required: false,
        rules: rate,
      },
    ],
  },
];

const IP_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'ip_asset',
    title: 'Intellectual property asset',
    description: 'The asset being valued and the method its facts support.',
    fields: [
      { key: 'asset_name', label: 'Asset name', type: 'text', required: true, rules: text },
      {
        key: 'asset_type',
        label: 'Asset type',
        type: 'select',
        required: true,
        options: [
          'patent',
          'trademark',
          'copyright',
          'trade_secret',
          'software',
          'customer_relationships',
          'other',
        ],
      },
      {
        key: 'valuation_method',
        label: 'Valuation method',
        type: 'select',
        required: true,
        // The engine's own method keys. `cost` used to be offered here and no
        // engine method has ever been called that, so picking it 422'd.
        options: [...IP_METHODS],
      },
      {
        key: 'remaining_life_years',
        label: 'Remaining useful life, years',
        type: 'number',
        required: false,
        rules: { min: 0, max: 40 },
      },
      {
        key: 'annual_revenue',
        label: 'Annual revenue attributable to the asset',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'royalty_rate',
        label: 'Royalty rate',
        type: 'number',
        required: false,
        hint: 'A fraction of revenue (relief-from-royalty method).',
        rules: rate,
      },
      { key: 'discount_rate', label: 'Discount rate', type: 'number', required: false, rules: rate },
      { key: 'tax_rate', label: 'Tax rate', type: 'number', required: false, rules: rate },
      // Cost approach. `replacement_cost` is the one input the method has no
      // default for, so without it the approach could not be run from the
      // questionnaire at all; the obsolescence layers compound in the order
      // listed, each applied to what the previous one left.
      {
        key: 'replacement_cost',
        label: 'Replacement cost new',
        type: 'number',
        required: false,
        hint: 'Cost approach. The cost to recreate the asset today, before obsolescence.',
        rules: { min: 0 },
      },
      {
        key: 'physical_obsolescence_pct',
        label: 'Physical obsolescence',
        type: 'number',
        required: false,
        hint: 'Cost approach. A fraction of replacement cost new.',
        rules: rate,
      },
      {
        key: 'functional_obsolescence_pct',
        label: 'Functional obsolescence',
        type: 'number',
        required: false,
        hint: 'Cost approach. A fraction of what physical obsolescence left.',
        rules: rate,
      },
      {
        key: 'economic_obsolescence_pct',
        label: 'Economic obsolescence',
        type: 'number',
        required: false,
        hint: 'Cost approach. A fraction of what the earlier layers left.',
        rules: rate,
      },
      {
        key: 'developer_profit_pct',
        label: 'Developer profit',
        type: 'number',
        required: false,
        hint: 'Cost approach. Entrepreneurial incentive, added to replacement cost.',
        rules: rate,
      },
      {
        key: 'opportunity_cost_pct',
        label: 'Opportunity cost',
        type: 'number',
        required: false,
        hint: 'Cost approach. Carrying cost of the development period, added to replacement cost.',
        rules: rate,
      },
    ],
  },
];

const PORTFOLIO_SECTIONS: readonly IntakeSection[] = [
  COMPANY_SECTION,
  {
    key: 'portfolio',
    title: 'Fund & portfolio',
    description: 'The fund whose portfolio is being valued.',
    fields: [
      { key: 'fund_name', label: 'Fund legal name', type: 'text', required: true, rules: text },
      { key: 'measurement_date', label: 'Measurement date', type: 'date', required: true, rules: date },
      {
        key: 'vintage_year',
        label: 'Vintage year',
        type: 'number',
        required: false,
        rules: { min: 1980, max: 2100, integer: true },
      },
      {
        key: 'committed_capital',
        label: 'Committed capital',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'position_count',
        label: 'Number of portfolio positions',
        type: 'number',
        required: false,
        rules: { min: 0, integer: true },
      },
      {
        key: 'reporting_nav',
        label: 'Reported net asset value',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'valuation_policy',
        label: 'Valuation policy summary',
        type: 'textarea',
        required: false,
        rules: textarea,
      },
    ],
  },
];

const SECTIONS_BY_KIND: Partial<Record<ValuationKind, readonly IntakeSection[]>> = {
  '409a': INTAKE_SECTIONS,
  qsbs: QSBS_SECTIONS,
  '718': ASC718_SECTIONS,
  '820': ASC820_SECTIONS,
  csop: CSOP_SECTIONS,
  emi: EMI_SECTIONS,
  fmv: SMB_SECTIONS,
  ifrs2: IFRS2_SECTIONS,
  gifts: GIFTS_SECTIONS,
  ppa: PPA_SECTIONS,
  goodwill: IMPAIRMENT_SECTIONS,
  esop: ESOP_SECTIONS,
  ip: IP_SECTIONS,
  fund: PORTFOLIO_SECTIONS,
  // 'debt' deliberately absent: debt engagements run through the instrument
  // workflow (routes/debt.ts), and its intake is the instrument record itself.
};

const CROSS_RULES_BY_KIND: Partial<Record<ValuationKind, readonly IntakeCrossRule[]>> = {
  '409a': INTAKE_CROSS_RULES,
  qsbs: QSBS_CROSS_RULES,
  '718': ASC718_CROSS_RULES,
  emi: EMI_CROSS_RULES,
};

/** The questionnaire for a kind — kinds without their own fall back to the 409A form. */
export function intakeSectionsFor(kind: ValuationKind): readonly IntakeSection[] {
  return SECTIONS_BY_KIND[kind] ?? INTAKE_SECTIONS;
}

export function intakeCrossRulesFor(kind: ValuationKind): readonly IntakeCrossRule[] {
  // Kinds on the fallback questionnaire get its rules; kinds with their own
  // sections but no listed rules get none — a rule about a field the form
  // does not ask can never fire, but it should not be served either.
  const rules = CROSS_RULES_BY_KIND[kind];
  if (rules) return rules;
  return SECTIONS_BY_KIND[kind] ? [] : INTAKE_CROSS_RULES;
}

const KEYS_BY_KIND = new Map<ValuationKind, ReadonlySet<string>>();

/** Field keys the kind's questionnaire recognises — answers are filtered to these. */
export function intakeFieldKeysFor(kind: ValuationKind): ReadonlySet<string> {
  let keys = KEYS_BY_KIND.get(kind);
  if (!keys) {
    keys = new Set(intakeSectionsFor(kind).flatMap((s) => s.fields.map((f) => f.key)));
    KEYS_BY_KIND.set(kind, keys);
  }
  return keys;
}
