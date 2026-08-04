/**
 * Client intake questionnaire (feature 7). A guided, sectioned data-collection
 * form the client fills in during onboarding. The schema lives here (pure) so
 * both the completion calculation and the frontend wizard render from one
 * source of truth.
 */

import { isIsoCalendarDate } from '@n409/shared';

export const INTAKE_EVENT_TYPES = {
  saved: 'intake_saved',
  submitted: 'intake_submitted',
  reminderSent: 'document_reminder_sent',
} as const;

export type IntakeFieldType = 'text' | 'textarea' | 'number' | 'date' | 'boolean' | 'select';

/**
 * Content constraints on a single answer.
 *
 * Declared here rather than in the wizard because the same rule has to hold in
 * two places that cannot share code: the browser, which warns while the client
 * types, and this service, which is the only thing standing between an
 * anonymous intake link and the database. Shipping the rules inside the schema
 * payload keeps one definition and two evaluators, instead of two definitions
 * that drift.
 */
export interface IntakeFieldRules {
  /** Inclusive lower bound for `number` answers. */
  min?: number;
  /** Inclusive upper bound for `number` answers. */
  max?: number;
  /** `number` answers must be whole — shares and headcounts are not fractional. */
  integer?: boolean;
  /** `date` answers may not be after today. */
  notFuture?: boolean;
  /** `date` answers may not be before this YYYY-MM-DD. */
  minDate?: string;
}

export interface IntakeField {
  key: string;
  label: string;
  type: IntakeFieldType;
  required: boolean;
  options?: string[];
  hint?: string;
  rules?: IntakeFieldRules;
}

export interface IntakeSection {
  key: string;
  title: string;
  description: string;
  fields: IntakeField[];
}

/**
 * Floor for any date the client types. Not a business rule — a typo guard.
 * `0202-05-14` is what a slipped keystroke produces in a date input, and it
 * reaches the engine as a plausible-looking Date rather than an error.
 */
export const EARLIEST_PLAUSIBLE_DATE = '1900-01-01';

export const INTAKE_SECTIONS: readonly IntakeSection[] = [
  {
    key: 'company',
    title: 'Company information',
    description: 'Tell us about the company being valued.',
    fields: [
      { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
      {
        key: 'state_of_incorporation',
        label: 'State / country of incorporation',
        type: 'text',
        required: true,
      },
      {
        key: 'incorporation_date',
        label: 'Date of incorporation',
        type: 'date',
        required: true,
        rules: { notFuture: true, minDate: EARLIEST_PLAUSIBLE_DATE },
      },
      { key: 'industry', label: 'Industry / sector', type: 'text', required: true },
      {
        key: 'employee_count',
        label: 'Number of employees',
        type: 'number',
        required: false,
        rules: { min: 0, integer: true },
      },
      {
        key: 'business_description',
        label: 'Business description',
        type: 'textarea',
        required: true,
        hint: 'A few sentences on what the company does.',
      },
    ],
  },
  {
    key: 'financials',
    title: 'Financials',
    description: 'High-level financial position. Detailed statements are uploaded as documents.',
    fields: [
      {
        key: 'revenue_status',
        label: 'Revenue stage',
        type: 'select',
        required: true,
        options: ['pre_revenue', 'post_revenue'],
      },
      {
        key: 'last_fy_revenue',
        label: 'Last fiscal-year revenue',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'ytd_revenue',
        label: 'Year-to-date revenue',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      { key: 'cash_on_hand', label: 'Cash on hand', type: 'number', required: false, rules: { min: 0 } },
      {
        key: 'monthly_burn',
        label: 'Monthly net burn',
        type: 'number',
        required: false,
        hint: 'Enter burn as a positive number.',
        rules: { min: 0 },
      },
    ],
  },
  {
    key: 'cap_table',
    title: 'Capitalization',
    description: 'Summary cap-table figures. Upload the full cap table as a document.',
    fields: [
      {
        key: 'total_shares_outstanding',
        label: 'Total shares outstanding',
        type: 'number',
        required: true,
        rules: { min: 1, integer: true },
      },
      {
        key: 'option_pool_size',
        label: 'Option pool size (shares)',
        type: 'number',
        required: false,
        rules: { min: 0, integer: true },
      },
      { key: 'last_round_name', label: 'Most recent financing round', type: 'text', required: false },
      {
        key: 'last_round_price',
        label: 'Most recent price per share',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'last_round_date',
        label: 'Most recent round close date',
        type: 'date',
        required: false,
        rules: { notFuture: true, minDate: EARLIEST_PLAUSIBLE_DATE },
      },
    ],
  },
  {
    key: 'legal',
    title: 'Legal & governance',
    description: 'Charter documents and anything affecting value.',
    fields: [
      { key: 'has_articles', label: 'Articles of incorporation available?', type: 'boolean', required: true },
      { key: 'has_charter_amendments', label: 'Any charter amendments?', type: 'boolean', required: false },
      { key: 'pending_litigation', label: 'Any pending litigation?', type: 'boolean', required: false },
      {
        key: 'anticipated_liquidity',
        label: 'Anticipated liquidity event / timeline',
        type: 'text',
        required: false,
      },
    ],
  },
] as const;

/** True when a field's answer counts as provided (0 and false are valid answers). */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export interface SectionCompletion {
  key: string;
  title: string;
  requiredTotal: number;
  requiredAnswered: number;
  answeredTotal: number;
  fieldTotal: number;
  complete: boolean;
}

export interface IntakeCompletion {
  sections: SectionCompletion[];
  requiredTotal: number;
  requiredAnswered: number;
  percentComplete: number;
  /** True when every required field across every section is answered. */
  ready: boolean;
}

/** Compute per-section and overall completion of the questionnaire. */
export function computeCompletion(answers: Record<string, unknown>): IntakeCompletion {
  const sections: SectionCompletion[] = INTAKE_SECTIONS.map((section) => {
    const required = section.fields.filter((f) => f.required);
    const requiredAnswered = required.filter((f) => isAnswered(answers[f.key])).length;
    const answeredTotal = section.fields.filter((f) => isAnswered(answers[f.key])).length;
    return {
      key: section.key,
      title: section.title,
      requiredTotal: required.length,
      requiredAnswered,
      answeredTotal,
      fieldTotal: section.fields.length,
      complete: requiredAnswered === required.length,
    };
  });
  const requiredTotal = sections.reduce((n, s) => n + s.requiredTotal, 0);
  const requiredAnswered = sections.reduce((n, s) => n + s.requiredAnswered, 0);
  return {
    sections,
    requiredTotal,
    requiredAnswered,
    percentComplete: requiredTotal > 0 ? Math.round((requiredAnswered / requiredTotal) * 100) : 100,
    ready: requiredAnswered === requiredTotal,
  };
}

/** Set of field keys the questionnaire recognises — answers are filtered to these. */
export const INTAKE_FIELD_KEYS: ReadonlySet<string> = new Set(
  INTAKE_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)),
);

// ── Answer validation ─────────────────────────────────────────────────────────

/**
 * Validation is deliberately separate from completion. Completion asks whether
 * an answer is *there*; validation asks whether it can be *true*. A blank
 * required field is the wizard's progress bar's problem, not a warning — the
 * client already knows they have not finished.
 *
 * Severity is the whole point of the split:
 *
 *   * `error` — the answer cannot be right at all (negative revenue, a
 *     valuation-relevant date in the year 0202, a round that closed before the
 *     company existed). Submission is refused.
 *   * `warning` — the answer is possible but usually a mistake, and only the
 *     client can say which (an option pool larger than the shares outstanding
 *     is either double-counting or an unusual cap table). Shown, never blocking.
 *
 * An analyst finds these anyway, three days later, over email. Catching them at
 * the keyboard is the difference between a correction and a round trip.
 */

export type IntakeIssueSeverity = 'error' | 'warning';

export interface IntakeIssue {
  /** Field key the message renders against. */
  field: string;
  severity: IntakeIssueSeverity;
  message: string;
}

export type IntakeCompareOp = 'gt' | 'gte' | 'lt' | 'lte';

/**
 * A comparison between two answers, or an answer and a literal.
 *
 * Both sides must resolve to a comparable value for the rule to fire, so a
 * half-filled form raises nothing — a rule about a round date says nothing
 * until there is a round date.
 */
export interface IntakeCrossRule {
  key: string;
  /** Field the issue attaches to — where the client sees the message. */
  field: string;
  severity: IntakeIssueSeverity;
  /** Left operand: a field key. */
  left: string;
  op: IntakeCompareOp;
  /** Right operand: a field key, or a literal number. */
  right: string | number;
  /** Only evaluated when this field holds one of these values. */
  when?: { field: string; equals: readonly unknown[] };
  message: string;
}

export const INTAKE_CROSS_RULES: readonly IntakeCrossRule[] = [
  {
    key: 'round_before_incorporation',
    field: 'last_round_date',
    severity: 'error',
    left: 'last_round_date',
    op: 'lt',
    right: 'incorporation_date',
    message: 'The most recent round closed before the company was incorporated.',
  },
  {
    key: 'pool_exceeds_outstanding',
    field: 'option_pool_size',
    severity: 'warning',
    left: 'option_pool_size',
    op: 'gt',
    right: 'total_shares_outstanding',
    message:
      'The option pool is larger than total shares outstanding — check whether the pool is ' +
      'already counted inside the total.',
  },
  {
    key: 'burn_exceeds_cash',
    field: 'monthly_burn',
    severity: 'warning',
    left: 'monthly_burn',
    op: 'gt',
    right: 'cash_on_hand',
    message: 'Monthly burn is greater than cash on hand — that is under one month of runway.',
  },
  {
    key: 'pre_revenue_with_revenue',
    field: 'last_fy_revenue',
    severity: 'warning',
    left: 'last_fy_revenue',
    op: 'gt',
    right: 0,
    when: { field: 'revenue_status', equals: ['pre_revenue'] },
    message: 'The company is marked pre-revenue but reports last fiscal-year revenue above zero.',
  },
  {
    key: 'ytd_exceeds_last_fy_materially',
    field: 'ytd_revenue',
    severity: 'warning',
    left: 'ytd_revenue',
    op: 'gt',
    right: 'last_fy_revenue',
    when: { field: 'revenue_status', equals: ['post_revenue'] },
    message:
      'Year-to-date revenue already exceeds the full prior fiscal year — confirm the period ' +
      'each figure covers.',
  },
] as const;

/**
 * True when `value` is a real calendar day written as YYYY-MM-DD.
 *
 * `new Date('2023-02-30')` does not throw — it rolls forward to 2 March, which
 * is what the shared check catches. Re-exported under this name because the
 * intake rules refer to it, but there is one implementation now: the route
 * schemas were doing the shape check alone while this file had it right, and
 * two spellings of the same rule are how that gap opened.
 */
export const isValidIsoDate = isIsoCalendarDate;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Answers arrive as JSON, so a number can be a number or the string of one. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Comparable scalar for a cross rule: a number, or a valid date as its epoch. */
function comparable(value: unknown): number | null {
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    return isValidIsoDate(value) ? new Date(`${value}T00:00:00Z`).getTime() : null;
  }
  return asNumber(value);
}

function compare(left: number, op: IntakeCompareOp, right: number): boolean {
  switch (op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

function fieldIssues(field: IntakeField, value: unknown, today: string): IntakeIssue[] {
  const issues: IntakeIssue[] = [];
  const at = (severity: IntakeIssueSeverity, message: string) =>
    issues.push({ field: field.key, severity, message });
  const rules = field.rules ?? {};

  if (field.type === 'number') {
    const n = asNumber(value);
    if (n === null) {
      at('error', `${field.label} must be a number.`);
      return issues;
    }
    if (rules.min !== undefined && n < rules.min) {
      at(
        'error',
        rules.min === 0
          ? `${field.label} cannot be negative.`
          : `${field.label} must be at least ${rules.min}.`,
      );
    }
    if (rules.max !== undefined && n > rules.max) at('error', `${field.label} must be at most ${rules.max}.`);
    if (rules.integer && !Number.isInteger(n)) at('error', `${field.label} must be a whole number.`);
    return issues;
  }

  if (field.type === 'date') {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!isValidIsoDate(raw)) {
      at('error', `${field.label} must be a valid date (YYYY-MM-DD).`);
      return issues;
    }
    if (rules.notFuture && raw > today) at('error', `${field.label} cannot be in the future.`);
    if (rules.minDate && raw < rules.minDate) {
      at('error', `${field.label} looks mistyped — it is before ${rules.minDate}.`);
    }
    return issues;
  }

  if (field.type === 'select' && field.options && typeof value === 'string' && value.trim() !== '') {
    if (!field.options.includes(value)) at('error', `${field.label} is not one of the offered choices.`);
  }
  return issues;
}

export interface ValidateIntakeOptions {
  /** "Today" for `notFuture`; defaults to the current UTC day. */
  today?: Date;
  /** Override the rule set — the frontend passes the schema it was served. */
  sections?: readonly IntakeSection[];
  crossRules?: readonly IntakeCrossRule[];
}

/**
 * Every content problem in a set of answers, in schema order so the list reads
 * top-to-bottom like the form does. Unanswered fields raise nothing.
 */
export function validateIntake(
  answers: Record<string, unknown>,
  options: ValidateIntakeOptions = {},
): IntakeIssue[] {
  const sections = options.sections ?? INTAKE_SECTIONS;
  const crossRules = options.crossRules ?? INTAKE_CROSS_RULES;
  const today = (options.today ?? new Date()).toISOString().slice(0, 10);

  const issues: IntakeIssue[] = [];
  for (const section of sections) {
    for (const field of section.fields) {
      if (!isAnswered(answers[field.key])) continue;
      issues.push(...fieldIssues(field, answers[field.key], today));
    }
  }

  for (const rule of crossRules) {
    if (rule.when && !rule.when.equals.includes(answers[rule.when.field])) continue;
    const left = comparable(answers[rule.left]);
    const right = typeof rule.right === 'number' ? rule.right : comparable(answers[rule.right]);
    if (left === null || right === null) continue;
    if (compare(left, rule.op, right)) {
      issues.push({ field: rule.field, severity: rule.severity, message: rule.message });
    }
  }

  return issues;
}

/** Errors block submission; warnings never do. */
export function hasBlockingIssues(issues: readonly IntakeIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
