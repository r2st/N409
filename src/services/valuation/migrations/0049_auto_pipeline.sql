-- Beyond-parity #3 — auto-pipeline on upload (docs/n409-final-status-report.md §4.4).
-- When a document lands, extraction → parameter fill → draft calculation run
-- unattended so ops opens an already-populated valuation. The run row is the
-- status the UI polls/streams; the steps themselves keep writing their own
-- audit events (ai_job_completed, calculation_*) as today.

-- Per-valuation opt-out; the global switch is AUTO_PIPELINE in the service env.
ALTER TABLE valuations ADD COLUMN auto_pipeline boolean NOT NULL DEFAULT true;

CREATE TABLE pipeline_runs (
  id            ulid PRIMARY KEY,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  -- The upload that triggered the run (NULL for manual triggers).
  document_id   ulid REFERENCES documents(id),
  trigger       text NOT NULL DEFAULT 'upload' CHECK (trigger IN ('upload', 'manual')),
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'extracting', 'calculating', 'ready', 'failed')),
  error         text,
  triggered_by  ulid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_runs_valuation_idx ON pipeline_runs (valuation_id, created_at DESC);
