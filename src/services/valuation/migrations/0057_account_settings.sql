-- Account & system settings.
--
-- 1. Profile fields a user maintains themselves. `phone` already existed but
--    was admin-only; these three are new and self-service.
ALTER TABLE users
  ADD COLUMN job_title    text,
  ADD COLUMN company_name text,
  ADD COLUMN timezone     text;

-- 2. Session invalidation. Session JWTs are stateless, so "sign out
--    everywhere" and "a stolen token stops working after a password change"
--    need a server-side counter the token is checked against. Bumping the
--    epoch invalidates every JWT minted before the bump. Wall-clock cutoffs
--    (`sessions_valid_from`) would race against the JWT's second-precision
--    `iat`; a counter cannot.
ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;

-- 3. Personal API tokens. A token has always acted as the user in
--    `created_by`; until now it also had to name a partner. A NULL partner is
--    a personal token — it carries the user's own scope and is rejected by the
--    partner API (which needs an org to scope valuations to).
ALTER TABLE api_tokens ALTER COLUMN partner_id DROP NOT NULL;
CREATE INDEX api_tokens_created_by_idx ON api_tokens (created_by);

-- 4. Runtime-editable system settings. Values are validated against a zod
--    schema (domain/systemSettings.ts) on write, so the jsonb column only ever
--    holds a known key with a well-typed value; unknown keys fall back to the
--    code-side default.
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by ulid REFERENCES users(id)
);
