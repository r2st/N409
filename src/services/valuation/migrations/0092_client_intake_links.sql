-- Firm-branded client intake links.
--
-- The questionnaire in `intake_questionnaires` belongs to a valuation and needs
-- an account to reach. A firm taking on a new client has neither yet: the point
-- of intake is to collect what the engagement will be built from. This table
-- holds the prospect-facing half — a shareable, expiring link scoped to a firm
-- rather than to a valuation, answerable without an account.
--
-- Mirrors auditor_access (migration 0081) for the token: SHA-256 stored, raw
-- token shown once on creation, revocable and expiring.
CREATE TABLE client_intake_links (
  id               ulid PRIMARY KEY,
  -- The firm whose brand the form wears and whose console it lands in.
  partner_id       ulid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  -- Who the firm sent it to. Free text: at this point the client is a prospect,
  -- not a user, so there is nothing to reference.
  client_name      text,
  client_email     text,
  label            text,
  expires_at       timestamptz NOT NULL,
  created_by       ulid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  last_accessed_at timestamptz,
  access_count     integer NOT NULL DEFAULT 0,
  -- Answers accumulate as the client works through the form; a prospect should
  -- not lose a half-filled questionnaire by closing the tab.
  answers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at     timestamptz,
  -- Set when the firm converts a submission into an engagement. Kept as a link
  -- rather than a copy so the intake record stays the record of what was asked.
  valuation_id     ulid REFERENCES valuations(id) ON DELETE SET NULL
);

CREATE INDEX client_intake_links_partner_idx ON client_intake_links (partner_id, created_at DESC);
