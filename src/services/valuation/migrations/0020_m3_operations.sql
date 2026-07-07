-- Milestone 3 — Operations (P1 items 10–18, feature-gap-analysis.md).
-- Comment threads (client chat / sticky notes / inbound email), partner API
-- tokens, and soft-deletable users for the admin console.

CREATE TYPE comment_kind AS ENUM ('chat', 'note', 'email');

-- ── Comments: one table, three surfaces ──────────────────────────────────────
-- 'chat'  — per-valuation client conversation (visible to anyone who can read
--           the valuation)
-- 'note'  — internal sticky notes (ops only, pinnable)
-- 'email' — inbound email threaded onto the valuation (ops only)
CREATE TABLE valuation_comments (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  kind         comment_kind NOT NULL,
  author_id    ulid REFERENCES users(id),  -- NULL for inbound email
  body         text NOT NULL,
  email_meta   jsonb,                      -- {from, subject, message_id} for kind='email'
  pinned       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX valuation_comments_valuation_idx ON valuation_comments (valuation_id, created_at);

-- Idempotent email ingestion: the same message never threads twice.
CREATE UNIQUE INDEX valuation_comments_email_msg_key
  ON valuation_comments (valuation_id, (email_meta->>'message_id'))
  WHERE email_meta ? 'message_id';

-- ── Partner API tokens ───────────────────────────────────────────────────────
-- Bearer secret is shown once at creation; only its sha256 is stored. A token
-- authenticates as the user who created it (live RBAC re-read, like JWTs).
CREATE TABLE api_tokens (
  id           ulid PRIMARY KEY,
  partner_id   ulid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  created_by   ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_prefix text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_tokens_partner_idx ON api_tokens (partner_id);

-- ── Admin console: users are soft-deleted ────────────────────────────────────
-- Hard DELETE would break valuation/event FKs; deleted users keep their audit
-- trail but can no longer authenticate.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
