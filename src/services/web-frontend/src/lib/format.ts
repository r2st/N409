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
  fund: 'ASC 820 Fund',
  debt: 'Debt / Credit',
};

export const STATE_LABELS: Record<ValuationState, string> = {
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

export type StateTone = 'neutral' | 'progress' | 'attention' | 'success' | 'muted';

export const STATE_TONES: Record<ValuationState, StateTone> = {
  pending: 'neutral',
  started: 'progress',
  onboarding_completed: 'progress',
  user_finished: 'progress',
  completed: 'progress',
  paid: 'progress',
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
  if (['pending', 'started', 'onboarding_completed', 'user_finished', 'completed', 'paid'].includes(state))
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

/**
 * Money formatting that cannot take the render down.
 *
 * `Intl.NumberFormat` throws a *RangeError* for a currency that is not three
 * letters — `"123"`, `"$$$"` — and the code comes from a row, not from us. The
 * API used to accept those (a `length(3)` check is not a code check), so rows
 * carrying one predate the fix and will outlive it. A thrown formatter inside
 * render is not a mis-formatted cell: it unmounts the tree to the nearest error
 * boundary, so an unrenderable currency code took out the whole page rather
 * than one number on it.
 *
 * The fallback prints the amount with the code beside it, which is what `Intl`
 * itself does for a well-formed code it does not recognise.
 */
export function moneyFormatter(
  currency: string | null | undefined,
  options: Intl.NumberFormatOptions = {},
): (value: number) => string {
  const code = (currency || 'USD').trim();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, ...options }).format;
  } catch {
    // Only default the fraction digits when the caller pinned neither: merging
    // a default `minimumFractionDigits: 2` under a caller's
    // `maximumFractionDigits: 0` gives min > max, which is itself a RangeError
    // — the fallback would throw exactly where it is meant to stop throwing.
    const digitsGiven =
      options.minimumFractionDigits !== undefined || options.maximumFractionDigits !== undefined;
    const plain = new Intl.NumberFormat(
      undefined,
      digitsGiven ? options : { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    );
    return (value: number) => `${code} ${plain.format(value)}`;
  }
}

/** Renders integer cents as money, e.g. 250050 → "$2,500.50" (M4). */
export function formatMoney(
  cents: string | number | null | undefined,
  currency: string | null = 'USD',
): string {
  if (cents === null || cents === undefined || cents === '') return '—';
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  return moneyFormatter(currency, { minimumFractionDigits: 2 })(n / 100);
}

/**
 * Renders a major-unit amount as money, e.g. 2500.5 → "$2,500.50".
 *
 * Most of the app stores money as integer cents and uses {@link formatMoney}.
 * Figures that arrive from a customer's own spreadsheet — cap-table share
 * prices and invested amounts — are dollars as typed, so they need this
 * instead; running them through formatMoney renders them 100× too small.
 *
 * Share prices are commonly sub-cent (a $0.0001 common par value), so the
 * fraction digits widen for small amounts rather than flattening them to $0.00.
 */
export function formatAmount(
  amount: string | number | null | undefined,
  currency: string | null = 'USD',
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const small = n !== 0 && Math.abs(n) < 1;
  return moneyFormatter(currency, {
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 6 : 2,
  })(n);
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat().format(n) : '—';
}

/**
 * English ordinal for a whole number — "1st", "22nd", "63rd", "11th".
 *
 * The analytics benchmark used to hardcode "th", which rendered a company at
 * the 62nd percentile as sitting at the "62th". That sentence gets read aloud
 * in board meetings and pasted into decks, so the suffix is worth deriving:
 * 11–13 take "th" regardless of their last digit, everything else follows it.
 */
export function ordinal(n: number): string {
  const i = Math.trunc(n);
  const abs = Math.abs(i);
  const suffix =
    abs % 100 >= 11 && abs % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[abs % 10] ?? 'th');
  return `${i}${suffix}`;
}

export function displayName(u: {
  first_name: string | null;
  last_name: string | null;
  email: string;
}): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return name || u.email;
}

export function initials(u: { first_name: string | null; last_name: string | null; email: string }): string {
  const a = u.first_name?.[0] ?? u.email[0] ?? '?';
  const b = u.last_name?.[0] ?? '';
  return (a + b).toUpperCase();
}

/*
 * ── Event labels ────────────────────────────────────────────────────────────
 *
 * The audit trail is append-only and the services add event types faster than
 * any hand-written map keeps up with: they record some fifty distinct types,
 * and the two screens that showed them named twenty between them. The rest
 * reached the reader as `company_profile_updated`.
 *
 * So the default is derived rather than declared — snake_case to a sentence —
 * and the map below holds only the ones where that reads wrong: an initialism
 * a sentence-caser would swallow (QA, AI, PDF), or a phrase wanting words the
 * key does not carry ("Cloned from another valuation").
 *
 * A new event type therefore arrives readable with no frontend change, and the
 * map stays short enough to be worth reading.
 */
const EVENT_LABELS: Record<string, string> = {
  valuation_created: 'Valuation created',
  valuation_updated: 'Details updated',
  valuation_cloned: 'Cloned from another valuation',
  state_changed: 'State changed',
  overwrite_applied: 'Override applied',
  overwrite_reverted: 'Override reverted',
  report_saved: 'Report saved',
  report_reverted: 'Report version restored',
  report_rendered: 'Report PDF rendered',
  qa_review_completed: 'QA review completed',
  ai_job_completed: 'AI job completed',
  params_updated: 'Methodology updated',
  cap_table_imported: 'Cap table imported',
  review_task_created: 'Review task created',
  review_task_updated: 'Review task updated',
  health_checks_run: 'Health checks run',
  auto_pipeline_started: 'Automatic pipeline started',
  auto_pipeline_completed: 'Automatic pipeline completed',
  auto_pipeline_failed: 'Automatic pipeline failed',
  auto_pipeline_toggled: 'Automatic pipeline toggled',
  engagement_overdue_reminder: 'Overdue reminder sent',
};

/**
 * A human-readable name for an audit event type. Unknown types are
 * sentence-cased from the key rather than shown raw, so an event this build
 * has never heard of still reads as English.
 */
export function eventLabel(type: string): string {
  const known = EVENT_LABELS[type];
  if (known) return known;
  const words = type.replace(/[._]+/g, ' ').trim();
  if (words === '') return type;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
