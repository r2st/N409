-- External auditor portal (feature 8). A read-only, scoped view of a single
-- valuation for an outside auditor, reached via a shareable, expiring link.
-- The 'auditor' role is seeded for internal auditor accounts; external access
-- uses the token in auditor_access (no account required).
INSERT INTO roles (key) VALUES ('auditor') ON CONFLICT (key) DO NOTHING;

CREATE TABLE auditor_access (
  id               ulid PRIMARY KEY,
  valuation_id     ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque share token; the raw token is shown once on creation.
  token_hash       text NOT NULL UNIQUE,
  label            text,
  expires_at       timestamptz NOT NULL,
  created_by       ulid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  last_accessed_at timestamptz,
  access_count     integer NOT NULL DEFAULT 0
);

CREATE INDEX auditor_access_valuation_idx ON auditor_access (valuation_id);
