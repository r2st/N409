-- Live cap-table API sync (feature 4). OAuth2 connections to equity-management
-- providers (Carta, Pulley) that pull the cap table straight into cap_tables
-- (migration 0074). Mirrors the accounting-connections shape (0052): one
-- connection per (valuation, provider), tokens stored at rest on this
-- single-host deployment (move to a KMS before horizontal scaling).
CREATE TYPE cap_table_provider AS ENUM ('carta', 'pulley');

CREATE TABLE cap_table_connections (
  id                 ulid PRIMARY KEY,
  valuation_id       ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  provider           cap_table_provider NOT NULL,
  status             text NOT NULL DEFAULT 'connected'
                     CHECK (status IN ('connected', 'error', 'revoked')),
  external_company_id   text,
  external_company_name text,
  access_token       text NOT NULL,
  refresh_token      text,
  token_expires_at   timestamptz,
  -- Periodic sync cadence; next_sync_at drives the background scheduler.
  sync_frequency     text NOT NULL DEFAULT 'manual'
                     CHECK (sync_frequency IN ('manual', 'daily', 'weekly')),
  next_sync_at       timestamptz,
  connected_by       ulid REFERENCES users(id),
  connected_at       timestamptz NOT NULL DEFAULT now(),
  last_synced_at     timestamptz,
  last_sync_summary  jsonb,
  last_error         text,
  UNIQUE (valuation_id, provider)
);

CREATE INDEX cap_table_connections_valuation_idx ON cap_table_connections (valuation_id);
-- Scheduler scan: due connections that are still connected.
CREATE INDEX cap_table_connections_due_idx
  ON cap_table_connections (next_sync_at)
  WHERE status = 'connected' AND sync_frequency <> 'manual';
