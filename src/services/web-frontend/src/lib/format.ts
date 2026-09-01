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
 * The three maps above, read from a value typed as a plain `string`.
 *
 * Every one of these columns arrives from the API as `string` — `ProgressTab`'s
 * `progress.state`, the auditor bundle's `valuation.kind`, `SpecialtyTab`'s
 * `data.kind` — so indexing the `Record<ValuationState, string>` at the call
 * site takes a cast, and four call sites answered the reader with the raw
 * column value rather than write one. A client on the progress page was told
 * "This valuation is not progressing (state: draft_changes)" on the same screen
 * as a badge reading "Changes requested"; an external auditor's header said
 * `IFRS2 · draft_accepted`.
 *
 * Round 255 fixed the same thing on the server, where `stateLabel` is exactly
 * this function. The echo fallback is deliberate and matches it: a value the
 * enum has grown and this build has not is still a fact the reader needs.
 */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as ValuationKind] ?? kind;
}

export function stateLabel(state: string): string {
  return STATE_LABELS[state as ValuationState] ?? state;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

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

/**
 * A picked calendar day as the two instants that bound it, **locally**.
 *
 * A date picker hands back `YYYY-MM-DD`, and the log rows it filters are
 * timestamps rendered through `formatDateTime` — i.e. in the reader's own zone.
 * So the window has to be the reader's day, and turning the picked day into an
 * instant is where that goes wrong: `from=2026-02-14` reaches the server as UTC
 * midnight and `to=2026-02-14T23:59:59Z` as UTC end-of-day, which in New York
 * is 14 Feb 19:00 through 14 Feb 18:59 — a window that starts on the evening of
 * the 13th and ends five hours before the day the operator asked about is over.
 *
 * The visible half is the end: an admin event written at 20:00 local on the
 * 14th is 01:00Z on the 15th, so filtering "to the 14th" hid rows the same page
 * displays as the 14th. On an append-only log consulted to answer "was this
 * touched after the board adopted it", an event that is not in the answer reads
 * as an event that did not happen.
 *
 * `end` is the last millisecond of the day rather than `23:59:59`, because the
 * bound is inclusive and a row written in the final second of a local day is
 * still in that day.
 */
export function localDayStart(iso: string): string | null {
  const day = parseDateInput(iso);
  return day && DATE_ONLY.test(iso) ? day.toISOString() : null;
}

export function localDayEnd(iso: string): string | null {
  const day = parseDateInput(iso);
  if (!day || !DATE_ONLY.test(iso)) return null;
  const end = new Date(day.getTime());
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
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
 * Decimal places a per-share conclusion is stated to.
 *
 * The engine rounds `fmv_per_share` to four (`engine/compute.py`) and every
 * server-side rendering of it is struck at exactly four. Named rather than
 * written as a literal at each call site because the client and the server have
 * to agree on it, and a shared name is what makes a future change to one of
 * them visibly a change to a contract. See {@link formatPerShare}.
 */
export const PER_SHARE_DIGITS = 4;

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
/**
 * Built formatters, keyed by the arguments that built them.
 *
 * WHY THIS EXISTS (round 330, methodology M8). `Intl.NumberFormat` is expensive
 * to *construct* and cheap to call — measured here at 363 ms to build-and-format
 * twenty thousand values against 6.9 ms to format them through one instance, a
 * factor of fifty-three. Every function in this file built a fresh one per call,
 * and these are per-*cell* functions: a cap table of two hundred classes with
 * half a dozen money columns is thousands of constructions per render, and a
 * re-render does all of it again.
 *
 * Bounded, and not because currencies are unbounded — the platform's are a
 * closed set — but because the key carries caller-supplied options, and an
 * unbounded module-level map is a leak that only shows up in a long session.
 * Sixty-four is far above the handful of (currency, options) pairs the app
 * actually uses; past it the cache is cleared rather than evicted one at a time,
 * which keeps this to a Map and a size check.
 *
 * Locale is not part of the key because it is not part of the input: every
 * construction here passes `undefined`, which resolves to the browser's locale
 * and does not change within a page's lifetime.
 */
const formatterCache = new Map<string, (value: number) => string>();
const MAX_CACHED_FORMATTERS = 64;

/** Stable across key order, since the options come from object literals. */
function formatterKey(code: string, options: Intl.NumberFormatOptions): string {
  const parts = Object.entries(options)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${String(v)}`);
  return `${code}|${parts.join(',')}`;
}

export function moneyFormatter(
  currency: string | null | undefined,
  options: Intl.NumberFormatOptions = {},
): (value: number) => string {
  const code = (currency || 'USD').trim();
  const cacheKey = formatterKey(code, options);
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const format = buildMoneyFormatter(code, options);
  if (formatterCache.size >= MAX_CACHED_FORMATTERS) formatterCache.clear();
  formatterCache.set(cacheKey, format);
  return format;
}

function buildMoneyFormatter(code: string, options: Intl.NumberFormatOptions): (value: number) => string {
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
 * Money the payment processor charged, from the integer it reported.
 *
 * Distinct from {@link formatCents}, and the distinction is the whole point:
 * the two look identical and disagree about what the integer means.
 *
 *   - A `*_cents` column the app wrote holds hundredths of the major unit,
 *     because the form that produced it multiplied what the customer typed by
 *     100 (`FundingHistory.toCents`) whatever currency the engagement is in.
 *     {@link formatCents} divides by 100 and is right to.
 *   - A `*_cents` column Stripe wrote holds the *currency's own* minor unit,
 *     and not every currency has cents. The zero-decimal ones — JPY, KRW, VND,
 *     CLP, ISK — have no subdivision, so `amount: 100000` on a yen charge is
 *     ¥100,000. Dividing by 100 told the customer they had been charged a
 *     hundredth of what they were, and gave the yen two decimal places it does
 *     not have. The three-decimal currencies (BHD, JOD, KWD, OMR, TND) came out
 *     at a tenth.
 *
 * So billing renders — payments, invoices, quotes, receipts — go through this
 * one, and valuation figures stay on `formatCents`. Same rule as the server's
 * `domain/billing.formatMoneyCents`, which has only ever had payment callers;
 * `format-money.test.ts` and `moneyScaleParity.test.ts` hold the pair to one
 * table.
 */
export function formatChargedCents(
  minorUnits: string | number | null | undefined,
  currency: string | null = 'USD',
): string {
  if (minorUnits === null || minorUnits === undefined || minorUnits === '') return '—';
  const n = Number(minorUnits);
  if (!Number.isFinite(n)) return '—';
  return moneyFormatter(currency)(n / minorUnitScale(currency));
}

/**
 * How many minor units make one major unit of `currency`, read off `Intl` — it
 * carries the exponent per currency, and a list kept here would drift from the
 * server's. Its default for a well-formed code it does not recognise is two,
 * which is the same assumption the divide-by-100 made and the right one to keep.
 */
const scaleCache = new Map<string, number>();

function minorUnitScale(currency: string | null | undefined): number {
  // Same construction cost as `moneyFormatter`'s, and `formatCents` pays both
  // on every cell — one to learn the scale and one to render the result.
  const code = (currency || 'USD').trim();
  const cached = scaleCache.get(code);
  if (cached !== undefined) return cached;
  const scale = readMinorUnitScale(code);
  if (scaleCache.size >= MAX_CACHED_FORMATTERS) scaleCache.clear();
  scaleCache.set(code, scale);
  return scale;
}

function readMinorUnitScale(code: string): number {
  try {
    const digits = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
    // Typed optional, always present for `style: 'currency'`; cents if not.
    return digits === undefined ? 100 : 10 ** digits;
  } catch {
    // An unparseable code — `moneyFormatter` prints the amount beside it, and
    // cents is the only scale left to assume.
    return 100;
  }
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

/** Built once — see {@link formatterCache} for why that is worth saying. */
const plainNumberFormat = new Intl.NumberFormat();

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? plainNumberFormat.format(n) : '—';
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

/**
 * The concluded fair market value of one share, at the precision it was
 * concluded at.
 *
 * The engine rounds `fmv_per_share` to four decimal places and every server-side
 * rendering of it is struck at exactly four — the report body's
 * `{{fmv_per_share}}`, the executive summary's headline, Exhibit H's last line,
 * the FMV-over-time chart, and the workbook's `pershare` cell format. That is
 * not a house style: a 409A's whole output is one number, and the fourth
 * decimal is inside it. A grant priced off a $2.5013 conclusion is not priced
 * off $2.50.
 *
 * The app printed it five different ways, and none of them agreed with the
 * deliverable:
 *
 *   - `formatMoney` (dashboard, scenarios, package) drops to *zero* decimals
 *     once the figure reaches 100, so a $124.5678 conclusion read "$125" —
 *     rounded up, on the accented headline card;
 *   - the auditor portal and the portfolio table struck it at two, so the
 *     external reviewer checking the conclusion saw a different number from the
 *     PDF they were checking it against;
 *   - the bridge and the analytics trend struck it at two *and* hard-coded a
 *     dollar sign, so a sterling engagement's per-share walk was denominated in
 *     a currency it was never computed in.
 *
 * So it is stated once here. Four decimals, always — a trailing zero is
 * information on a figure whose last digit is load-bearing — and the
 * engagement's own currency, which is never inferred.
 *
 * This is for the *concluded per-share value* only. Aggregates (equity value,
 * invested amounts) keep {@link formatAmount} and `formatMoney`: widening those
 * to four decimals pads six-figure totals with digits nobody reads.
 */
export function formatPerShare(
  value: string | number | null | undefined,
  currency: string | null = 'USD',
): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return moneyFormatter(currency, {
    minimumFractionDigits: PER_SHARE_DIGITS,
    maximumFractionDigits: PER_SHARE_DIGITS,
  })(n);
}

/**
 * A concluded rate, at the precision it was concluded at.
 *
 * The server states DLOM and DLOC on the summary page, in the body figures and
 * on Exhibit H through `reportSummary.formatExactPercent`: enough decimals that
 * the reader multiplying by what they read reproduces the figure beside it, and
 * no more. The browser's calculation panel struck the same rate at one decimal,
 * so a run concluding a 31.42% DLOM showed "31.4%" on the screen the analyst
 * reads the result from and "31.42%" in the PDF generated from that same run —
 * the app disagreeing with its own report about the rate that was applied.
 *
 * Same rule as the server's, restated here because the two halves of one figure
 * must not disagree about how exact it is (see also {@link formatPerShare}).
 * `clientServerParity.test.ts` pins the pair.
 */
export function formatExactPercent(
  fraction: number | string | null | undefined,
  minDigits = 1,
  maxDigits = 4,
): string {
  if (fraction === null || fraction === undefined || fraction === '') return '—';
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '—';
  const pct = n * 100;
  for (let d = minDigits; d < maxDigits; d += 1) {
    // Exact at this many places — no rounding the reader cannot undo.
    if (Math.abs(Number(pct.toFixed(d)) - pct) < 1e-9) return `${pct.toFixed(d)}%`;
  }
  return `${pct.toFixed(maxDigits)}%`;
}
