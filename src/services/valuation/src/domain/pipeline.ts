/** M1 core-pipeline domain constants (migrations/0003_m1_pipeline.sql). */

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

export const REVIEW_TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type ReviewTaskStatus = (typeof REVIEW_TASK_STATUSES)[number];

/** Statuses that still count against the SLA clock. */
export const ACTIVE_TASK_STATUSES: ReadonlySet<ReviewTaskStatus> = new Set([
  'open',
  'in_progress',
  'blocked',
]);

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

export const AI_PIPELINES = [
  'missing_data',
  'extract',
  'comparables',
  'summarize',
  // IMPROVEMENTS_RESEARCH §4.3/§4.5 — output QA review + plain-English
  // methodology explanation. 'qa' runs only via POST /valuations/:id/qa so
  // the deterministic checks and the review row always ride along.
  'qa',
  'explain',
  // Analyst agents (migrations 0060/0061). Multi-step / structured generators
  // that share the pipeline job + prompt-registry machinery.
  'cap_table',
  'comp_selection',
  'report_narrative',
  'assumptions',
  'audit_defense',
  'roll_forward',
  // Web-grounded research (migrations 0116/0117). These are prompt-registry
  // entries rather than runnable pipelines: they carry the system prompt and
  // the Sonar tier for a research topic, and routes/research.ts reads them.
  // POST /valuations/:id/ai/:pipeline refuses them for the same reason it
  // refuses 'qa' — the research route owns the containment rules, the storage
  // and the supersede, and a second entry point would own none of them.
  'market_research',
  'industry_overview',
  'industry_outlook',
  'competitor_analysis',
  'company_overview',
  'industry_finder',
] as const;
export type AiPipeline = (typeof AI_PIPELINES)[number];

/**
 * Prompt-registry rows that are not runnable through the generic AI route.
 * Each has a dedicated route that adds something the generic one cannot: the
 * QA gate's deterministic checks and review row, and research's public-field
 * containment plus its append-only storage.
 */
export const NON_RUNNABLE_PIPELINES: ReadonlySet<AiPipeline> = new Set([
  'qa',
  'market_research',
  'industry_overview',
  'industry_outlook',
  'competitor_analysis',
  'company_overview',
  'industry_finder',
]);

/**
 * Agents that narrate or defend a finished result — the route auto-attaches the
 * latest successful calculation and refuses to run without one, exactly like
 * 'explain'.
 */
export const CALCULATION_DEPENDENT_PIPELINES: ReadonlySet<AiPipeline> = new Set([
  'explain',
  'report_narrative',
  'audit_defense',
]);

/** Agents that read the uploaded document corpus (cap-table docs, financials). */
export const DOCUMENT_DEPENDENT_PIPELINES: ReadonlySet<AiPipeline> = new Set(['extract', 'cap_table']);

export const PIPELINE_EVENT_TYPES = {
  taskCreated: 'review_task_created',
  taskUpdated: 'review_task_updated',
  documentUploaded: 'document_uploaded',
  documentDeleted: 'document_deleted',
  paramsUpdated: 'params_updated',
  aiJobCompleted: 'ai_job_completed',
  calculationCompleted: 'calculation_completed',
} as const;
