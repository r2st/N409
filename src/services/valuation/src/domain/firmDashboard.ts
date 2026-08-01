import { stateGroupOf, type StateGroup } from './operations.js';
import type { ValuationState } from './valuation.js';

/**
 * Firm dashboard — what the principal of a valuation firm needs to see across
 * every client engagement at once.
 *
 * The counts are SQL's job; this module owns the part that is a judgement:
 * which engagements need a human today, and why. A firm running eighty live
 * 409As does not want a list of eighty — it wants the six that are late, stuck
 * with the client, or sitting in review with nobody's name on them.
 *
 * All of it is pure and takes `now` explicitly, so the rules can be tested at
 * the boundaries rather than only on whatever day the suite happens to run.
 */

/** A due date inside this window is "coming up" rather than merely scheduled. */
export const DUE_SOON_DAYS = 7;
/** Waiting on the client this long is a chase, not a wait. */
export const STALE_WAITING_DAYS = 14;
/** In review with no movement this long has usually fallen off someone's list. */
export const STALE_REVIEW_DAYS = 10;

export const ATTENTION_REASONS = [
  'overdue',
  'unassigned',
  'stalled_with_client',
  'stalled_in_review',
  'due_soon',
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];
export type Severity = 'high' | 'medium';

/** The columns the attention rules read. Mirrors the repo's SELECT. */
export interface FirmValuationRow {
  id: string;
  number: number;
  company_name: string;
  state: ValuationState;
  due_date: string | null;
  waiting_on_client: boolean;
  assigned_reviewer_id: string | null;
  assigned_reviewer_name: string | null;
  created_at: string;
  /** Last client/analyst message — the best available "something happened". */
  last_comment_at: string | null;
}

export interface AttentionItem {
  id: string;
  number: number;
  company_name: string;
  state: ValuationState;
  state_group: StateGroup;
  due_date: string | null;
  assigned_reviewer_id: string | null;
  assigned_reviewer_name: string | null;
  reason: AttentionReason;
  severity: Severity;
  /** Days late, days until due, or days since anything happened — per reason. */
  days: number;
  detail: string;
}

const DAY_MS = 86_400_000;

/** Whole days between two instants, floored — 25 hours late is "1 day late". */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Why this engagement needs attention, or null if it does not.
 *
 * One reason per engagement, in the order a firm would triage: something late
 * outranks something merely unowned, which outranks something stuck. Anything
 * published or closed is finished work and is never flagged, however stale its
 * timestamps look.
 */
export function classifyAttention(row: FirmValuationRow, now: Date): AttentionItem | null {
  const group = stateGroupOf(row.state);
  if (group === 'published' || group === 'closed') return null;

  const base = {
    id: row.id,
    number: row.number,
    company_name: row.company_name,
    state: row.state,
    state_group: group,
    due_date: row.due_date,
    assigned_reviewer_id: row.assigned_reviewer_id,
    assigned_reviewer_name: row.assigned_reviewer_name,
  };

  const due = row.due_date ? new Date(row.due_date) : null;
  if (due && due.getTime() < now.getTime()) {
    const days = daysBetween(due, now);
    return {
      ...base,
      reason: 'overdue',
      severity: 'high',
      days,
      detail: days === 0 ? 'Due date passed today' : `${plural(days, 'day')} past due`,
    };
  }

  // An engagement in review or drafting with nobody's name on it is the failure
  // mode a firm cannot see from any single valuation's own page.
  if ((group === 'in_review' || group === 'drafted') && !row.assigned_reviewer_id) {
    return {
      ...base,
      reason: 'unassigned',
      severity: 'high',
      days: daysBetween(new Date(row.created_at), now),
      detail: 'No reviewer assigned',
    };
  }

  // "Waiting on the client" is a legitimate state until it stops being one.
  const lastActivity = new Date(row.last_comment_at ?? row.created_at);
  const idle = daysBetween(lastActivity, now);
  if (row.waiting_on_client && idle >= STALE_WAITING_DAYS) {
    return {
      ...base,
      reason: 'stalled_with_client',
      severity: 'medium',
      days: idle,
      detail: `Waiting on the client, no contact in ${plural(idle, 'day')}`,
    };
  }

  if (group === 'in_review' && idle >= STALE_REVIEW_DAYS) {
    return {
      ...base,
      reason: 'stalled_in_review',
      severity: 'medium',
      days: idle,
      detail: `In review with no activity for ${plural(idle, 'day')}`,
    };
  }

  if (due) {
    const days = daysBetween(now, due);
    if (days <= DUE_SOON_DAYS) {
      return {
        ...base,
        reason: 'due_soon',
        severity: 'medium',
        days,
        detail: days === 0 ? 'Due today' : `Due in ${plural(days, 'day')}`,
      };
    }
  }

  return null;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1 };
const REASON_RANK: Record<AttentionReason, number> = Object.fromEntries(
  ATTENTION_REASONS.map((r, i) => [r, i]),
) as Record<AttentionReason, number>;

/**
 * The triage queue: worst first.
 *
 * `days` sorts descending for everything except `due_soon`, where a small
 * number is the urgent one — due tomorrow beats due next week.
 */
export function rankAttention(rows: FirmValuationRow[], now: Date, limit?: number): AttentionItem[] {
  const items = rows
    .map((row) => classifyAttention(row, now))
    .filter((item): item is AttentionItem => item !== null)
    .sort((a, b) => {
      if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (a.reason !== b.reason) return REASON_RANK[a.reason] - REASON_RANK[b.reason];
      if (a.days !== b.days) return a.reason === 'due_soon' ? a.days - b.days : b.days - a.days;
      return a.number - b.number;
    });
  return limit === undefined ? items : items.slice(0, limit);
}

/** How many of each reason are outstanding — the dashboard's headline chips. */
export function countByReason(items: AttentionItem[]): Record<AttentionReason, number> {
  const counts = Object.fromEntries(ATTENTION_REASONS.map((r) => [r, 0])) as Record<AttentionReason, number>;
  for (const item of items) counts[item.reason] += 1;
  return counts;
}
