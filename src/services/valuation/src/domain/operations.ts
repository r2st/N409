/**
 * Milestone 3 — Operations domain constants and pure helpers.
 * Kept separate from domain/valuation.ts (M1/M2 edit that file in parallel).
 */
import type { ValuationState } from './valuation.js';

export const COMMENT_KINDS = ['chat', 'note', 'email'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** Event types M3 writes to the audit spine. */
export const OPERATIONS_EVENT_TYPES = {
  commentAdded: 'comment_added',
  emailReceived: 'email_received',
  cloned: 'valuation_cloned',
} as const;

/**
 * Tabbed list scopes (feature 15) — the same state groups the dashboard uses
 * (features.md §3.1), materialised server-side so tabs can show live counts.
 */
export const STATE_GROUPS = {
  open: ['pending', 'started', 'onboarding_completed', 'user_finished', 'completed'],
  in_review: ['review', 'reviewed'],
  drafted: ['drafted', 'draft_accepted', 'draft_changes'],
  published: ['published'],
  closed: ['timeout', 'cancelled', 'ignored'],
} as const satisfies Record<string, readonly ValuationState[]>;

export type StateGroup = keyof typeof STATE_GROUPS;
export const STATE_GROUP_KEYS = Object.keys(STATE_GROUPS) as StateGroup[];

export function stateGroupOf(state: ValuationState): StateGroup {
  for (const key of STATE_GROUP_KEYS) {
    if ((STATE_GROUPS[key] as readonly string[]).includes(state)) return key;
  }
  return 'closed';
}

const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;
const NUMBER_REF_RE = /#(\d{1,12})\b/;

/**
 * Extract a valuation reference from an inbound email subject:
 * a ULID anywhere in the subject, or a "#123" engagement number.
 */
export function parseEmailSubjectRef(subject: string): { id?: string; number?: number } {
  const id = ULID_RE.exec(subject.toUpperCase())?.[0];
  if (id) return { id };
  const num = NUMBER_REF_RE.exec(subject)?.[1];
  if (num) return { number: Number(num) };
  return {};
}
