import type { ValuationState } from './types';

/** M2 API types — mirror the valuation service's overwrites/workbook/report payloads. */

// ── Overwrites ────────────────────────────────────────────────────────────────

export type OverwriteClass = 'numeric' | 'date' | 'character';

export interface OverwriteFieldDef {
  key: string;
  category: string;
  class: OverwriteClass;
  label: string;
  description: string;
  min?: number;
  max?: number;
  example: string | number;
}

export interface OverwriteSchema {
  categories: Array<{ key: string; field_count: number }>;
  fields: OverwriteFieldDef[];
  total: number;
}

export interface Overwrite {
  id: string;
  valuation_id: string;
  category: string;
  field_key: string;
  class: OverwriteClass;
  value: unknown;
  original_value: unknown;
  reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export const OVERWRITE_CATEGORY_LABELS: Record<string, string> = {
  company_info: 'Company Information',
  financial_metrics: 'Financial Metrics',
  forecasts: 'Forecasts & Projections',
  valuation_params: 'Valuation Parameters',
  market_comparables: 'Market & Comparables',
  reporting: 'Reporting & Filing',
};

// ── Workbook ──────────────────────────────────────────────────────────────────

export type WorkbookFormat = 'currency' | 'number' | 'percent';

export interface WorkbookSheet {
  key: string;
  label: string;
  description: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<{
    key: string;
    label: string;
    kind: 'input' | 'derived';
    format: WorkbookFormat;
    cells: Array<{ column_key: string; value: number | null }>;
  }>;
}

export type AnomalySeverity = 'error' | 'warning' | 'info';

/**
 * A finding against the entered financial statements
 * (valuation service, `domain/financialAnomalies.ts`).
 *
 * The workbook's own arithmetic cannot be wrong — subtotals are derived — so
 * every one of these is about an input the arithmetic accepts and shouldn't:
 * a cost entered negative, a period in the wrong units, a forecast the record
 * does not support. None of them block anything.
 */
export interface FinancialAnomaly {
  check: string;
  severity: AnomalySeverity;
  sheet: string;
  sheet_label: string;
  column_key: string | null;
  column_label: string | null;
  row_key: string | null;
  row_label: string | null;
  summary: string;
  detail: string;
  value: number | null;
}

export interface FinancialAnomalyReport {
  anomalies: FinancialAnomaly[];
  counts: Record<AnomalySeverity, number>;
  empty: boolean;
}

export function formatWorkbookValue(value: number | null, format: WorkbookFormat): string {
  if (value === null) return '—';
  switch (format) {
    case 'percent':
      return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    case 'currency':
      return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    case 'number':
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}

// ── Reports ───────────────────────────────────────────────────────────────────

export interface Report {
  id: string;
  valuation_id: string;
  template_version: string;
  status: 'draft' | 'accepted' | 'changes' | 'published';
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface ReportSection {
  key: string;
  heading: string;
  html: string;
  /**
   * Kept out of the rendered deliverable, but not deleted — the text survives so
   * unhiding restores what was written rather than the skeleton. Absent on every
   * chapter nobody has hidden.
   */
  hidden?: boolean;
}

export interface ReportContent {
  title: string;
  sections: ReportSection[];
}

export interface ReportVersionSummary {
  id: string;
  report_id: string;
  version: number;
  rendered_at: string | null;
  created_by: string | null;
  created_at: string;
  has_pdf: boolean;
}

/** Client mirror of auth/rbac.ts REPORT_VISIBLE_STATES (server enforces). */
export const REPORT_VISIBLE_STATES: ReadonlySet<ValuationState> = new Set([
  'drafted',
  'draft_accepted',
  'published',
] as ValuationState[]);

// ── HTML sanitizing (client mirror of domain/report.ts — server is authority) ─

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  'a',
]);

/**
 * Cutting a `open … close` span with one lazy regex — `<!--[\s\S]*?-->` — is
 * quadratic on input that opens spans it never closes: every `<!--` is a
 * candidate start, and with no `-->` to be found each one rescans to the end
 * of the input before failing.
 *
 * The server-side twin of this sanitizer is where such a body gets stored (see
 * the note in valuation's domain/report.ts). This copy is where the cost is
 * paid again, and paid repeatedly: ReportTab sanitizes each section every time
 * it renders it, so one saved section of `<!--` freezes the tab of everyone
 * who opens the report, not just the author who saved it.
 *
 * The two below scan forward instead. A closing marker only ever moves later
 * in the input, so a search that comes back empty has settled the question for
 * every opening marker after it too — that is what makes a missing close cost
 * one pass rather than one per candidate.
 */

/** Remove `<!-- … -->` spans, leaving an unterminated comment where it stands. */
function stripComments(html: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = html.indexOf('<!--', at);
    if (start === -1) break;
    const end = html.indexOf('-->', start + 4);
    if (end === -1) break; // no `-->` remains for this `<!--` or for any after it
    out += html.slice(at, start);
    at = end + 3;
  }
  return out + html.slice(at);
}

const RAW_TEXT_OPEN = /<(script|style)\b[^>]*>/gi;
const RAW_TEXT_CLOSE = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };

/** Remove `<script>…</script>` and `<style>…</style>` bodies, open tag included. */
function stripRawText(html: string): string {
  // Tracked per name, because failing to find `</script>` says nothing about
  // whether a `</style>` is still to come.
  const unclosed = new Set<string>();
  let out = '';
  let at = 0;
  RAW_TEXT_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = RAW_TEXT_OPEN.exec(html)) !== null) {
    const name = open[1]!.toLowerCase() as keyof typeof RAW_TEXT_CLOSE;
    if (unclosed.has(name)) continue;
    const closeRe = RAW_TEXT_CLOSE[name];
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(html);
    if (close === null) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(at, open.index);
    at = close.index + close[0].length;
    RAW_TEXT_OPEN.lastIndex = at;
  }
  return out + html.slice(at);
}

/** Sticky, so the tag head is matched in place rather than searched for. */
const TAG_HEAD = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b/y;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** The tab, LF and CR a URL parser deletes before parsing — see the server copy. */
const URL_IGNORED = /[\t\n\r]/g;

/**
 * Absolute http(s), mailto, or a site-relative path — kept identical to the
 * server copy in `valuation/src/domain/report.ts`, which carries the reasoning.
 * `\/(?![/\\])` admits `/pricing` and rejects `//evil.example` and
 * `/\evil.example`, each an off-site link wearing a relative path's clothes.
 */
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?![/\\]))/i;

/** The href to emit, normalised the way the URL parser would — or null to drop it. */
function safeHref(raw: string): string | null {
  const url = raw.trim().replace(URL_IGNORED, '');
  return SAFE_URL.test(url) ? url : null;
}

/** Absolute http(s) only — no relative arm, because an off-site citation is off-site. */
const SAFE_EXTERNAL_URL = /^https?:\/\//i;

/**
 * A URL this app did not write, as an href it can put in the DOM — or null.
 *
 * The research citations are the case this exists for. Their URLs come from
 * whichever search backend the deployment has configured, by way of a model
 * that picks which of them to cite, and they are rendered as links an analyst
 * clicks. `href` is one of the two attributes where a string decides whether
 * the browser navigates or executes, so a value from outside gets asked the
 * same question every other link in this app is asked.
 *
 * Null rather than a fallback URL: a citation that cannot be linked is still
 * evidence and must still be *shown*, just not made clickable. See ResearchTab.
 */
export function externalHref(raw: string | null | undefined): string | null {
  const url = (raw ?? '').trim().replace(URL_IGNORED, '');
  return SAFE_EXTERNAL_URL.test(url) ? url : null;
}

/**
 * Whitelist tags, drop every attribute — except <a>, which keeps a validated
 * http(s)/mailto href (gap 9). Safe for dangerouslySetInnerHTML.
 *
 * Scans for the brackets rather than letting two regexes find them, for exactly
 * the reason the block above `stripComments` gives — the two regexes this
 * replaces both ended in `[^>]*>`, so on input with no `>` in it they ran to the
 * end of the document from every `<`, failed, backtracked, and started again one
 * character along. 12.5k characters of `"<p"` cost 36ms, 25k 140ms, 50k 567ms,
 * 100k 2.27s, against 3ms for ordinary editor HTML of the same size.
 *
 * That matters more here than on the server. `RichTextEditor` calls this on
 * every input event, so a document holding that shape freezes the editor a
 * keystroke at a time — and it can arrive by paste, which is one event that
 * produces the whole 100k at once.
 *
 * Kept as two passes on purpose: the junk sweep runs over what the tag filter
 * *left*, so a `<3` in front of a dropped `<img …>` keeps its text, because the
 * `>` that would have closed it went with the img. Output is byte-identical to
 * the regexes for every input — checked differentially over every ordered pair
 * and triple of a tag alphabet, and mirrored in the server copy in
 * valuation/src/domain/report.ts.
 */
export function sanitizeHtml(html: string): string {
  return dropJunkTags(filterTags(stripComments(stripRawText(html))));
}

/** Whitelist pass: allowed tags kept (bare), everything else dropped. */
function filterTags(source: string): string {
  let out = '';
  let last = 0;
  let at = 0;
  let gt = -1;
  for (;;) {
    const lt = source.indexOf('<', at);
    if (lt === -1) break;
    if (gt < lt) gt = source.indexOf('>', lt + 1);
    if (gt === -1) break; // no `>` remains, for this `<` or any after it
    TAG_HEAD.lastIndex = lt;
    const m = TAG_HEAD.exec(source);
    if (m === null) {
      at = lt + 1; // a `<` that starts no tag; the junk sweep decides its fate
      continue;
    }
    out += source.slice(last, lt);
    const close = m[1]!;
    const tag = m[2]!.toLowerCase();
    const attrsFrom = TAG_HEAD.lastIndex;
    last = at = gt + 1;
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (tag === 'br') {
      out += '<br>';
      continue;
    }
    if (tag === 'a' && !close) {
      // Bounded by this tag's own length, and tags do not overlap.
      const href = HREF.exec(source.slice(attrsFrom, gt));
      const url = safeHref(href?.[1] ?? href?.[2] ?? href?.[3] ?? '');
      out += url === null ? '<a>' : `<a href="${url.replace(/"/g, '&quot;')}">`;
      continue;
    }
    out += `<${close}${tag}>`;
  }
  return out + source.slice(last);
}

/**
 * Junk sweep: `<` followed by anything that cannot begin a tag, through to its
 * `>`. `/` and `!` stay excluded as they were — a stray `</>` or a `<!` left by
 * an unterminated comment is text, not a tag.
 *
 * The closing `>` is searched from `lt + 2`, not `lt + 1`: in the regex this
 * replaces, `/<[^a-zA-Z\/!][^>]*>/`, the `[^a-zA-Z\/!]` spends `lt + 1` on the
 * junk lead before looking for it. So a bare `<>` is not a junk tag and survives
 * as text.
 */
function dropJunkTags(source: string): string {
  let out = '';
  let last = 0;
  let at = 0;
  let gt = -1;
  for (;;) {
    const lt = source.indexOf('<', at);
    if (lt === -1) break;
    if (gt < lt + 2) gt = source.indexOf('>', lt + 2);
    if (gt === -1) break;
    const next = source[lt + 1]!;
    if (next === '/' || next === '!' || (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z')) {
      at = lt + 1;
      continue;
    }
    out += source.slice(last, lt);
    last = at = gt + 1;
  }
  return out + source.slice(last);
}
