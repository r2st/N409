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

/**
 * A calendar day, spelled `YYYY-MM-DD` and nothing else.
 *
 * Anchored at both ends on purpose: a timestamp *starts* with this shape, and
 * matching it there would take the UTC date parts of a real instant and read
 * them as local ones — which is the same error in the other direction.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date string as a Date, with a calendar day kept a calendar day.
 *
 * `new Date('2026-03-15')` is specified to parse the date-only form as **UTC
 * midnight**, and `toLocaleDateString` then renders whatever local day that
 * instant falls on. West of Greenwich it is the day before: in California the
 * funding round that closed on the 15th displayed as the 14th, and an intake
 * date the client typed came back to them as the day before they typed it.
 *
 * That is the live half of the bug rather than the theoretical one — a 409A
 * platform's market is the United States, so the affected zone is the ordinary
 * case and UTC is the exception. It is also invisible: an off-by-one date looks
 * exactly like a date.
 *
 * The valuation service already refuses to route these through UTC on the way
 * out (`domain/calendarDate.ts` — a Postgres `date` is a day, not an instant,
 * and it is serialised from its local parts). This is the same rule on the way
 * in. Everything else — a `timestamptz`, anything carrying a time or a zone —
 * is a real instant and is parsed as one, unchanged.
 */
function parseDateInput(iso: string): Date | null {
  const day = DATE_ONLY.exec(iso);
  if (!day) {
    const instant = new Date(iso);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const local = new Date(y, m - 1, d);
  // Two-digit years are mapped into 1900–1999 by the Date constructor, and the
  // pattern above admits `0026-01-01`.
  local.setFullYear(y);
  // The constructor rolls an out-of-range day forward rather than refusing it,
  // so `2026-02-30` would render as March 2nd. Reading the parts back is what
  // keeps a nonsense date looking like one.
  if (local.getFullYear() !== y || local.getMonth() !== m - 1 || local.getDate() !== d) return null;
  return local;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseDateInput(iso);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseDateInput(iso);
  if (!d) return '—';
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

/**
 * Renders integer *minor* units as money, e.g. 250050 → "$2,500.50" (M4).
 *
 * It was called `formatMoney`, and so is a second, unrelated formatter in
 * `lib/pipeline.ts` that takes the currency's own units and does not divide.
 * Two exports of one name with opposite unit contracts is a hundredfold error
 * that reads as an import line: GrantsTab and Asc718Tab picked this one for
 * figures that were never in cents, and reported a $2.50 option strike as
 * $0.03 for as long as they existed. The unit is in the name now — every
 * caller of this one passes a field spelled `*_cents`, and a call site that
 * does not is visibly wrong.
 */
export function formatCents(
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
 * Most of the app stores money as integer cents and uses {@link formatCents}.
 * Figures that arrive from a customer's own spreadsheet — cap-table share
 * prices and invested amounts — are dollars as typed, so they need this
 * instead; running them through formatCents renders them 100× too small.
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
 * There used to be a hand-written map here, naming some twenty of the fifty-odd
 * event types the services record. It had drifted from the catalog the
 * valuation service reads for the change log, so the same row was "State
 * changed" on the valuation timeline and "Stage changed" in the change log,
 * "Report PDF rendered" here and "Report generated" there. Two screens, one
 * event, two names — a difference nobody would file a bug about and everybody
 * would notice.
 *
 * The label now travels with the row (`domain/auditTrail.ts` decides it, once).
 * What is left here is the fallback for a payload that carries none — an older
 * cached response, or an endpoint that has not been given one — and it is the
 * same derivation the server falls back to: snake_case to a sentence.
 */

/**
 * A human-readable name for an audit event type.
 *
 * Prefer the `label` the API sends. This is what to print when there is none.
 */
export function eventLabel(type: string): string {
  const words = type.replace(/[._]+/g, ' ').trim();
  if (words === '') return type;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
