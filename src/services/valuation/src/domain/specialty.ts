/**
 * Specialty report-type orchestration (remaining-gaps §report-types): the
 * assembly step between a kind's intake questionnaire (domain/intakeKinds.ts)
 * and its engine endpoint (engine-wrapper main.py). Pure — the route owns the
 * HTTP call and persistence; this module owns which endpoint a kind uses and
 * how a questionnaire's answers become that endpoint's request body.
 *
 * Deliberately lenient about *values*: the engine is the validator of record
 * (every endpoint 422s with a field-named message), and re-stating its rules
 * here is how two rule sets drift. What IS enforced here is *shape* — the
 * facts that decide which request to build at all (which impairment test,
 * which IP method, whether a PPA has an intangible schedule).
 */

import { todayLocal } from './calendarDate.js';
import type { ValuationKind } from './valuation.js';

/** Kinds whose calculation runs through a dedicated specialty engine endpoint. */
export const SPECIALTY_KINDS = [
  'qsbs',
  'ppa',
  'goodwill',
  'esop',
  'fmv',
  'emi',
  'csop',
  'ip',
  // These three had questionnaires but no dispatch, so an ASC 820 measurement,
  // a gift & estate appraisal and an IFRS 2 award all ran the 409A allocation
  // and produced a per-share FMV nobody asked for. Each now has an endpoint
  // that computes the thing its deliverable is actually about — the fair-value
  // hierarchy, the discount chain, the expense attribution.
  '820',
  'gifts',
  'ifrs2',
] as const;
export type SpecialtyKind = (typeof SPECIALTY_KINDS)[number];

export function isSpecialtyKind(kind: ValuationKind): kind is SpecialtyKind {
  return (SPECIALTY_KINDS as readonly string[]).includes(kind);
}

/** An input problem the analyst has to fix — the route maps it to a 422. */
export class SpecialtyInputError extends Error {}

/**
 * What the workspace tab needs to know about each kind, served rather than
 * duplicated in TypeScript on the client.
 *
 * The kind → endpoint map already exists exactly once, in
 * `specialtyEngineRequest` below. A second copy in the frontend would be a
 * second answer to "which engine runs an ASC 820 measurement", and the two
 * would disagree the first time an endpoint moved. So the tab renders from
 * this, and this is derived from the same switch.
 *
 * `runInputs` is the part a form cannot get from the questionnaire: a PPA's
 * intangible schedule and an ASC 820 position schedule are analyst work
 * product, not answers to a client form, and both assemblers refuse without
 * them. Naming them here is what lets the tab say so before the run rather
 * than surface a 422 afterwards.
 */
export interface SpecialtyEngineDef {
  kind: SpecialtyKind;
  label: string;
  /** The engine endpoint the run posts to. */
  path: string;
  /** What the deliverable concludes, in the words the tab shows. */
  produces: string;
  /**
   * Run-input keys the assembler requires and the questionnaire cannot supply.
   * Empty for every kind whose questionnaire is sufficient on its own.
   */
  runInputs: ReadonlyArray<{ key: string; label: string; hint: string }>;
  /** Whether an HMRC agreement pack applies (VAL231 EMI, VAL230 CSOP). */
  hmrcForm: 'VAL231' | 'VAL230' | null;
}

export const SPECIALTY_ENGINES: Record<SpecialtyKind, SpecialtyEngineDef> = {
  qsbs: {
    kind: 'qsbs',
    label: 'QSBS qualification (IRC §1202)',
    path: '/engine/v1/qsbs',
    produces: 'The four statutory tests and the gain exclusion available.',
    runInputs: [],
    hmrcForm: null,
  },
  ppa: {
    kind: 'ppa',
    label: 'Purchase price allocation',
    path: '/engine/v1/ppa',
    produces: 'The allocation of consideration across tangible and intangible assets, and goodwill.',
    runInputs: [
      {
        key: 'intangibles',
        label: 'Intangible asset schedule',
        hint: 'A list of { name, method, params } rows. The questionnaire collects only the consideration and the tangible positions.',
      },
    ],
    hmrcForm: null,
  },
  goodwill: {
    kind: 'goodwill',
    label: 'Impairment test',
    path: '/engine/v1/impairment',
    produces: 'Whether the asset or reporting unit is impaired, and by how much.',
    runInputs: [],
    hmrcForm: null,
  },
  esop: {
    kind: 'esop',
    label: 'ESOP valuation',
    path: '/engine/v1/esop',
    produces:
      'Fair market value per share on the plan’s basis, with the repurchase projection where the plan facts allow one.',
    runInputs: [],
    hmrcForm: null,
  },
  fmv: {
    kind: 'fmv',
    label: 'SMB fair market value',
    path: '/engine/v1/smb',
    produces: 'Seller’s discretionary earnings, the multiples applied, and the concluded equity value.',
    runInputs: [],
    hmrcForm: null,
  },
  emi: {
    kind: 'emi',
    label: 'EMI option valuation',
    path: '/engine/v1/emi-csop',
    produces: 'Actual and unrestricted market value per share, and the scheme’s qualifying conditions.',
    runInputs: [],
    hmrcForm: 'VAL231',
  },
  csop: {
    kind: 'csop',
    label: 'CSOP option valuation',
    path: '/engine/v1/emi-csop',
    produces: 'Market value per share for the option grant and the scheme limits.',
    runInputs: [],
    hmrcForm: 'VAL230',
  },
  ip: {
    kind: 'ip',
    label: 'Intangible asset valuation',
    path: '/engine/v1/intangible',
    produces: 'The asset’s value on the selected method, with its inputs.',
    runInputs: [
      {
        key: 'revenues',
        label: 'Revenue forecast',
        hint: 'Optional. A per-year list replacing the flat forecast the questionnaire implies, for relief-from-royalty.',
      },
    ],
    hmrcForm: null,
  },
  '820': {
    kind: '820',
    label: 'ASC 820 fair value measurement',
    path: '/engine/v1/fair-value-820',
    produces: 'The fair value hierarchy by level, and the measurement total.',
    runInputs: [
      {
        key: 'positions',
        label: 'Position schedule',
        hint: 'A list of { name, fair_value, level, inputs, measured_at_nav } rows. The questionnaire collects only the fund and its predominant level.',
      },
    ],
    hmrcForm: null,
  },
  gifts: {
    kind: 'gifts',
    label: 'Gift & estate appraisal',
    path: '/engine/v1/gift-estate',
    produces: 'The concluded value of the transferred interest after the discount chain.',
    runInputs: [],
    hmrcForm: null,
  },
  ifrs2: {
    kind: 'ifrs2',
    label: 'IFRS 2 share-based payment',
    path: '/engine/v1/ifrs2',
    produces: 'Grant-date fair value and the expense attribution over the vesting period.',
    runInputs: [],
    hmrcForm: null,
  },
};

export const SPECIALTY_ENGINE_LIST: readonly SpecialtyEngineDef[] = SPECIALTY_KINDS.map(
  (k) => SPECIALTY_ENGINES[k],
);

export interface SpecialtyRequest {
  /** Engine endpoint path, e.g. `/engine/v1/qsbs`. */
  path: string;
  /** Request body in that endpoint's own shape. */
  body: Record<string, unknown>;
}

type Answers = Record<string, unknown>;

const num = (answers: Answers, key: string): number | null => {
  const v = answers[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const str = (answers: Answers, key: string): string | null => {
  const v = answers[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

const bool = (answers: Answers, key: string): boolean | null =>
  typeof answers[key] === 'boolean' ? (answers[key] as boolean) : null;

/** Add `key: value` only when the answer exists — engine defaults stay in charge. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function require<T>(value: T | null, message: string): T {
  if (value === null) throw new SpecialtyInputError(message);
  return value;
}

/** "120000, 130000, 90000" → [120000, 130000, 90000]. */
function csvNumbers(value: string | null): number[] | null {
  if (!value) return null;
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return null;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) {
    throw new SpecialtyInputError(
      'Undiscounted cash flows must be a comma-separated list of numbers, e.g. 120000, 130000, 90000.',
    );
  }
  return numbers;
}

function qsbsRequest(answers: Answers, overrides: Answers, today: string): SpecialtyRequest {
  const inputs: Record<string, unknown> = {
    entity_type: require(str(answers, 'entity_type'), 'Answer the entity-type question first.'),
    industry: require(str(answers, 'industry'), 'Answer the industry question first.'),
    acquisition_date: require(str(
      answers,
      'acquisition_date',
    ), 'Answer the acquisition-date question first.'),
    assessment_date: today,
    gross_assets_before_issuance: num(answers, 'gross_assets_before_issuance'),
    gross_assets_after_issuance: num(answers, 'gross_assets_after_issuance'),
    active_business_asset_pct: num(answers, 'active_business_asset_pct'),
    acquired_at_original_issue: bool(answers, 'acquired_at_original_issue') ?? false,
  };
  put(inputs, 'is_domestic', bool(answers, 'is_domestic'));
  put(inputs, 'aggregate_basis', num(answers, 'aggregate_basis'));
  put(inputs, 'prior_1202_exclusions', num(answers, 'prior_1202_exclusions'));
  put(inputs, 'redemptions_within_window', bool(answers, 'redemptions_within_window'));
  return { path: '/engine/v1/qsbs', body: { inputs: { ...inputs, ...overrides } } };
}

function ppaRequest(answers: Answers, overrides: Answers): SpecialtyRequest {
  const intangibles = overrides.intangibles;
  if (!Array.isArray(intangibles) || intangibles.length === 0) {
    throw new SpecialtyInputError(
      'A purchase price allocation needs the intangible asset schedule — pass `intangibles` in the ' +
        'run inputs as a list of { name, method, params } rows. The questionnaire collects only the ' +
        'consideration and the tangible balance-sheet positions.',
    );
  }
  const inputs: Record<string, unknown> = {
    consideration_transferred: num(answers, 'consideration_transferred'),
    net_working_capital: num(answers, 'net_working_capital') ?? 0,
    fixed_assets: num(answers, 'fixed_assets') ?? 0,
    other_tangible_assets: num(answers, 'other_tangible_assets') ?? 0,
    assumed_liabilities: num(answers, 'assumed_liabilities') ?? 0,
    deferred_revenue_haircut: num(answers, 'deferred_revenue_haircut') ?? 0,
  };
  return { path: '/engine/v1/ppa', body: { inputs: { ...inputs, ...overrides } } };
}

/**
 * The engine's own method keys (`intangibles._METHODS`). The questionnaire's
 * select offers exactly these, because `value_intangible` looks the method up
 * by name and an unknown one is a 422 no answer can fix — which is what the
 * option spelled `cost` was: the engine has never had a method by that name.
 */
export const IP_METHODS = ['relief_from_royalty', 'meem', 'with_and_without', 'cost_approach'] as const;

/**
 * Answers saved before the option was spelled the engine's way. Migrating the
 * stored answer would be the alternative, but a questionnaire answer is what
 * the client said, and rewriting it to make a downstream lookup succeed is a
 * worse trade than reading the old spelling here.
 */
const IP_METHOD_ALIASES: Record<string, string> = { cost: 'cost_approach' };

/**
 * The parameters each method actually accepts, as keyword names.
 *
 * This exists because the discounted-cash-flow inputs are not universal:
 * `cost_approach` prices replacement cost less obsolescence and takes neither
 * a discount rate nor a tax rate, so sending them — which is what an
 * unconditional `put` did — made every cost-approach run a 422 reading
 * `unexpected keyword argument 'discount_rate'`.
 */
const IP_METHOD_FIELDS: Record<string, readonly string[]> = {
  relief_from_royalty: ['royalty_rate', 'tax_rate', 'discount_rate'],
  meem: ['tax_rate', 'discount_rate'],
  with_and_without: ['tax_rate', 'discount_rate'],
  cost_approach: [
    'replacement_cost',
    'physical_obsolescence_pct',
    'functional_obsolescence_pct',
    'economic_obsolescence_pct',
    'developer_profit_pct',
    'opportunity_cost_pct',
  ],
};

function ipRequest(answers: Answers, overrides: Answers): SpecialtyRequest {
  const answered = require(str(answers, 'valuation_method'), 'Answer the valuation-method question first.');
  const method = IP_METHOD_ALIASES[answered] ?? answered;
  const fields = IP_METHOD_FIELDS[method];
  if (!fields) {
    throw new SpecialtyInputError(
      `Unknown intangible valuation method ${answered} — expected one of ${IP_METHODS.join(', ')}.`,
    );
  }
  const params: Record<string, unknown> = {};
  for (const key of fields) put(params, key, num(answers, key));
  if (method === 'relief_from_royalty') {
    // A flat forecast over the remaining life is the default the questionnaire
    // can support; a real forecast arrives through the run inputs as
    // `revenues` and replaces it.
    const revenue = num(answers, 'annual_revenue');
    const life = num(answers, 'remaining_life_years');
    if (revenue !== null && life !== null && life >= 1) {
      params.revenues = Array.from({ length: Math.min(Math.round(life), 40) }, () => revenue);
    }
  }
  return { path: '/engine/v1/intangible', body: { method, params: { ...params, ...overrides } } };
}

function impairmentRequest(answers: Answers, overrides: Answers): SpecialtyRequest {
  const test = require(str(answers, 'impairment_test'), 'Answer the impairment-test question first.');
  const params: Record<string, unknown> = {
    carrying_amount: num(answers, 'carrying_amount'),
    fair_value: num(answers, 'fair_value'),
  };
  const unit = str(answers, 'reporting_unit');
  if (test === 'goodwill') {
    put(params, 'reporting_unit', unit);
    params.goodwill_carrying_amount = require(num(
      answers,
      'goodwill_carrying_amount',
    ), 'The goodwill test needs the goodwill carrying amount on the books.');
    put(params, 'qualitative_only', bool(answers, 'qualitative_only'));
  } else if (test === 'indefinite_lived') {
    put(params, 'asset', unit);
  } else {
    put(params, 'asset_group', unit);
    params.undiscounted_cash_flows = require(csvNumbers(
      str(answers, 'undiscounted_cash_flows'),
    ), 'The long-lived test needs the undiscounted annual cash flows (comma-separated).');
  }
  return { path: '/engine/v1/impairment', body: { test, params: { ...params, ...overrides } } };
}

function esopRequest(answers: Answers, overrides: Answers): SpecialtyRequest {
  const inputs: Record<string, unknown> = {
    equity_value: num(answers, 'equity_value'),
    shares_outstanding: num(answers, 'shares_outstanding'),
    value_basis: str(answers, 'value_basis') ?? 'control',
  };
  put(inputs, 'control_premium', num(answers, 'control_premium'));
  put(inputs, 'dloc', num(answers, 'dloc'));
  put(inputs, 'dlom', num(answers, 'dlom'));
  put(inputs, 'esop_shares', num(answers, 'esop_shares'));

  const { repurchase: repurchaseOverride, ...inputOverrides } = overrides as {
    repurchase?: Record<string, unknown>;
  } & Record<string, unknown>;

  const body: Record<string, unknown> = { inputs: { ...inputs, ...inputOverrides } };

  // The repurchase projection runs only when the plan facts for it exist —
  // an ESOP valuation without a repurchase study is a complete deliverable.
  const balance = num(answers, 'esop_share_balance');
  const redemption = num(answers, 'annual_redemption_rate');
  if ((balance !== null && redemption !== null) || repurchaseOverride) {
    const repurchase: Record<string, unknown> = {};
    put(repurchase, 'esop_share_balance', balance);
    put(repurchase, 'annual_redemption_rate', redemption);
    put(repurchase, 'share_value_growth', num(answers, 'share_value_growth'));
    put(repurchase, 'years', num(answers, 'projection_years'));
    put(repurchase, 'discount_rate', num(answers, 'repurchase_discount_rate'));
    body.repurchase = { ...repurchase, ...(repurchaseOverride ?? {}) };
  }
  return { path: '/engine/v1/esop', body };
}

function smbRequest(answers: Answers, overrides: Answers): SpecialtyRequest {
  const sdeInputs: Record<string, unknown> = {
    pretax_income: num(answers, 'pretax_income'),
  };
  for (const key of [
    'owner_compensation',
    'interest_expense',
    'depreciation_amortization',
    'one_time_expenses',
    'discretionary_expenses',
    'one_time_income',
    'fair_market_replacement_wage',
  ]) {
    put(sdeInputs, key, num(answers, key));
  }
  const inputs: Record<string, unknown> = { sde_inputs: sdeInputs };
  put(inputs, 'annual_revenue', num(answers, 'annual_revenue'));
  put(inputs, 'sde_multiple', num(answers, 'sde_multiple'));
  put(inputs, 'revenue_multiple', num(answers, 'revenue_multiple'));

  const rfr = num(answers, 'risk_free_rate');
  const erp = num(answers, 'equity_risk_premium');
  if (rfr !== null && erp !== null) {
    const cap: Record<string, unknown> = { risk_free_rate: rfr, equity_risk_premium: erp };
    put(cap, 'size_premium', num(answers, 'size_premium'));
    put(cap, 'company_specific_premium', num(answers, 'company_specific_premium'));
    put(cap, 'long_term_growth', num(answers, 'long_term_growth'));
    inputs.cap_rate_inputs = cap;
  }
  return { path: '/engine/v1/smb', body: { inputs: { ...inputs, ...overrides } } };
}

function emiCsopRequest(scheme: 'emi' | 'csop', answers: Answers, overrides: Answers): SpecialtyRequest {
  const params: Record<string, unknown> = {
    equity_value: num(answers, 'equity_value'),
    total_shares: num(answers, 'total_shares'),
    options_granted: num(answers, 'options_granted'),
  };
  put(params, 'minority_discount', num(answers, 'minority_discount'));
  put(params, 'restriction_discount', num(answers, 'restriction_discount'));
  put(params, 'individual_prior_grants_umv', num(answers, 'individual_prior_grants_umv'));
  if (scheme === 'emi') {
    put(params, 'gross_assets', num(answers, 'gross_assets'));
    put(params, 'employee_count', num(answers, 'fte_employee_count'));
    put(params, 'company_unexercised_umv', num(answers, 'company_unexercised_umv'));
    put(params, 'is_independent', bool(answers, 'is_independent'));
    put(params, 'has_qualifying_trade', bool(answers, 'has_qualifying_trade'));
    put(params, 'works_25_hours_or_75_pct', bool(answers, 'works_25_hours_or_75_pct'));
  } else {
    put(params, 'exercise_price', num(answers, 'exercise_price'));
  }
  return { path: '/engine/v1/emi-csop', body: { scheme, params: { ...params, ...overrides } } };
}

/**
 * ASC 820. The questionnaire collects the fund and the predominant level; the
 * position schedule that the hierarchy is actually built from is analyst work
 * and arrives through the run inputs, the same way a PPA's intangible schedule
 * does. Without it there is no measurement to categorise, so this refuses
 * rather than returning a one-line table built from the answer to
 * "predominant level".
 */
function fairValue820Request(answers: Answers, overrides: Answers): SpecialtyRequest {
  const positions = overrides.positions;
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new SpecialtyInputError(
      'An ASC 820 measurement needs the position schedule — pass `positions` in the run inputs ' +
        'as a list of { name, fair_value, level, inputs, measured_at_nav } rows. The ' +
        'questionnaire collects only the fund and its predominant level.',
    );
  }
  const inputs: Record<string, unknown> = { positions };
  put(inputs, 'measurement_date', str(answers, 'measurement_date'));
  const { positions: _positions, ...rest } = overrides;
  return { path: '/engine/v1/fair-value-820', body: { inputs: { ...inputs, ...rest } } };
}

/**
 * Rev. Rul. 59-60 §4.01, as the engine's list of factor keys.
 *
 * `null` when the checklist has not been touched at all, because the engine
 * distinguishes an unstated checklist from a completed one that addressed
 * nothing, and an empty list here would assert the second. A single answered
 * box — even a "no" — is the appraiser having worked through it, so the list
 * goes out.
 *
 * The keys are `factor_` plus the engine's own key, so the two lists cannot
 * drift into different spellings of the same factor without the census in
 * test/unit/specialtyFieldConsumption.test.ts noticing that a question stopped
 * reaching the engine.
 */
function revRul5960Factors(answers: Answers): string[] | null {
  const keys = Object.keys(answers).filter((k) => k.startsWith('factor_') && typeof answers[k] === 'boolean');
  if (keys.length === 0) return null;
  return keys.filter((k) => answers[k] === true).map((k) => k.slice('factor_'.length));
}

/**
 * Gift & estate. `percent_interest` is a percentage here and in the engine —
 * the questionnaire says "25 for a quarter interest" and converting it to a
 * fraction on the way through would value the interest at a quarter of a
 * percent of the entity.
 */
function giftEstateRequest(answers: Answers, overrides: Answers): SpecialtyRequest {
  const inputs: Record<string, unknown> = {
    entity_value: require(num(answers, 'entity_value') ??
      (num(overrides, 'entity_value') as
        | number
        | null), 'A gift & estate valuation needs the entity value — answer it in the questionnaire or ' +
      'pass `entity_value` in the run inputs.'),
    percent_interest: require(num(
      answers,
      'percent_interest',
    ), 'Answer the percentage-interest question first.'),
    transfer_type: str(answers, 'transfer_type') ?? 'gift',
  };
  put(inputs, 'transfer_date', str(answers, 'transfer_date'));
  put(inputs, 'dloc', num(answers, 'dloc'));
  put(inputs, 'dlom', num(answers, 'dlom'));
  put(inputs, 'prior_taxable_gifts', num(answers, 'prior_gifts_value'));
  // §2503(b). Absent stays absent — the engine reports an undetermined
  // exclusion differently from a nil one, and putting a 0 here would turn an
  // unanswered question into a determination on the return.
  put(inputs, 'annual_exclusion', num(answers, 'annual_exclusion'));
  put(inputs, 'donees', num(answers, 'donees'));
  put(inputs, 'split_gift', bool(answers, 'split_gift'));
  put(inputs, 'factors_addressed', revRul5960Factors(answers));
  return { path: '/engine/v1/gift-estate', body: { inputs: { ...inputs, ...overrides } } };
}

/**
 * IFRS 2. The vesting condition drives which paragraph governs, so it is
 * passed through rather than collapsed into a forfeiture estimate — a market
 * condition lives in the grant-date fair value and a service condition does
 * not, and the engine refuses the combination that confuses the two.
 */
function ifrs2Request(answers: Answers, overrides: Answers): SpecialtyRequest {
  const inputs: Record<string, unknown> = {
    settlement: str(answers, 'settlement') ?? 'equity_settled',
    vesting_condition: str(answers, 'vesting_condition') ?? 'service',
    exercise_price: require(num(answers, 'exercise_price'), 'Answer the exercise-price question first.'),
  };
  put(inputs, 'grant_date', str(answers, 'grant_date'));
  put(inputs, 'vesting_years', num(answers, 'vesting_years'));
  put(inputs, 'options_granted', num(answers, 'options_granted'));
  put(inputs, 'share_price', num(answers, 'share_price'));
  put(inputs, 'expected_term_years', num(answers, 'expected_term_years'));
  put(inputs, 'expected_volatility', num(answers, 'expected_volatility'));
  put(inputs, 'risk_free_rate', num(answers, 'risk_free_rate'));
  put(inputs, 'dividend_yield', num(answers, 'dividend_yield'));
  // Absent stays absent. The engine reports an unmade forfeiture estimate
  // differently from an estimate of nil, and a 0 here would turn a question
  // nobody answered into "we expect every award to vest".
  put(inputs, 'expected_forfeiture_rate', num(answers, 'expected_forfeiture_rate'));
  return { path: '/engine/v1/ifrs2', body: { inputs: { ...inputs, ...overrides } } };
}

/**
 * The engine request for a kind: the questionnaire's answers assembled into
 * the endpoint's shape, with the analyst's run `overrides` merged over the
 * assembled inputs/params (shallow — an override replaces the assembled key).
 *
 * `today` is the assessment date (YYYY-MM-DD) for kinds that need one.
 */
export function specialtyEngineRequest(
  kind: SpecialtyKind,
  answers: Answers,
  overrides: Answers = {},
  today: string = todayLocal(),
): SpecialtyRequest {
  switch (kind) {
    case 'qsbs':
      return qsbsRequest(answers, overrides, today);
    case 'ppa':
      return ppaRequest(answers, overrides);
    case 'ip':
      return ipRequest(answers, overrides);
    case 'goodwill':
      return impairmentRequest(answers, overrides);
    case 'esop':
      return esopRequest(answers, overrides);
    case 'fmv':
      return smbRequest(answers, overrides);
    case 'emi':
      return emiCsopRequest('emi', answers, overrides);
    case 'csop':
      return emiCsopRequest('csop', answers, overrides);
    case '820':
      return fairValue820Request(answers, overrides);
    case 'gifts':
      return giftEstateRequest(answers, overrides);
    case 'ifrs2':
      return ifrs2Request(answers, overrides);
  }
}

const resultNum = (result: Record<string, unknown>, key: string): number | null => {
  const v = result[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

const bodyNum = (body: Record<string, unknown>, section: string, key: string): number | null => {
  const s = body[section];
  if (!s || typeof s !== 'object') return null;
  const v = (s as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * The headline figures a specialty run contributes to the calculation row's
 * typed columns. Kinds whose deliverable has no per-share or equity figure
 * (a QSBS attestation, an impairment memo, a PPA) contribute nothing — null
 * is the true answer there, not a missing one.
 */
export function specialtyHeadline(
  kind: SpecialtyKind,
  request: SpecialtyRequest,
  result: Record<string, unknown>,
): { equityValue: number | null; fmvPerShare: number | null } {
  switch (kind) {
    case 'esop':
      return {
        equityValue: bodyNum(request.body, 'inputs', 'equity_value'),
        fmvPerShare: resultNum(result, 'fmv_per_share'),
      };
    case 'fmv':
      return { equityValue: resultNum(result, 'equity_value'), fmvPerShare: null };
    case 'emi':
    case 'csop':
      // AMV is the figure the scheme grants at — the UMV rides in the results.
      return {
        equityValue: bodyNum(request.body, 'params', 'equity_value'),
        fmvPerShare: resultNum(result, 'amv_per_share'),
      };
    case '820':
      // The measurement total is the deliverable's headline. There is no
      // per-share figure: an ASC 820 measurement values positions, not shares.
      return { equityValue: resultNum(result, 'total_fair_value'), fmvPerShare: null };
    case 'gifts':
      // The concluded value of the *transferred interest* — deliberately not
      // the entity value it was derived from, which is the number a reader
      // would otherwise mistake for the appraisal.
      return { equityValue: resultNum(result, 'concluded_value'), fmvPerShare: null };
    case 'ifrs2':
      // The total charge is the deliverable; fair value per *award* is not a
      // per-share figure and would be misread as one in that column.
      return { equityValue: resultNum(result, 'total_expense'), fmvPerShare: null };
    default:
      return { equityValue: null, fmvPerShare: null };
  }
}
