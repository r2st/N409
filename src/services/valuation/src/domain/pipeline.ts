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

/**
 * How a task status is named to a person.
 *
 * The board draws these from its own copy in `web-frontend/src/lib/pipeline.ts`
 * — web-frontend has no `@n409/shared` dependency, so user-visible vocabulary
 * is duplicated by construction and pinned by test instead. This copy exists
 * because a refusal has to name the status the task moved to, and answering an
 * ops user with `in_progress` is the column value standing in for the word the
 * screen they are looking at uses.
 */
export const TASK_STATUS_LABELS: Record<ReviewTaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

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
  // Company profile (migrations 0151/0152) — the business description, SIC /
  // NAICS classification and scale metrics behind the report's company section,
  // drafted from the engagement's own documents.
  //
  // Deliberately not named 'company_overview': that value is the web-grounded
  // research prompt below, and the two sit on opposite sides of the trust
  // boundary. The research topic sends a *guideline* company's name out to a
  // search provider and refuses the engagement's own; this agent reads the
  // engagement's confidential documents and never leaves the redactor.
  'company_profile',
  // Engagement tagging (migrations 0153/0154) — 409.ai parity gap #23. Classes
  // the engagement against the fixed vocabulary in domain/valuationTags.ts so
  // the list filter and the precedent query have something to read.
  //
  // The only agent whose prompt needs a *platform* constant rather than the
  // engagement's own data: `runAiPipeline` ships `tag_catalogue` for this
  // pipeline and no other. The AI service deliberately holds no copy of the
  // vocabulary — two copies drift, and the drift is silent.
  'tagging',
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

/**
 * Agents that read the uploaded document corpus (cap-table docs, financials).
 *
 * `company_profile` belongs here for a reason particular to it: the documents
 * are not merely helpful to that agent, they are its *only* source. Run against
 * an empty corpus it would have nothing to describe the business from but the
 * redacted placeholder standing in for its name — which is the ungrounded
 * answer the whole design refuses.
 */
export const DOCUMENT_DEPENDENT_PIPELINES: ReadonlySet<AiPipeline> = new Set([
  'extract',
  'cap_table',
  'company_profile',
]);

export const PIPELINE_EVENT_TYPES = {
  taskCreated: 'review_task_created',
  taskUpdated: 'review_task_updated',
  documentUploaded: 'document_uploaded',
  documentDeleted: 'document_deleted',
  documentDownloaded: 'document_downloaded',
  documentRefiled: 'document_refiled',
  paramsUpdated: 'params_updated',
  aiJobCompleted: 'ai_job_completed',
  calculationCompleted: 'calculation_completed',
} as const;
