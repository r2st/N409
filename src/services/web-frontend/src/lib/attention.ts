import { stateGroup } from './format';
import type { Valuation } from './types';

/**
 * What on this dashboard needs a human today.
 *
 * The dashboard already loads the viewer's valuations, and every fact this
 * needs — due date, waiting-on-client, unread — is on that list. So this is a
 * pure ranking over data already in hand rather than another endpoint, and it
 * takes `now` explicitly so the boundaries (due today vs. one day late) are
 * testable rather than dependent on the day the suite runs.
 *
 * Deliberately not the firm console's ranking (valuation/domain/firmDashboard).
 * That one triages a book of work for a principal — unowned, stalled in review.
 * This one answers a different question for the person whose valuation it is:
 * what is late, what is being held up by me, and what has moved since I looked.
 */

/** A due date inside this window is "coming up" rather than merely scheduled. */
export const DUE_SOON_DAYS = 7;

export const ATTENTION_REASONS = ['overdue', 'action_needed', 'due_soon', 'new_activity'] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];
export type Severity = 'high' | 'medium';

export interface AttentionItem {
  id: string;
  company_name: string;
  state: Valuation['state'];
  kind: Valuation['kind'];
  reason: AttentionReason;
  severity: Severity;
  /** Days late or days until due; 0 where the reason has no clock. */
  days: number;
  /** The date-derived half of the row. The reason's wording is the caller's. */
  detail: string;
}

const DAY_MS = 86_400_000;

/**
 * A `YYYY-MM-DD` due date as local midnight.
 *
 * `new Date('2026-08-01')` parses as UTC midnight, which west of Greenwich is
 * the previous day locally — so a valuation due today would render as one day
 * overdue for anyone in the Americas. The parts are therefore read explicitly.
 */
function localDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole calendar days from `now` to `due`; negative once the date has passed. */
function daysUntil(due: Date, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / DAY_MS);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Worst first. Ties inside a reason go to whichever has run longest. */
const REASON_RANK: Record<AttentionReason, number> = {
  overdue: 0,
  action_needed: 1,
  due_soon: 2,
  new_activity: 3,
};

/**
 * Why this valuation needs attention, or null if it does not.
 *
 * One reason per valuation, in the order the person holding it would act:
 * something late outranks something they are personally holding up, which
 * outranks something merely approaching, which outranks something that simply
 * moved.
 *
 * Closed work is never flagged. Published work is flagged only for new
 * activity: a delivered report is not "late", but a message left on it still
 * wants a reply, and dropping it entirely is how those go unanswered.
 */
export function classifyAttention(valuation: Valuation, now: Date): AttentionItem | null {
  const group = stateGroup(valuation.state);
  if (group === 'closed') return null;

  const base = {
    id: valuation.id,
    company_name: valuation.company_name,
    state: valuation.state,
    kind: valuation.kind,
  };

  if (group === 'published') {
    return valuation.unread
      ? {
          ...base,
          reason: 'new_activity',
          severity: 'medium',
          days: 0,
          detail: 'New activity since you last looked',
        }
      : null;
  }

  const due = valuation.due_date ? localDate(valuation.due_date) : null;
  const days = due ? daysUntil(due, now) : null;

  if (days !== null && days < 0) {
    return {
      ...base,
      reason: 'overdue',
      severity: 'high',
      days: -days,
      detail: `${plural(-days, 'day')} past due`,
    };
  }
  if (valuation.waiting_on_client) {
    return {
      ...base,
      reason: 'action_needed',
      severity: 'high',
      days: 0,
      detail: 'Held up pending information',
    };
  }
  if (days !== null && days <= DUE_SOON_DAYS) {
    return {
      ...base,
      reason: 'due_soon',
      severity: 'medium',
      days,
      detail: days === 0 ? 'Due today' : `Due in ${plural(days, 'day')}`,
    };
  }
  if (valuation.unread) {
    return {
      ...base,
      reason: 'new_activity',
      severity: 'medium',
      days: 0,
      detail: 'New activity since you last looked',
    };
  }
  return null;
}

/**
 * Everything needing attention, worst first.
 *
 * The sort is total and deterministic — reason, then how long it has run, then
 * company name — so the same book of work ranks the same way on every load
 * rather than inheriting whatever order the list endpoint returned.
 */
export function attentionItems(valuations: readonly Valuation[], now: Date): AttentionItem[] {
  return valuations
    .map((valuation) => classifyAttention(valuation, now))
    .filter((item): item is AttentionItem => item !== null)
    .sort((a, b) => {
      if (a.reason !== b.reason) return REASON_RANK[a.reason] - REASON_RANK[b.reason];
      // Within overdue, the latest first; within due_soon, the soonest first.
      if (a.days !== b.days) return a.reason === 'due_soon' ? a.days - b.days : b.days - a.days;
      return a.company_name.localeCompare(b.company_name);
    });
}
