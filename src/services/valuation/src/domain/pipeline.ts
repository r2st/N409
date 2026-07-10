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
] as const;
export type AiPipeline = (typeof AI_PIPELINES)[number];

export const PIPELINE_EVENT_TYPES = {
  taskCreated: 'review_task_created',
  taskUpdated: 'review_task_updated',
  documentUploaded: 'document_uploaded',
  documentDeleted: 'document_deleted',
  paramsUpdated: 'params_updated',
  aiJobCompleted: 'ai_job_completed',
  calculationCompleted: 'calculation_completed',
} as const;
