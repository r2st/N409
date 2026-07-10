-- AI quality-assurance gates (IMPROVEMENTS_RESEARCH §4.3). Each row is one QA
-- run against a specific calculation: the deterministic reasonableness checks,
-- optionally the AI reviewer's findings, and the overall verdict. The publish
-- gate requires a non-failing review of the latest successful calculation.

-- New AI pipelines: 'qa' (output review) and 'explain' (plain-English
-- methodology summary). PG 12+ allows ADD VALUE inside a transaction as long
-- as the value isn't used in the same transaction — these migrations don't.
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'qa';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'explain';

CREATE TABLE qa_reviews (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  calculation_id ulid NOT NULL REFERENCES calculations(id) ON DELETE CASCADE,
  -- Worst finding across all checks: pass < warn < fail.
  status         text NOT NULL CHECK (status IN ('pass','warn','fail')),
  -- Deterministic check results: [{key,label,status,detail}].
  checks         jsonb NOT NULL DEFAULT '[]',
  -- AI reviewer output (null when the run was deterministic-only).
  ai_findings    jsonb,
  ai_model       text,
  created_by     ulid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX qa_reviews_valuation_idx   ON qa_reviews (valuation_id, created_at DESC);
CREATE INDEX qa_reviews_calculation_idx ON qa_reviews (calculation_id, created_at DESC);
