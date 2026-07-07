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
]);

/** Whitelist tags, drop every attribute — safe for dangerouslySetInnerHTML. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, close: string, name: string) => {
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (tag === 'br') return '<br>';
      return `<${close}${tag}>`;
    })
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
