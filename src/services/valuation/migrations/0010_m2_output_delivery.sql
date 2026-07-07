-- Milestone 2 — Output & Delivery (feature-gap-analysis P0 items 6–8).
-- Overwrites (68-field analyst override set), valuation workbook cells,
-- reports + report_versions (WYSIWYG content, rendered PDF, history).
-- Numbered 0010 to leave 0003–0009 free for M1 (built in parallel).

-- ── Overwrites ───────────────────────────────────────────────────────────────
CREATE TYPE overwrite_category AS ENUM
  ('company_info','financial_metrics','forecasts','valuation_params','market_comparables','reporting');

CREATE TYPE overwrite_class AS ENUM ('numeric','date','character');

CREATE TABLE overwrites (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  category       overwrite_category NOT NULL,
  field_key      text NOT NULL,
  class          overwrite_class NOT NULL,
  value          jsonb NOT NULL,
  original_value jsonb,
  reason         text,
  created_by     ulid REFERENCES users(id),
  updated_by     ulid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (valuation_id, field_key)
);
CREATE INDEX overwrites_valuation_idx ON overwrites (valuation_id);
CREATE INDEX overwrites_category_idx  ON overwrites (category);

-- ── Valuation workbook (analyst working model) ───────────────────────────────
-- Only INPUT cells are stored; derived rows are recomputed from the template
-- definition (src/domain/workbook.ts) on every read.
CREATE TABLE workbook_cells (
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  sheet        text NOT NULL,
  row_key      text NOT NULL,
  column_key   text NOT NULL,
  value        numeric NOT NULL,
  updated_by   ulid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (valuation_id, sheet, row_key, column_key)
);

-- ── Reports ──────────────────────────────────────────────────────────────────
CREATE TYPE report_status AS ENUM ('draft','accepted','changes','published');

CREATE TABLE reports (
  id               ulid PRIMARY KEY,
  valuation_id     ulid NOT NULL UNIQUE REFERENCES valuations(id) ON DELETE CASCADE,
  template_version text NOT NULL,
  status           report_status NOT NULL DEFAULT 'draft',
  current_version  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Every save is a new immutable version; PDFs are stored inline (no S3 in this
-- deployment) and rendered lazily.
CREATE TABLE report_versions (
  id          ulid PRIMARY KEY,
  report_id   ulid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  content     jsonb NOT NULL,
  pdf         bytea,
  rendered_at timestamptz,
  created_by  ulid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version)
);
CREATE INDEX report_versions_report_idx ON report_versions (report_id, version DESC);
