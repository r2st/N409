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
