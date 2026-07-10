-- Gap #26 (docs/409AI_FEATURE_GAPS.md) — email verification flow.
--
-- The `users.verified` column has existed since 0001 but was only ever flipped
-- by Google SSO (which self-verifies). Email/password sign-ups had no way to
-- prove ownership of the address, so the flag was permanently false. This adds
-- the token store that closes the loop: mint at registration, email a link,
-- flip the flag when the link round-trips.
--
-- Same conventions as password_reset_tokens (0044): ULID PKs, timestamptz UTC,
-- single-use, and the raw 32-byte secret only ever lives in the emailed link —
-- rows store its sha256.

CREATE TABLE email_verification_tokens (
  id           ulid PRIMARY KEY,
  user_id      ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The address the token proves. Stored so a since-changed email can't be
  -- verified by an old link (the token is bound to the address it was sent to).
  email        text NOT NULL,
  token_sha256 text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);
