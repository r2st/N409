import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { newUlid } from '@n409/shared';

/**
 * SAML IdP configuration (singleton) + SCIM bearer tokens (feature 9).
 */

export interface SamlConfigRow {
  id: string;
  enabled: boolean;
  idp_entity_id: string | null;
  idp_sso_url: string | null;
  idp_cert: string | null;
  sp_entity_id: string | null;
  allowed_domain: string | null;
  default_role: string;
  updated_by: string | null;
  updated_at: Date;
}

export async function getSamlConfig(pool: pg.Pool): Promise<SamlConfigRow | null> {
  const { rows } = await pool.query<SamlConfigRow>("SELECT * FROM saml_config WHERE id = 'default'");
  return rows[0] ?? null;
}

export async function upsertSamlConfig(
  pool: pg.Pool,
  input: {
    enabled: boolean;
    idpEntityId?: string | null;
    idpSsoUrl?: string | null;
    idpCert?: string | null;
    spEntityId?: string | null;
    allowedDomain?: string | null;
    defaultRole?: string;
    updatedBy: string;
  },
): Promise<SamlConfigRow> {
  const { rows } = await pool.query<SamlConfigRow>(
    `INSERT INTO saml_config
       (id, enabled, idp_entity_id, idp_sso_url, idp_cert, sp_entity_id, allowed_domain, default_role, updated_by, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       idp_entity_id = EXCLUDED.idp_entity_id,
       idp_sso_url = EXCLUDED.idp_sso_url,
       idp_cert = EXCLUDED.idp_cert,
       sp_entity_id = EXCLUDED.sp_entity_id,
       allowed_domain = EXCLUDED.allowed_domain,
       default_role = EXCLUDED.default_role,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [
      input.enabled,
      input.idpEntityId ?? null,
      input.idpSsoUrl ?? null,
      input.idpCert ?? null,
      input.spEntityId ?? null,
      input.allowedDomain ?? null,
      input.defaultRole ?? 'valuation_user',
      input.updatedBy,
    ],
  );
  return rows[0]!;
}

// ── SCIM tokens ──────────────────────────────────────────────────────────────

export interface ScimTokenRow {
  id: string;
  token_hash: string;
  label: string | null;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function createScimToken(
  pool: pg.Pool,
  input: { label?: string | null; createdBy: string },
): Promise<{ row: ScimTokenRow; token: string }> {
  const token = `scim_${randomBytes(32).toString('base64url')}`;
  const { rows } = await pool.query<ScimTokenRow>(
    `INSERT INTO scim_tokens (id, token_hash, label, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [newUlid(), hashToken(token), input.label ?? null, input.createdBy],
  );
  return { row: rows[0]!, token };
}

export const SCIM_TOKEN_PAGE_LIMIT = 200;

/**
 * The SCIM tokens, newest first — a page of them.
 *
 * Revocation writes `revoked_at` rather than deleting the row, on purpose: a
 * token that was once accepted has to stay auditable. So the table only grows,
 * one row per issue, and the admin screen was reading all of it. Live tokens
 * are ordered ahead of revoked ones so a long tail of history can never push
 * an active credential off the page an administrator revokes from — and
 * `verifyScimToken` matches in SQL, so a token past the cut is still honoured
 * and still revocable by id.
 */
export async function listScimTokens(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ tokens: Omit<ScimTokenRow, 'token_hash'>[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? SCIM_TOKEN_PAGE_LIMIT, 1), SCIM_TOKEN_PAGE_LIMIT);
  const { rows } = await pool.query<ScimTokenRow>(
    `SELECT * FROM scim_tokens
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC
      LIMIT $1`,
    [limit + 1],
  );
  const tokens = rows.slice(0, limit).map(({ token_hash: _t, ...rest }) => rest);
  return { tokens, truncated: rows.length > limit };
}

export async function revokeScimToken(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Validate a raw SCIM bearer token; records use. Returns true if valid. */
/**
 * Verify a SCIM bearer token and stamp its use, returning *which* token it was.
 *
 * The id was already selected and thrown away. It is the only thing that can
 * name the actor behind a SCIM write: these routes have no principal — an IdP
 * connector holds a bearer token and creates and deactivates accounts with it —
 * so an audit row for a deprovision would otherwise say "system" and leave a
 * firm with two directory integrations unable to tell which one did it.
 */
export async function verifyScimToken(pool: pg.Pool, rawToken: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE scim_tokens SET last_used_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [hashToken(rawToken)],
  );
  return rows[0]?.id ?? null;
}
