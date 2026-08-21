/**
 * Client intake questionnaire (feature 7). A guided, sectioned data-collection
 * form the client fills in during onboarding. The schema lives here (pure) so
 * both the completion calculation and the frontend wizard render from one
 * source of truth.
 */

import { z } from 'zod';
import { isIsoCalendarDate } from '@n409/shared';
import { todayLocal } from './calendarDate.js';

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
  /** Character ceiling for `text` / `textarea` answers. */
  maxLength?: number;
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

/**
 * Ceilings for the two free-text shapes.
 *
 * Not a style preference — the portal write endpoint is anonymous, so without a
 * bound the only limit on what lands in the jsonb column is Fastify's 1 MB body
 * cap, per save, forever. A company name is a company name; the description is
 * "a few sentences", as its own hint says. Both are generous enough that no
 * client who is answering the question honestly will meet them, and the number
 * travels to the browser inside the schema so the textarea can stop at the same
 * place the server refuses.
 */
export const MAX_TEXT_LENGTH = 300;
export const MAX_TEXTAREA_LENGTH = 5_000;

export const INTAKE_SECTIONS: readonly IntakeSection[] = [
  {
    key: 'company',
    title: 'Company information',
    description: 'Tell us about the company being valued.',
    fields: [
      {
        key: 'legal_name',
        label: 'Legal company name',
        type: 'text',
        required: true,
        rules: { maxLength: MAX_TEXT_LENGTH },
      },
      {
        key: 'state_of_incorporation',
        label: 'State / country of incorporation',
        type: 'text',
        required: true,
        rules: { maxLength: MAX_TEXT_LENGTH },
      },
      {
        key: 'incorporation_date',
        label: 'Date of incorporation',
        type: 'date',
        required: true,
        rules: { notFuture: true, minDate: EARLIEST_PLAUSIBLE_DATE },
      },
      {
        key: 'industry',
        label: 'Industry / sector',
        type: 'text',
        required: true,
        rules: { maxLength: MAX_TEXT_LENGTH },
      },
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
        rules: { maxLength: MAX_TEXTAREA_LENGTH },
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
      {
        key: 'last_round_name',
        label: 'Most recent financing round',
        type: 'text',
        required: false,
        rules: { maxLength: MAX_TEXT_LENGTH },
      },
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
        rules: { maxLength: MAX_TEXT_LENGTH },
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

/**
 * Compute per-section and overall completion of the questionnaire.
 *
 * `sections` defaults to the 409A questionnaire; kind-specific callers pass
 * `intakeSectionsFor(kind)` (domain/intakeKinds.ts) so completion is judged
 * against the form the client was actually shown.
 */
export function computeCompletion(
  answers: Record<string, unknown>,
  sectionDefs: readonly IntakeSection[] = INTAKE_SECTIONS,
): IntakeCompletion {
  const sections: SectionCompletion[] = sectionDefs.map((section) => {
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

/**
 * Bound on one saved answer.
 *
 * `narrowIntakeAnswers` already refuses everything that is not a scalar, which
 * left the length of a `text`/`textarea` answer as the only unmeasured axis:
 * both write paths took `z.record(z.string(), z.unknown())`, so a single answer
 * could be the whole 1 MB body, and the anonymous portal — which authenticates
 * on a link token and nothing else — writes through the same schema.
 *
 * Enforced in the route schema rather than dropped here on purpose. The narrow
 * step drops a wrong-*shaped* value silently because the wizard cannot produce
 * one; a long answer is something the client actually typed, so it has to come
 * back as a 422 naming the field instead of vanishing from the form.
 */
export const MAX_INTAKE_ANSWER_CHARS = 10_000;

/** The largest questionnaire is ~150 fields; unknown keys are dropped below anyway. */
export const MAX_INTAKE_ANSWER_KEYS = 400;

/**
 * The body shape both intake write paths accept for `answers`.
 *
 * Deliberately *not* a union of the scalar types. Bounding the value shape here
 * would move the wrong-shape decision out of `narrowIntakeAnswers` and turn a
 * silent drop into a 422 — the opposite of what that function documents, and a
 * regression for the anonymous portal, which autosaves on a timer and would
 * start rejecting whole payloads over one value it is designed to discard.
 *
 * So it measures how many answers there are, and then — only for the scalars
 * that will actually survive the narrow step — the two hazards a drop cannot
 * fix. A long string reaches the column as-is. A non-finite number reaches it
 * as `null`, because that is what `JSON.stringify(Infinity)` writes, and
 * `1e999` is what a spreadsheet paste looks like on the wire (see
 * `domain/finite.ts`); both are values the client really typed, so both come
 * back as a 422 naming the field rather than vanishing from the form.
 *
 * An object or an array is neither: it is a shape the wizard cannot produce, it
 * cannot reach the column at any size, and it stays the narrow step's business.
 */
export const IntakeAnswers = z.record(z.string().max(200), z.unknown()).superRefine((answers, ctx) => {
  const keys = Object.keys(answers);
  if (keys.length > MAX_INTAKE_ANSWER_KEYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `At most ${MAX_INTAKE_ANSWER_KEYS} answers`,
    });
    return;
  }
  for (const key of keys) {
    const value = answers[key];
    if (typeof value === 'string' && value.length > MAX_INTAKE_ANSWER_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Answer must be at most ${MAX_INTAKE_ANSWER_CHARS} characters`,
      });
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'Answer must be a finite number',
      });
    }
  }
});

/**
 * Answers narrowed to what the questionnaire can actually hold.
 *
 * Both write paths — the anonymous portal and the signed-in wizard — filtered
 * to the known *key* set and then wrote whatever value came with it into a jsonb
 * column. A key set is only half the guard: `{"legal_name": {"$ne": null}}` has
 * a legal key, so it was stored, and the firm console then rendered the
 * company's legal name as "[object Object]". Worse for the required `select`,
 * where `isAnswered({})` is true and the option check below only ran on strings
 * — an object satisfied "every required field is answered" *and* skipped the
 * choice check, so a questionnaire could be submitted with a revenue stage that
 * is not one of the two offered.
 *
 * An answer is a scalar. Nothing the wizard can produce is an object or an
 * array, so anything that is drops here rather than being reported: this runs on
 * every keystroke's autosave, and a message about a value the client cannot have
 * typed is noise. What a *scalar of the wrong shape* does — a number where the
 * form asks for a choice — is `validateIntake`'s question, and it answers it
 * with an error the client can see.
 */
export function narrowIntakeAnswers(
  answers: Record<string, unknown>,
  keys: ReadonlySet<string> = INTAKE_FIELD_KEYS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!keys.has(key)) continue;
    if (value === null || value === undefined) {
      // Explicit null is how the wizard clears an answer; undefined cannot
      // survive JSON, but a direct caller of this function can still send it.
      out[key] = null;
      continue;
    }
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') out[key] = value;
  }
  return out;
}

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

  if (field.type === 'select') {
    // `typeof value === 'string'` used to be part of the *condition*, so a
    // non-string answer skipped the check entirely rather than failing it — and
    // `isAnswered` counts any non-blank value, so a required select answered
    // with `5` read as complete and valid.
    if (typeof value !== 'string') {
      at('error', `${field.label} must be one of the offered choices.`);
    } else if (field.options && value.trim() !== '' && !field.options.includes(value)) {
      at('error', `${field.label} is not one of the offered choices.`);
    }
    return issues;
  }

  if (field.type === 'boolean' && typeof value !== 'boolean') {
    at('error', `${field.label} must be answered yes or no.`);
    return issues;
  }

  if (field.type === 'text' || field.type === 'textarea') {
    if (typeof value !== 'string') {
      at('error', `${field.label} must be text.`);
      return issues;
    }
    // Length is measured in code points, not UTF-16 units, so a name written in
    // emoji or in a non-BMP script is counted the way the person typing it
    // counts it rather than at half the allowance.
    const length = [...value].length;
    if (rules.maxLength !== undefined && length > rules.maxLength) {
      at('error', `${field.label} must be ${rules.maxLength} characters or fewer (currently ${length}).`);
    }
  }
  return issues;
}

export interface ValidateIntakeOptions {
  /** "Today" for `notFuture`; defaults to the current day in the process's zone. */
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
  const today = todayLocal(options.today);

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
