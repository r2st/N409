-- Enterprise SSO: SAML 2.0 SP + SCIM 2.0 provisioning (feature 9).

-- Singleton IdP configuration (one enterprise IdP per deployment). id is fixed
-- to 'default' so upserts target the single row.
CREATE TABLE saml_config (
  id            text PRIMARY KEY DEFAULT 'default',
  enabled       boolean NOT NULL DEFAULT false,
  idp_entity_id text,
  idp_sso_url   text,          -- IdP SingleSignOnService URL (entryPoint)
  idp_cert      text,          -- IdP signing certificate (PEM/base64 body)
  sp_entity_id  text,          -- our SP entity id (issuer)
  -- Only assertions whose email domain matches are JIT-provisioned, when set.
  allowed_domain text,
  default_role  text NOT NULL DEFAULT 'valuation_user',
  updated_by    ulid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Bearer tokens for the SCIM 2.0 endpoint (an IdP/SCIM client authenticates
-- with one of these). Only the SHA-256 hash is stored.
CREATE TABLE scim_tokens (
  id           ulid PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  label        text,
  created_by   ulid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Track which users were provisioned by SCIM (for external_id round-tripping).
ALTER TABLE users
  ADD COLUMN scim_external_id text,
  ADD COLUMN provisioned_by   text;   -- 'scim' | 'saml' | NULL (local)

CREATE UNIQUE INDEX users_scim_external_id_idx ON users (scim_external_id) WHERE scim_external_id IS NOT NULL;

-- SAML/SCIM users have neither a password nor a Google sso_provider; allow a
-- provisioned account to satisfy the auth-method constraint.
ALTER TABLE users DROP CONSTRAINT users_auth_method;
ALTER TABLE users ADD CONSTRAINT users_auth_method
  CHECK (password_digest IS NOT NULL OR sso_provider IS NOT NULL OR provisioned_by IS NOT NULL);
