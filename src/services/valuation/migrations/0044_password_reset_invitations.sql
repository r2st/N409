-- P0 #3 password reset + feature #9 user invitations
-- (docs/n409-remaining-features-spec.md). Same conventions as 0001: ULID PKs,
-- timestamptz UTC. Raw tokens only ever live in the emailed link — the DB
-- stores their sha256.

CREATE TABLE password_reset_tokens (
  id           ulid PRIMARY KEY,
  user_id      ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_sha256 text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE user_invitations (
  id           ulid PRIMARY KEY,
  email        text NOT NULL,
  roles        text[] NOT NULL CHECK (cardinality(roles) > 0),
  partner_id   ulid REFERENCES partners(id),
  invited_by   ulid NOT NULL REFERENCES users(id),
  token_sha256 text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- One open invitation per address; revoke (or accept) before re-inviting.
CREATE UNIQUE INDEX user_invitations_pending_email_key
  ON user_invitations (lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
