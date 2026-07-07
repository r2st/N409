-- Milestone 1 — core pipeline (feature-gap-analysis P0 items 1–5).
-- Review tasks, documents, AI jobs, calculations. Same conventions as 0001:
-- ULID PKs, timestamptz UTC, money as integer cents.

-- ── Review / task management (P0 #1) ────────────────────────────────────────
CREATE TYPE review_task_kind AS ENUM
  ('data_review','cap_table','financials','comparables','methodology',
   'draft_review','final_review','signoff','client_followup','other');

CREATE TYPE review_task_status AS ENUM
  ('open','in_progress','blocked','done','cancelled');

CREATE TABLE review_tasks (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  kind         review_task_kind NOT NULL,
  title        text NOT NULL,
  description  text,
  status       review_task_status NOT NULL DEFAULT 'open',
  assignee_id  ulid REFERENCES users(id),
  created_by   ulid REFERENCES users(id),
  sla_hours    integer CHECK (sla_hours > 0),
  due_at       timestamptz,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_tasks_valuation_idx ON review_tasks (valuation_id);
CREATE INDEX review_tasks_assignee_idx  ON review_tasks (assignee_id, status);
CREATE INDEX review_tasks_due_idx       ON review_tasks (due_at) WHERE status IN ('open','in_progress','blocked');

-- ── Documents (P0 #9) ────────────────────────────────────────────────────────
CREATE TYPE document_kind AS ENUM
  ('cap_table','income_statement','balance_sheet','cash_flow','projections',
   'pitch_deck','articles_of_incorporation','option_grants','term_sheet',
   'prior_valuation','other');

CREATE TABLE documents (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  kind         document_kind NOT NULL DEFAULT 'other',
  filename     text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  sha256       text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by  ulid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX documents_valuation_idx ON documents (valuation_id) WHERE deleted_at IS NULL;

-- ── AI jobs (P0 #2/#3 — pipeline provenance) ─────────────────────────────────
CREATE TYPE ai_pipeline   AS ENUM ('missing_data','extract','comparables');
CREATE TYPE ai_job_status AS ENUM ('running','succeeded','failed');

CREATE TABLE ai_jobs (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  pipeline     ai_pipeline NOT NULL,
  status       ai_job_status NOT NULL DEFAULT 'running',
  model        text,
  input        jsonb NOT NULL DEFAULT '{}',
  result       jsonb,
  error        text,
  latency_ms   integer,
  created_by   ulid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX ai_jobs_valuation_idx ON ai_jobs (valuation_id, created_at DESC);

-- ── Calculations (P0 #5 — engine results) ────────────────────────────────────
CREATE TYPE calculation_status AS ENUM ('succeeded','failed');

CREATE TABLE calculations (
  id                ulid PRIMARY KEY,
  valuation_id      ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  engine_version    text NOT NULL,
  status            calculation_status NOT NULL,
  inputs            jsonb NOT NULL,
  results           jsonb,
  equity_value      numeric,
  fmv_per_share     numeric,
  error             text,
  created_by        ulid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calculations_valuation_idx ON calculations (valuation_id, created_at DESC);
