-- 409.ai §23 — accounting software integrations.
-- One OAuth connection per (valuation, provider). Tokens are stored at rest
-- in the database like other credentials on this single-host deployment;
-- move to a KMS-backed secret store before horizontal scaling.

CREATE TYPE accounting_provider AS ENUM
  ('xero', 'quickbooks', 'freshbooks', 'netsuite', 'sage', 'wave');

CREATE TABLE accounting_connections (
  id                  ulid PRIMARY KEY,
  valuation_id        ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  provider            accounting_provider NOT NULL,
  status              text NOT NULL DEFAULT 'connected'
                      CHECK (status IN ('connected', 'error', 'revoked')),
  -- Xero tenantId / QuickBooks realmId / provider org identifier
  external_org_id     text,
  external_org_name   text,
  access_token        text NOT NULL,
  refresh_token       text,
  token_expires_at    timestamptz,
  connected_by        ulid REFERENCES users(id),
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_import_at      timestamptz,
  last_import_summary jsonb,
  last_error          text,
  UNIQUE (valuation_id, provider)
);
CREATE INDEX accounting_connections_valuation_idx ON accounting_connections (valuation_id);
