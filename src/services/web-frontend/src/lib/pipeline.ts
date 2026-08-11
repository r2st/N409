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
  /** Cleared by an analyst (0121) — what the header's pending-files chip counts. */
  reviewed_at?: string | null;
  reviewed_by?: string | null;
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

/**
 * One engine pre-flight finding. `field` is a dotted path into the compute
 * payload (`params.dlom`, `inputs.income.discount_rate`), so a message can be
 * traced back to the control that produced it.
 */
export interface EngineIssue {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  hint: string | null;
}

export interface PreflightResult {
  ok: boolean;
  engine_version: string;
  errors: EngineIssue[];
  warnings: EngineIssue[];
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
  /** Blocking errors on a failed run, review warnings on a successful one. */
  diagnostics?: EngineIssue[];
  created_at: string;
  /**
   * Whether this run recorded pipeline steps — false for every calculation
   * older than migration 0126, and for one the engine rejected before starting.
   * The steps themselves are never in the list: they are the engine's whole
   * working state and only the inspector reads them.
   */
  has_trace?: boolean;
}

/**
 * One engine pipeline stage, as the engine recorded it (`engine/trace.py`).
 *
 * `status` is the field the result document structurally cannot carry. An
 * approach with zero weight and an approach carried over from a previous
 * per-approach recalculation are both simply missing from `results.approaches`,
 * in exactly the same way, and they mean opposite things: `skipped` was
 * excluded on purpose, `reused` is a number older than the inputs beside it.
 */
export interface CalculationStep {
  seq: number;
  key: string;
  label: string;
  status: 'computed' | 'reused' | 'skipped';
  inputs: unknown;
  outputs: unknown;
  note: string | null;
  elapsed_ms: number;
}

export interface CalculationDetail {
  calculation: Calculation;
  /** The exact payload posted to the engine, and the document it returned. */
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  steps: CalculationStep[];
  /** False on a run that predates the trace column — see `Calculation.has_trace`. */
  traced: boolean;
}

/** Human label for a dotted engine field path: `inputs.income.discount_rate` → "Income · discount rate". */
export function fieldLabel(field: string): string {
  const parts = field.replace(/^(inputs|params)\./, '').split('.');
  return parts
    .map((part) => part.replace(/_/g, ' ').replace(/\[(\d+)\]/g, ' $1'))
    .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' · ');
}

/**
 * The methodology enums, mirroring the valuation service's `repos/params.ts`.
 * The engine implements all seven DLOM models and all three DLOC derivations;
 * these types are what stops the form quietly offering a subset again.
 */
export const DLOM_METHODS = [
  'chaffee',
  'finnerty',
  'ghaidarov',
  'longstaff',
  'restricted_stock',
  'pre_ipo',
  'qualitative',
] as const;
export type DlomMethod = (typeof DLOM_METHODS)[number];

export const DLOC_METHODS = ['control_premium', 'studies', 'qualitative'] as const;
export type DlocMethod = (typeof DLOC_METHODS)[number];

export const ALLOCATION_METHODS = ['opm', 'pwerm', 'hybrid', 'cvm', 'monte_carlo'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export interface ValuationParams {
  valuation_id: string;
  rolling_forward: boolean;
  inception_date: string | null;
  fiscal_year_end: string | null;
  exit_timeline: string | null;
  business_overview: string | null;
  revenue_status: 'pre_revenue' | 'post_revenue' | null;
  /** AICPA stage of enterprise development, 1-6. Null until concluded. */
  development_stage: number | null;
  last_round_date: string | null;
  last_year_revenue_cents: number | string | null;
  ytd_revenue_cents: number | string | null;
  runway_months: number | null;
  weight_asset: string | null;
  weight_opm: string | null;
  weight_income: string | null;
  weight_market: string | null;
  dloc: string | null;
  /** How the DLOC was derived; null applies `dloc` as a stated figure. */
  dloc_method: DlocMethod | null;
  control_premium: string | null;
  dloc_synergy_share: string | null;
  /** Which control-premium studies to blend; null is the engine's default set.
   *  Only read when dloc_method is 'studies'. */
  dloc_studies: string[] | null;
  dloc_statistic: 'median' | 'mean' | null;
  /** A firm's own control-premium rows, replacing the engine's indicative
   *  built-in table. Null uses the built-ins. */
  dloc_study_table: unknown;
  dlom: string | null;
  dlom_method: DlomMethod | null;
  /** A discount weighted across several methods; mutually exclusive with
   *  `dlom_method` (the table's `valuation_params_one_dlom_form` CHECK). */
  dlom_methods: Array<{ method: DlomMethod; weight: number }> | null;
  dlom_qualitative: string | null;
  /** Restricted-stock study configuration; null studies is the engine's
   *  default set (post-1997-amendment only). */
  dlom_studies: string[] | null;
  dlom_statistic: 'median' | 'mean' | null;
  dlom_study_table: unknown;
  /** The pre-IPO family's own keys — the two tables share no study names, so a
   *  blend weighting both families has to select from each. `dlom_statistic`
   *  above is shared by both. */
  dlom_pre_ipo_studies: string[] | null;
  dlom_pre_ipo_table: unknown;
  market_method: 'revenue' | 'ebitda' | null;
  market_horizon: 'ltm' | 'ntm' | null;
  asset_method: 'cost_to_replicate' | 'nav' | null;
  allocation_method: AllocationMethod;
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
  /** Total proceeds cap on a participating class; null/absent is uncapped. */
  participation_cap?: number | null;
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
