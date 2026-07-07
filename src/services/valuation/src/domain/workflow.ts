import type { ValuationState } from './valuation.js';

/**
 * Workflow engine (M4, feature-gap-analysis P1 #22). Pure state-machine layer:
 * which transitions are legal, what the happy-path "next" state is, and where
 * a restart lands. No I/O — the route layer applies the transition via
 * patchValuation so the audit events stay intact.
 */

/** Legal transitions out of each state (features.md §lifecycle). */
export const WORKFLOW_TRANSITIONS: Record<ValuationState, readonly ValuationState[]> = {
  pending: ['started', 'cancelled', 'ignored', 'timeout'],
  started: ['onboarding_completed', 'cancelled', 'ignored', 'timeout'],
  onboarding_completed: ['user_finished', 'cancelled', 'timeout'],
  user_finished: ['completed', 'cancelled', 'timeout'],
  completed: ['review', 'cancelled'],
  review: ['reviewed', 'draft_changes', 'cancelled'],
  reviewed: ['drafted', 'review', 'cancelled'],
  drafted: ['draft_accepted', 'draft_changes', 'cancelled'],
  draft_changes: ['review', 'drafted', 'cancelled'],
  draft_accepted: ['published', 'cancelled'],
  published: [],
  timeout: ['started'],
  cancelled: ['started'],
  ignored: ['started'],
};

/** Happy-path auto-advance target, or null when the state needs a human fork. */
export const AUTO_ADVANCE: Partial<Record<ValuationState, ValuationState>> = {
  pending: 'started',
  started: 'onboarding_completed',
  onboarding_completed: 'user_finished',
  user_finished: 'completed',
  completed: 'review',
  review: 'reviewed',
  reviewed: 'drafted',
  drafted: 'draft_accepted',
  draft_accepted: 'published',
};

/** Where a restarted valuation lands, regardless of its current state. */
export const RESTART_STATE: ValuationState = 'started';

/** States a valuation cannot be restarted out of. */
const RESTART_FORBIDDEN: ReadonlySet<ValuationState> = new Set(['published']);

export function canTransition(from: ValuationState, to: ValuationState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function nextState(from: ValuationState): ValuationState | null {
  return AUTO_ADVANCE[from] ?? null;
}

export function canRestart(from: ValuationState): boolean {
  return !RESTART_FORBIDDEN.has(from) && from !== RESTART_STATE;
}

/** Bulk actions (P1 #23) accepted by POST /valuations/bulk. */
export const BULK_ACTIONS = ['set_state', 'assign_reviewer', 'advance', 'restart'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
