-- Data retention + legal hold policy (feature 10).

-- Per-data-type retention config. archive_after_days: age at which a record is
-- archived; retention_days: age at which it may be purged (NULL = keep forever).
CREATE TABLE retention_policies (
  data_type        text PRIMARY KEY,
  archive_after_days integer,   -- NULL = never auto-archive
  retention_days   integer,     -- NULL = keep forever
  enabled          boolean NOT NULL DEFAULT false,
  updated_by       ulid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retention_policies (data_type, archive_after_days, retention_days, enabled) VALUES
  ('valuation',    1825, 2555, false),   -- archive at 5y, purge-eligible at 7y
  ('document',     1825, 2555, false),
  ('calculation',  1825, 2555, false),
  ('email_outbox',  365,  730, false),
  ('audit_event',  NULL,  NULL, false);   -- audit trail kept indefinitely

-- Legal holds freeze data from archival/deletion. Scope 'global' halts all
-- sweeps; 'valuation' / 'user' freeze a specific aggregate.
CREATE TABLE legal_holds (
  id           ulid PRIMARY KEY,
  scope        text NOT NULL CHECK (scope IN ('global', 'valuation', 'user')),
  reference_id ulid,                       -- NULL for global
  reason       text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  placed_by    ulid REFERENCES users(id),
  placed_at    timestamptz NOT NULL DEFAULT now(),
  released_by  ulid REFERENCES users(id),
  released_at  timestamptz
);
CREATE INDEX legal_holds_active_idx ON legal_holds (scope, reference_id) WHERE active;

-- Append-only audit of retention actions.
CREATE TABLE retention_actions (
  id           ulid PRIMARY KEY,
  data_type    text NOT NULL,
  action       text NOT NULL CHECK (action IN ('archived', 'skipped_hold', 'purge_eligible')),
  reference_id ulid,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retention_actions_created_idx ON retention_actions (created_at DESC);

-- Soft archive flag on the valuation aggregate.
ALTER TABLE valuations ADD COLUMN archived_at timestamptz;
CREATE INDEX valuations_archived_idx ON valuations (archived_at) WHERE archived_at IS NOT NULL;
