-- HRIS / payroll integration for ASC 718 (feature 11). OAuth2 connections to
-- HR platforms (Rippling, Gusto, Deel) that pull the employee roster and
-- equity grants straight into ASC 718 grant management (option_grants).
-- Mirrors cap_table_connections (0078).
CREATE TYPE hris_provider AS ENUM ('rippling', 'gusto', 'deel');

CREATE TABLE hris_connections (
  id                    ulid PRIMARY KEY,
  valuation_id          ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  provider              hris_provider NOT NULL,
  status                text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'error', 'revoked')),
  external_company_id   text,
  external_company_name text,
  access_token          text NOT NULL,
  refresh_token         text,
  token_expires_at      timestamptz,
  sync_frequency        text NOT NULL DEFAULT 'manual'
                        CHECK (sync_frequency IN ('manual', 'daily', 'weekly')),
  next_sync_at          timestamptz,
  connected_by          ulid REFERENCES users(id),
  connected_at          timestamptz NOT NULL DEFAULT now(),
  last_synced_at        timestamptz,
  last_sync_summary     jsonb,
  last_error            text,
  UNIQUE (valuation_id, provider)
);
CREATE INDEX hris_connections_valuation_idx ON hris_connections (valuation_id);
CREATE INDEX hris_connections_due_idx
  ON hris_connections (next_sync_at)
  WHERE status = 'connected' AND sync_frequency <> 'manual';

-- Provenance for grants sourced from an HRIS, for idempotent re-sync.
ALTER TABLE option_grants
  ADD COLUMN source      text NOT NULL DEFAULT 'manual',
  ADD COLUMN external_id text;
CREATE UNIQUE INDEX option_grants_external_idx
  ON option_grants (valuation_id, external_id) WHERE external_id IS NOT NULL;
