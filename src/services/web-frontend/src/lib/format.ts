import type { ValuationKind, ValuationState } from './types';

export const KIND_LABELS: Record<ValuationKind, string> = {
  '409a': 'IRC §409A',
  fmv: 'Fair Market Value',
  '718': 'ASC 718',
  '820': 'ASC 820',
  gifts: 'Gift & Estate',
  qsbs: 'QSBS',
  csop: 'CSOP (UK)',
  emi: 'EMI (UK)',
  ifrs2: 'IFRS 2',
  ppa: 'Purchase Price Allocation',
  goodwill: 'Goodwill Impairment',
  esop: 'ESOP',
  ip: 'IP Valuation',
};

export const STATE_LABELS: Record<ValuationState, string> = {
  pending: 'Pending',
  started: 'Started',
  onboarding_completed: 'Onboarding done',
  user_finished: 'Client finished',
  completed: 'Completed',
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

export type StateTone = 'neutral' | 'progress' | 'attention' | 'success' | 'muted';

export const STATE_TONES: Record<ValuationState, StateTone> = {
  pending: 'neutral',
  started: 'progress',
  onboarding_completed: 'progress',
  user_finished: 'progress',
  completed: 'progress',
  review: 'attention',
  reviewed: 'attention',
  drafted: 'attention',
  draft_accepted: 'attention',
  draft_changes: 'attention',
  published: 'success',
  timeout: 'muted',
  cancelled: 'muted',
  ignored: 'muted',
};

/** Dashboard groupings, per features.md §3.1. */
export function stateGroup(state: ValuationState): 'open' | 'in_review' | 'drafted' | 'published' | 'closed' {
  if (['pending', 'started', 'onboarding_completed', 'user_finished', 'completed'].includes(state))
    return 'open';
  if (['review', 'reviewed'].includes(state)) return 'in_review';
  if (['drafted', 'draft_accepted', 'draft_changes'].includes(state)) return 'drafted';
  if (state === 'published') return 'published';
  return 'closed';
}

export const GROUP_LABELS: Record<string, string> = {
  all: 'All',
  open: 'Open',
  in_review: 'In review',
  drafted: 'Drafted',
  published: 'Published',
  closed: 'Closed',
};

export const SOURCE_LABELS: Record<string, string> = {
  partner: 'Partner',
  referral: 'Referral',
  ads: 'Ads',
  repeat: 'Repeat',
  direct: 'Direct',
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function displayName(u: { first_name: string | null; last_name: string | null; email: string }): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return name || u.email;
}

export function initials(u: { first_name: string | null; last_name: string | null; email: string }): string {
  const a = u.first_name?.[0] ?? u.email[0] ?? '?';
  const b = u.last_name?.[0] ?? '';
  return (a + b).toUpperCase();
}
