-- Share tokens for public valuation summary pages (viral sharing feature).
-- Each token grants read access to a redacted summary of one valuation.

CREATE TABLE valuation_share_tokens (
  token       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  valuation_id TEXT NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '90 days',
  view_count  INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_share_tokens_valuation ON valuation_share_tokens (valuation_id);
