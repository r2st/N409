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

/**
 * Whitelist tags, drop every attribute — except <a>, which keeps a validated
 * http(s)/mailto href (gap 9). Safe for dangerouslySetInnerHTML.
 */
export function sanitizeHtml(html: string): string {
  return stripComments(stripRawText(html))
    .replace(
      /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
      (_m, close: string, name: string, attrs: string) => {
        const tag = name.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) return '';
        if (tag === 'br') return '<br>';
        if (tag === 'a' && !close) {
          const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
          const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
          if (/^(https?:\/\/|mailto:)/i.test(url)) {
            return `<a href="${url.replace(/"/g, '&quot;')}">`;
          }
          return '<a>';
        }
        return `<${close}${tag}>`;
      },
    )
    .replace(/<[^a-zA-Z/!][^>]*>/g, '');
}

/** Fetches an authenticated binary endpoint and triggers a browser download. */
export async function downloadPdf(path: string, filename: string, token: string | null): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
