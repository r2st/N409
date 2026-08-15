/**
 * Live validation for the intake questionnaire.
 *
 * The rules themselves are not defined here — they arrive inside the schema
 * payload from the valuation service (`domain/intake.ts`), which is also what
 * refuses a bad submission. This module is only the browser's evaluator, so a
 * client sees "revenue cannot be negative" as they type rather than after a
 * round trip, and sees exactly what the server would have said.
 *
 * Keeping the rules on the wire and the evaluator local is what stops the two
 * sides drifting: adding a constraint is a one-line change in the domain and
 * the form picks it up with no frontend release.
 */

export type IntakeIssueSeverity = 'error' | 'warning';

export interface IntakeIssue {
  field: string;
  severity: IntakeIssueSeverity;
  message: string;
}

export interface IntakeFieldRules {
  min?: number;
  max?: number;
  integer?: boolean;
  notFuture?: boolean;
  minDate?: string;
  maxLength?: number;
}

export type IntakeFieldType = 'text' | 'textarea' | 'number' | 'date' | 'boolean' | 'select';

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

export type IntakeCompareOp = 'gt' | 'gte' | 'lt' | 'lte';

export interface IntakeCrossRule {
  key: string;
  field: string;
  severity: IntakeIssueSeverity;
  left: string;
  op: IntakeCompareOp;
  right: string | number;
  when?: { field: string; equals: readonly unknown[] };
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day: `2023-02-30` parses but rolls forward, so round-trip it. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Today, in the zone the browser is in — not the UTC day.
 *
 * The evaluator's counterpart to `domain/calendarDate.ts` on the server, and
 * the half of that bug a client actually meets. `notFuture` compares the day
 * they typed against this string, and `toISOString()` answers in UTC, which is
 * still *yesterday* for the first hours of the morning anywhere east of it.
 * A founder in Sydney opening the form at 9am was told the date they had just
 * entered "cannot be in the future" — for today — with no value the field would
 * accept. Reading the local parts asks the question the rule means: what day is
 * it where the person filling this in is sitting.
 *
 * The server's copy of the same rule runs in the server's zone and can disagree
 * by a day at the margins. That is the right way round: the browser is stricter
 * about a date typed in the morning east of UTC, the submit is stricter about
 * one typed in the evening west of it, and neither can be talked into accepting
 * a date that is in the future in both places.
 */
function todayLocal(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function comparable(value: unknown): number | null {
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    return isValidIsoDate(value) ? new Date(`${value}T00:00:00Z`).getTime() : null;
  }
  return asNumber(value);
}

function compare(left: number, op: IntakeCompareOp, right: number): boolean {
  if (op === 'gt') return left > right;
  if (op === 'gte') return left >= right;
  if (op === 'lt') return left < right;
  return left <= right;
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
    // Code points, not UTF-16 units — the same count the server applies, so the
    // browser never says "fine" about a value the submit will refuse.
    const length = [...value].length;
    if (rules.maxLength !== undefined && length > rules.maxLength) {
      at('error', `${field.label} must be ${rules.maxLength} characters or fewer (currently ${length}).`);
    }
  }
  return issues;
}

export interface ValidateIntakeOptions {
  today?: Date;
}

/** Every content problem in the answers, in schema order. Blanks raise nothing. */
export function validateIntake(
  sections: readonly IntakeSection[],
  crossRules: readonly IntakeCrossRule[],
  answers: Record<string, unknown>,
  options: ValidateIntakeOptions = {},
): IntakeIssue[] {
  const today = todayLocal(options.today ?? new Date());
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

/** Errors block submission; warnings are advisory. */
export function hasBlockingIssues(issues: readonly IntakeIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Issues bucketed by field key — what a form row needs to render itself. */
export function issuesByField(issues: readonly IntakeIssue[]): Map<string, IntakeIssue[]> {
  const map = new Map<string, IntakeIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.field);
    if (list) list.push(issue);
    else map.set(issue.field, [issue]);
  }
  return map;
}
