import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';

/**
 * API tokens (M3 feature 14). The bearer secret (`n409_pat_…`) is returned
 * exactly once at creation; only its sha256 digest is stored.
 *
 * A token always acts as the user in `created_by`. With a `partner_id` it is a
 * partner token, usable against the programmatic partner API. With a NULL
 * `partner_id` it is a *personal* token: it carries only its owner's own scope,
 * which is what lets a client user script against their own valuations.
 */

export const TOKEN_SCHEME = 'n409_pat_';

export interface ApiTokenRow {
  id: string;
  partner_id: string | null;
  created_by: string;
  name: string;
  token_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export async function createApiToken(
  pool: pg.Pool,
  args: { partnerId: string | null; createdBy: string; name: string },
): Promise<{ token: ApiTokenRow; secret: string }> {
  const secret = `${TOKEN_SCHEME}${randomBytes(32).toString('base64url')}`;
  const prefix = secret.slice(0, TOKEN_SCHEME.length + 6);
  const { rows } = await pool.query<ApiTokenRow>(
    `INSERT INTO api_tokens (id, partner_id, created_by, name, token_prefix, token_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at`,
    [newUlid(), args.partnerId, args.createdBy, args.name, prefix, hashToken(secret)],
  );
  return { token: rows[0]!, secret };
}

export async function listApiTokens(pool: pg.Pool, partnerId: string): Promise<ApiTokenRow[]> {
  const { rows } = await pool.query<ApiTokenRow>(
    `SELECT id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE partner_id = $1 ORDER BY created_at DESC`,
    [partnerId],
  );
  return rows;
}

/** A user's personal tokens — partner tokens they minted for an org are excluded. */
export async function listPersonalApiTokens(
  pool: pg.Pool,
  userId: string,
): Promise<ApiTokenRow[]> {
  const { rows } = await pool.query<ApiTokenRow>(
    `SELECT id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE created_by = $1 AND partner_id IS NULL ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/** Revokes every live token a user owns — used when closing an account. */
export async function revokeTokensOwnedBy(pool: pg.Pool, userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    'UPDATE api_tokens SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rowCount ?? 0;
}

export async function findApiTokenById(pool: pg.Pool, id: string): Promise<ApiTokenRow | null> {
  const { rows } = await pool.query<ApiTokenRow>(
    `SELECT id, partner_id, created_by, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function revokeApiToken(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Resolve a presented secret to the user it acts as. Touches last_used_at.
 * Returns null for unknown or revoked tokens.
 */
export async function resolveApiToken(
  pool: pg.Pool,
  secret: string,
): Promise<{ tokenId: string; userId: string; partnerId: string | null } | null> {
  const { rows } = await pool.query<{ id: string; created_by: string; partner_id: string | null }>(
    `UPDATE api_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, created_by, partner_id`,
    [hashToken(secret)],
  );
  const row = rows[0];
  return row ? { tokenId: row.id, userId: row.created_by, partnerId: row.partner_id } : null;
}
