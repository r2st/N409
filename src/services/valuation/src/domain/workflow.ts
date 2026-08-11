import { isSettled, type PaidStatus, type ValuationState } from './valuation.js';

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
  // `paid` is a gate a file may pass through, not one it must: partner-paid
  // and invoiced engagements go straight to review, so both edges are legal.
  completed: ['paid', 'review', 'cancelled'],
  paid: ['review', 'cancelled'],
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
  // Default only. `nextState` diverts to 'paid' when payment has settled —
  // this is the fallback for the engagements where it never will.
  completed: 'review',
  paid: 'review',
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

/**
 * The happy-path successor, or null where the state needs a human fork.
 *
 * `ctx.paidStatus` is what makes the `paid` gate real rather than decorative:
 * a settled file leaving `completed` records that it settled before it queues
 * for review. Without the context — or with money that never arrived — the
 * answer is the AUTO_ADVANCE default, which routes around the gate. That
 * fallback is not a nicety: production has no Stripe keys configured, so every
 * live valuation is `unpaid`, and a gate that defaulted to closed would strand
 * all of them at `completed`.
 */
export function nextState(from: ValuationState, ctx?: { paidStatus?: PaidStatus }): ValuationState | null {
  if (from === 'completed' && ctx?.paidStatus && isSettled(ctx.paidStatus)) return 'paid';
  return AUTO_ADVANCE[from] ?? null;
}

export function canRestart(from: ValuationState): boolean {
  return !RESTART_FORBIDDEN.has(from) && from !== RESTART_STATE;
}

// ── Named listing buckets (design §4.2) ──────────────────────────────────────

/**
 * The nine tabs the listing names, defined once.
 *
 * `STATE_GROUPS` in `domain/operations.ts` collapses fifteen states into five
 * lifecycle groups, which is the right shape for a dashboard pivot and the
 * wrong one for a worklist: an operator asking "what is stuck unverified" got
 * `user_finished` folded into `open` alongside six other states and had to
 * hand-write a filter on the most-used screen in the product.
 *
 * Both the count query and the list filter read this. Two copies of the mapping
 * would be two different answers to "how many are in progress", and the count
 * on the tab and the rows behind it would disagree — which is worse than not
 * having the tab.
 *
 * Two buckets are not state predicates at all and are marked so: `waiting_on_client`
 * is a boolean on the row that cuts across the lifecycle (a file can be drafted
 * *and* waiting on the client), and `unread` is per-reader. Both already exist
 * as filter keys; naming them as tabs is the whole change.
 */
export type NamedBucketKey =
  | 'all'
  | 'incomplete'
  | 'unverified'
  | 'in_progress'
  | 'waiting_on_client'
  | 'drafted'
  | 'published'
  | 'unread'
  | 'ignored';

export interface NamedBucketDef {
  key: NamedBucketKey;
  label: string;
  /** States the bucket contains; empty for the two non-state buckets. */
  states: readonly ValuationState[];
  /** True when the bucket is `waiting_on_client = true` rather than a state set. */
  waitingOnClient?: boolean;
  /** True when the bucket is "unread by this reader" rather than a state set. */
  unread?: boolean;
}

export const NAMED_BUCKETS: readonly NamedBucketDef[] = [
  { key: 'all', label: 'All', states: [] },
  {
    key: 'incomplete',
    label: 'Incomplete',
    states: ['pending', 'started', 'onboarding_completed'],
  },
  { key: 'unverified', label: 'Unverified', states: ['user_finished'] },
  {
    key: 'in_progress',
    label: 'In Progress',
    states: ['completed', 'paid', 'review', 'reviewed'],
  },
  { key: 'waiting_on_client', label: 'Waiting On Client', states: [], waitingOnClient: true },
  { key: 'drafted', label: 'Drafted', states: ['drafted', 'draft_changes', 'draft_accepted'] },
  { key: 'published', label: 'Published', states: ['published'] },
  { key: 'unread', label: 'Unread', states: [], unread: true },
  { key: 'ignored', label: 'Ignored', states: ['ignored', 'cancelled', 'timeout'] },
];

export const NAMED_BUCKET_KEYS = NAMED_BUCKETS.map((b) => b.key);

const BUCKETS_BY_KEY = new Map(NAMED_BUCKETS.map((b) => [b.key, b]));

export function namedBucket(key: string): NamedBucketDef | null {
  return BUCKETS_BY_KEY.get(key as NamedBucketKey) ?? null;
}

/**
 * Which state buckets a state falls into.
 *
 * A list, not a single answer: `all` always matches, and unlike `stateGroupOf`
 * there is no fallback bucket. A state that belongs to no named bucket is a
 * gap in the table above and shows up as a count that does not add up, which
 * is exactly what should happen — the `stateGroupOf` habit of defaulting an
 * unknown state to `closed` would file it silently under Ignored.
 */
export function namedBucketsFor(state: ValuationState): NamedBucketKey[] {
  const keys: NamedBucketKey[] = ['all'];
  for (const bucket of NAMED_BUCKETS) {
    if (bucket.states.includes(state)) keys.push(bucket.key);
  }
  return keys;
}

/** Bulk actions (P1 #23) accepted by POST /valuations/bulk. */
export const BULK_ACTIONS = ['set_state', 'assign_reviewer', 'advance', 'restart'] as const;

// ── Review decisions (P1 #6) ─────────────────────────────────────────────────

export const REVIEW_DECISIONS = ['approve', 'request_changes'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Where "request changes" sends a valuation back to, per the legality matrix
 * above. The keys double as the set of states a review decision applies to;
 * "approve" from any of them is the happy-path AUTO_ADVANCE target.
 */
export const REVIEW_SEND_BACK: Partial<Record<ValuationState, ValuationState>> = {
  review: 'draft_changes',
  reviewed: 'review',
  drafted: 'draft_changes',
};

/** Target state for a decision, or null when the state isn't decidable. */
export function decisionTarget(from: ValuationState, decision: ReviewDecision): ValuationState | null {
  const sendBack = REVIEW_SEND_BACK[from];
  if (!sendBack) return null;
  return decision === 'approve' ? (nextState(from) ?? null) : sendBack;
}
