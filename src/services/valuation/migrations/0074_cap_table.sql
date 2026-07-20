-- Cap-table integration (feature 9): an imported, validated, structured cap
-- table per valuation that feeds the waterfall engine. The parsed entries and
-- validation result are stored as jsonb; the column mapping and source format
-- are retained so a re-import reproduces the same shape.
CREATE TABLE cap_tables (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL UNIQUE REFERENCES valuations(id) ON DELETE CASCADE,
  source_format  text NOT NULL DEFAULT 'generic',
  entries        jsonb NOT NULL DEFAULT '[]',
  validation     jsonb NOT NULL DEFAULT '{}',
  column_mapping jsonb NOT NULL DEFAULT '{}',
  created_by     ulid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
