/** M1 core-pipeline entities + helpers (mirror valuation domain/pipeline.ts). */

export const REVIEW_TASK_KINDS = [
  'data_review',
  'cap_table',
  'financials',
  'comparables',
  'methodology',
  'draft_review',
  'final_review',
  'signoff',
  'client_followup',
  'other',
] as const;
export type ReviewTaskKind = (typeof REVIEW_TASK_KINDS)[number];

export const TASK_KIND_LABELS: Record<ReviewTaskKind, string> = {
  data_review: 'Data review',
  cap_table: 'Cap table',
  financials: 'Financials',
  comparables: 'Comparables',
  methodology: 'Methodology',
  draft_review: 'Draft review',
  final_review: 'Final review',
  signoff: 'Sign-off',
  client_followup: 'Client follow-up',
  other: 'Other',
};

export const REVIEW_TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type ReviewTaskStatus = (typeof REVIEW_TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<ReviewTaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export interface ReviewTask {
  id: string;
  valuation_id: string;
  kind: ReviewTaskKind;
  title: string;
  description: string | null;
  status: ReviewTaskStatus;
  assignee_id: string | null;
  created_by: string | null;
  sla_hours: number | null;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  overdue: boolean;
}

export const DOCUMENT_KINDS = [
  'cap_table',
  'income_statement',
  'balance_sheet',
  'cash_flow',
  'projections',
  'pitch_deck',
  'articles_of_incorporation',
  'option_grants',
  'term_sheet',
  'prior_valuation',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  cap_table: 'Cap table',
  income_statement: 'Income statement',
  balance_sheet: 'Balance sheet',
  cash_flow: 'Cash flow statement',
  projections: 'Projections',
  pitch_deck: 'Pitch deck',
  articles_of_incorporation: 'Articles of incorporation',
  option_grants: 'Option grants',
  term_sheet: 'Term sheet',
  prior_valuation: 'Prior valuation',
  other: 'Other',
};

export interface ValuationDocument {
  id: string;
  valuation_id: string;
  kind: DocumentKind;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  sha256: string;
  uploaded_by: string | null;
  created_at: string;
}

/** Pipelines runnable from the AI tab. 'qa' runs from the QA tab instead, so
 * the deterministic checks and the publish-gate review always ride along. */
export const AI_PIPELINES = ['missing_data', 'extract', 'comparables', 'summarize', 'explain'] as const;
export type AiPipeline = (typeof AI_PIPELINES)[number] | 'qa';

export const AI_PIPELINE_META: Record<AiPipeline, { label: string; description: string }> = {
  missing_data: {
    label: 'Missing data check',
    description: 'Reviews uploads and params, lists what is still needed for a defensible valuation.',
  },
  extract: {
    label: 'Data extraction',
    description: 'Pulls share counts, preferences, cash/debt and revenue out of the uploaded documents.',
  },
  comparables: {
    label: 'Public comparables',
    description: 'Suggests guideline public companies with revenue/EBITDA multiples for the market approach.',
  },
  summarize: {
    label: 'Summarize attachments',
    description: 'Per-document summaries plus an overall synthesis for the analyst.',
  },
  explain: {
    label: 'Plain-English explanation',
    description: 'Explains the methodology and result in founder-friendly language (needs a calculation).',
  },
  qa: {
    label: 'QA review',
    description: 'Output quality review — run from the QA tab so the publish gate records it.',
  },
};

/** PII redaction metadata each pipeline run reports back. */
export interface AnonymizationMeta {
  applied: boolean;
  redacted: Record<string, number>;
}

export interface AiJob {
  id: string;
  valuation_id: string;
  pipeline: AiPipeline;
  status: 'running' | 'succeeded' | 'failed';
  model: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  latency_ms: number | null;
  prompt_version: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface Calculation {
  id: string;
  valuation_id: string;
  engine_version: string;
  status: 'succeeded' | 'failed';
  inputs: Record<string, unknown>;
  results: Record<string, unknown> | null;
  equity_value: string | null;
  fmv_per_share: string | null;
  error: string | null;
  created_at: string;
}

export interface ValuationParams {
  valuation_id: string;
  rolling_forward: boolean;
  inception_date: string | null;
  fiscal_year_end: string | null;
  exit_timeline: string | null;
  business_overview: string | null;
  revenue_status: 'pre_revenue' | 'post_revenue' | null;
  last_round_date: string | null;
  last_year_revenue_cents: number | string | null;
  ytd_revenue_cents: number | string | null;
  runway_months: number | null;
  weight_asset: string | null;
  weight_opm: string | null;
  weight_income: string | null;
  weight_market: string | null;
  dloc: string | null;
  dlom: string | null;
  dlom_method: 'chaffee' | 'finnerty' | 'qualitative' | null;
  dlom_qualitative: string | null;
  market_method: 'revenue' | 'ebitda' | null;
  market_horizon: 'ltm' | 'ntm' | null;
  asset_method: 'cost_to_replicate' | 'nav' | null;
  allocation_method: 'opm' | 'pwerm';
  updated_at: string;
}

/** One cap-table row — mirrors the engine's waterfall share-class shape. */
export interface ShareClassInput {
  name: string;
  kind: 'common' | 'preferred' | 'option';
  shares: number;
  /** preferred */
  preference?: number;
  seniority?: number;
  participating?: boolean;
  conversion_ratio?: number;
  /** option */
  strike?: number;
}

/**
 * The analyst-entered financial model (valuation_params.engine_inputs). Mirrors
 * exactly what the compute engine reads; all fields optional because a model is
 * built up incrementally and only the weighted approaches are required at
 * calculation time.
 */
export interface EngineInputs {
  shares_outstanding_common?: number | null;
  shares_outstanding_preferred?: number | null;
  options_outstanding?: number | null;
  liquidation_preference?: number | null;
  share_classes?: ShareClassInput[] | null;
  volatility?: number | null;
  risk_free_rate?: number | null;
  time_to_exit_years?: number | null;
  valuation_date?: string | null;
  cash?: number | null;
  debt?: number | null;
  last_round_post_money?: number | null;
  last_round_price_per_share?: number | null;
  last_round_class?: string | null;
  asset?: {
    total_assets?: number | null;
    total_liabilities?: number | null;
    cost_to_replicate?: number | null;
  } | null;
  income?: {
    free_cash_flows?: number[] | null;
    revenues?: number[] | null;
    discount_rate?: number | null;
    terminal_growth?: number | null;
  } | null;
  market?: { metric?: number | null; multiples?: number[] | null } | null;
}

/** Mirrors the API's basis-point weight validation for instant UI feedback. */
export function weightsProblem(weights: {
  asset: string;
  opm: string;
  income: string;
  market: string;
}): string | null {
  const values = [weights.asset, weights.opm, weights.income, weights.market];
  const empty = values.filter((v) => v.trim() === '').length;
  if (empty === 4) return null;
  if (empty > 0) return 'Set all four weights (use 0 for unused approaches), or clear all four.';
  const nums = values.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    return 'Each weight must be a number between 0 and 1.';
  }
  const bps = nums.reduce((acc, n) => acc + Math.round(n * 10000), 0);
  if (bps !== 10000) {
    return `Weights must sum to 1.0 — currently ${(bps / 10000).toFixed(4)}.`;
  }
  return null;
}

export function formatBytes(bytes: number | string): string {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMoney(value: number | string | null | undefined, currency = 'USD'): string {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: n >= 100 ? 0 : 4,
  }).format(n);
}

/** Human "due in 3h / overdue by 2d" for SLA chips. */
export function dueLabel(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  const abs = Math.abs(ms);
  const unit =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  return ms >= 0 ? `due in ${unit}` : `overdue by ${unit}`;
}
