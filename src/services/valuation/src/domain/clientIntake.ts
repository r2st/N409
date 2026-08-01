import { computeCompletion, INTAKE_FIELD_KEYS, type IntakeCompletion } from './intake.js';

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
 * Answers narrowed to the fields the questionnaire actually defines.
 *
 * This endpoint is reachable by anyone holding a link, so the payload is
 * untrusted input written straight into a jsonb column. Filtering to known keys
 * keeps an anonymous caller from using a client's intake form as free storage,
 * and keeps a retired field from lingering in the record forever.
 */
export function filterIntakeAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (INTAKE_FIELD_KEYS.has(key)) out[key] = value;
  }
  return out;
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
