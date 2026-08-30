/** Valuation domain constants (features.md §lifecycle, database-design.md §2). */
export const VALUATION_KINDS = [
  '409a',
  'fmv',
  '718',
  '820',
  'gifts',
  'qsbs',
  'csop',
  'emi',
  'ifrs2',
  'ppa',
  'goodwill',
  'esop',
  'ip',
  'fund',
  'debt',
] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];

export const VALUATION_STATES = [
  'pending',
  'started',
  'onboarding_completed',
  'user_finished',
  'completed',
  'paid',
  'review',
  'reviewed',
  'drafted',
  'draft_accepted',
  'draft_changes',
  'published',
  'timeout',
  'cancelled',
  'ignored',
] as const;
export type ValuationState = (typeof VALUATION_STATES)[number];

/**
 * What each state is called in the sentences people read.
 *
 * The keys are column values — `onboarding_completed`, `draft_changes`,
 * `user_finished` — and eight refusals interpolated them straight into a
 * `detail`, so an operator who tried an illegal move was answered with "Illegal
 * transition draft_changes → published" and a comma-separated list of more of
 * the same. Nowhere else on the platform are those words shown: the browser has
 * carried `STATE_LABELS` since long before this, and every screen an operator
 * reaches this API from is already labelling the identical column "Changes
 * requested".
 *
 * `Record<ValuationState, string>` rather than a lookup with a fallback, so a
 * fifteenth state is a compile error here rather than a raw key surfacing in a
 * refusal months later. The values are pinned against the browser's map by
 * `valuationStateLabels.test.ts` — web-frontend does not depend on
 * `@n409/shared`, so the two maps are copies, and a copy nothing compares is a
 * copy that drifts.
 */
export const VALUATION_STATE_LABELS: Record<ValuationState, string> = {
  pending: 'Pending',
  started: 'Started',
  onboarding_completed: 'Onboarding done',
  user_finished: 'Client finished',
  completed: 'Completed',
  paid: 'Paid',
  review: 'In review',
  reviewed: 'Reviewed',
  drafted: 'Drafted',
  draft_accepted: 'Draft accepted',
  draft_changes: 'Changes requested',
  published: 'Published',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
  ignored: 'Ignored',
};

/** A state as an operator sees it named everywhere else. */
export function stateLabel(state: ValuationState): string {
  return VALUATION_STATE_LABELS[state];
}

export const VALUATION_SOURCES = ['partner', 'referral', 'ads', 'repeat'] as const;
export type ValuationSource = (typeof VALUATION_SOURCES)[number];

/**
 * Commercial settlement, orthogonal to lifecycle state (migration 0001's
 * `paid_status` enum). `paid_by_partner` is settled money the client never
 * saw an invoice for, so it gates the same doors `paid` does.
 */
export const PAID_STATUSES = ['unpaid', 'paid', 'paid_by_partner'] as const;
export type PaidStatus = (typeof PAID_STATUSES)[number];

/** Whether money has actually arrived, by whichever route. */
export function isSettled(status: PaidStatus): boolean {
  return status !== 'unpaid';
}

/** Event types written to the append-only audit spine (M0 + M2). */
export const EVENT_TYPES = {
  created: 'valuation_created',
  updated: 'valuation_updated',
  stateChanged: 'state_changed',
  // M2 — output & delivery
  overwriteApplied: 'overwrite_applied',
  overwriteReverted: 'overwrite_reverted',
  workbookUpdated: 'workbook_updated',
  reportSaved: 'report_saved',
  reportReverted: 'report_reverted',
  reportRendered: 'report_rendered',
} as const;
