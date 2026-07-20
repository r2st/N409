-- MFA / 2FA via TOTP (RFC 6238). A password account can enrol a TOTP
-- authenticator; enrolment stores an AES-256-GCM-encrypted secret (auth/
-- mfaCrypto.ts) and one-time backup codes, and login gains a second-factor
-- challenge. Google-SSO accounts defer to the IdP and are unaffected.
ALTER TABLE users
  ADD COLUMN totp_secret       text,               -- encrypted base32 secret
  ADD COLUMN totp_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_confirmed_at timestamptz;         -- first successful verify

-- One-time recovery codes (SHA-256 hashes). A row is consumed by setting
-- used_at; a fresh enrolment / regeneration deletes the prior set.
CREATE TABLE mfa_backup_codes (
  id         ulid PRIMARY KEY,
  user_id    ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

CREATE INDEX mfa_backup_codes_user_idx ON mfa_backup_codes (user_id);

-- "Remember this device for 30 days": a hashed opaque token set as a cookie so
-- the second-factor challenge is skipped on a known browser until it expires.
CREATE TABLE mfa_trusted_devices (
  id           ulid PRIMARY KEY,
  user_id      ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  label        text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX mfa_trusted_devices_user_idx ON mfa_trusted_devices (user_id, expires_at DESC);
