-- Engagement lifecycle management (feature 8): the operational overlay on a
-- valuation. Each engagement tracks the stage an analyst is working through
-- (kickoff → data collection → analysis → draft → client review → auditor
-- queries → final report → board approval), with SLA timing per stage and an
-- assigned analyst. Stage transitions are recorded in a history table so
-- expected-vs-actual duration can be computed.
CREATE TABLE engagements (
  id                 ulid PRIMARY KEY,
  valuation_id       ulid NOT NULL UNIQUE REFERENCES valuations(id) ON DELETE CASCADE,
  current_stage      text NOT NULL DEFAULT 'kickoff',
  assigned_analyst_id ulid REFERENCES users(id),
  stage_entered_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engagements_stage_idx ON engagements (current_stage);
CREATE INDEX engagements_analyst_idx ON engagements (assigned_analyst_id);

CREATE TABLE engagement_stage_history (
  id            ulid PRIMARY KEY,
  engagement_id ulid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  stage         text NOT NULL,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  entered_by    ulid REFERENCES users(id)
);

CREATE INDEX engagement_history_idx ON engagement_stage_history (engagement_id, entered_at);
