import { isIsoCalendarDate } from '@n409/shared';
import { computeCompletion, narrowIntakeAnswers, type IntakeCompletion } from './intake.js';

/**
 * Status of a firm's client intake link.
 *
 * The firm console needs one word per row, and the row carries five nullable
 * timestamps that can disagree — a link can be expired *and* submitted, revoked
 * *and* opened. So the precedence is a decision, not an accident, and it lives
 * here where it can be tested at each boundary rather than being re-derived
 * slightly differently by every caller that renders a badge.
 */

export const INTAKE_LINK_STATUSES = [
  'converted',
  'submitted',
  'revoked',
  'expired',
  'in_progress',
  'sent',
] as const;

export type IntakeLinkStatus = (typeof INTAKE_LINK_STATUSES)[number];

export interface IntakeLinkState {
  revoked_at: Date | string | null;
  expires_at: Date | string;
  submitted_at: Date | string | null;
  valuation_id: string | null;
  last_accessed_at: Date | string | null;
}

const at = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Which single word describes this link.
 *
 * Work the client already did outranks the link's own lifecycle: a submitted
 * questionnaire whose link has since lapsed is `submitted`, because the firm
 * has the answers and "expired" would read as though they had lost them. Below
 * that, revocation outranks expiry — one is a decision, the other is a date.
 */
export function intakeLinkStatus(link: IntakeLinkState, now: Date): IntakeLinkStatus {
  if (link.valuation_id) return 'converted';
  if (at(link.submitted_at) !== null) return 'submitted';
  if (at(link.revoked_at) !== null) return 'revoked';

  const expiresAt = at(link.expires_at);
  if (expiresAt !== null && expiresAt <= now.getTime()) return 'expired';

  return at(link.last_accessed_at) !== null ? 'in_progress' : 'sent';
}

/** True when the client may still answer: not dead, not already submitted. */
export function isIntakeLinkOpen(link: IntakeLinkState, now: Date): boolean {
  const status = intakeLinkStatus(link, now);
  return status === 'sent' || status === 'in_progress';
}

/**
 * Answers narrowed to the fields the questionnaire actually defines, and to the
 * value shapes those fields can hold.
 *
 * This endpoint is reachable by anyone holding a link, so the payload is
 * untrusted input written straight into a jsonb column. Filtering to known keys
 * keeps an anonymous caller from using a client's intake form as free storage,
 * and keeps a retired field from lingering in the record forever. The value
 * half of that guard lives in `narrowIntakeAnswers`, which the valuation-scoped
 * questionnaire shares — a key set alone let an object through and the firm
 * console rendered it as "[object Object]".
 */
export function filterIntakeAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  return narrowIntakeAnswers(answers);
}

export interface IntakeLinkSummary {
  status: IntakeLinkStatus;
  completion: IntakeCompletion;
}

/** Status plus completion — what a firm console row shows for one link. */
export function summarizeIntakeLink(
  link: IntakeLinkState & { answers: Record<string, unknown> },
  now: Date,
): IntakeLinkSummary {
  return {
    status: intakeLinkStatus(link, now),
    completion: computeCompletion(link.answers ?? {}),
  };
}

// ── Conversion to an engagement ───────────────────────────────────────────────

/**
 * What the new valuation is called.
 *
 * The legal name the client typed, then the name the firm addressed the link
 * to, then a placeholder — a valuation must have a company name, and a firm
 * converting a half-finished intake should still get a row it can rename rather
 * than an error about a field it did not fill in.
 */
export function intakeCompanyName(answers: Record<string, unknown>, clientName: string | null): string {
  const legal = typeof answers.legal_name === 'string' ? answers.legal_name.trim() : '';
  if (legal) return legal.slice(0, 300);
  const addressed = clientName?.trim() ?? '';
  return addressed ? addressed.slice(0, 300) : 'Unnamed company';
}

/** A money answer as integer cents, or null when it cannot be one. */
function cents(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const c = Math.round(n * 100);
  // `last_year_revenue_cents` is a bigint column but the params route caps it
  // at MAX_SAFE_INTEGER, because anything above that has already stopped being
  // the number the client typed by the time JSON has carried it here.
  return c <= Number.MAX_SAFE_INTEGER ? c : null;
}

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && isIsoCalendarDate(value.trim()) ? value.trim() : null;

/**
 * The valuation params a submitted questionnaire already answers.
 *
 * Conversion exists so the firm does not retype the client's answers, and these
 * five are the ones that land in a typed column rather than staying prose. Only
 * keys with a usable value are returned: `patchParams` diffs what it is given,
 * so an absent key leaves the analyst's own entry alone, while an explicit null
 * would overwrite it.
 *
 * Deliberately not derived here: runway, which is `cash_on_hand / monthly_burn`
 * and would be this module inventing a figure the client never stated. Weights,
 * discounts and method are the analyst's judgement and are not intake's to seed.
 */
export function intakeParamsPatch(answers: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) patch[key] = value;
  };

  const overview =
    typeof answers.business_description === 'string' ? answers.business_description.trim() : '';
  if (overview) patch.business_overview = overview;
  if (answers.revenue_status === 'pre_revenue' || answers.revenue_status === 'post_revenue') {
    patch.revenue_status = answers.revenue_status;
  }
  put('inception_date', isoDate(answers.incorporation_date));
  put('last_round_date', isoDate(answers.last_round_date));
  put('last_year_revenue_cents', cents(answers.last_fy_revenue));
  put('ytd_revenue_cents', cents(answers.ytd_revenue));
  return patch;
}
