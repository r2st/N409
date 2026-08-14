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

export interface AdminApiTokenRow extends ApiTokenRow {
  partner_name: string | null;
  partner_key: string | null;
  created_by_email: string | null;
  created_by_name: string | null;
}

/**
 * Every token on the platform, joined to its partner and issuing user
 * (design §14.1). `token_hash` is never selected — the plaintext secret is
 * shown once at creation and only its digest is stored, and a listing that
 * returns the digest hands an attacker an offline target for nothing.
 *
 * Live tokens sort first, then by recency, because the question this list is
 * read to answer — "who currently holds API credentials, and which of those
 * credentials is dormant" — is about the live ones. Revoked rows stay for the
 * audit trail rather than to be scrolled past.
 */
export async function listAllApiTokens(
  pool: pg.Pool,
  opts: { includeRevoked?: boolean; limit?: number } = {},
): Promise<{ tokens: AdminApiTokenRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? TOKEN_PAGE_LIMIT, 1), TOKEN_PAGE_LIMIT);
  const { rows } = await pool.query<AdminApiTokenRow>(
    `SELECT t.id, t.partner_id, t.created_by, t.name, t.token_prefix,
            t.created_at, t.last_used_at, t.revoked_at,
            p.name AS partner_name, p.key AS partner_key,
            u.email AS created_by_email,
            NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS created_by_name
       FROM api_tokens t
       LEFT JOIN partners p ON p.id = t.partner_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE ($1::boolean OR t.revoked_at IS NULL)
      ORDER BY (t.revoked_at IS NULL) DESC, t.created_at DESC
      LIMIT $2`,
    [opts.includeRevoked === true, limit + 1],
  );
  return { tokens: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Ceiling on one page of the platform token listing. */
export const TOKEN_PAGE_LIMIT = 500;

export interface ApiTokenStats {
  total: number;
  live: number;
  dormant: number;
}

/**
 * The three figures the credential listing reports, counted in the database.
 *
 * They used to be `rows.length`, `rows.filter(...)` and so on over the whole
 * table, which is the reason the listing could not simply be capped: bounding
 * the read would have silently bounded the counts with it, and a security
 * listing that under-reports how many live credentials exist is worse than a
 * slow one. Counting here decouples the two, so the rows can be a page while
 * the figures stay platform-wide.
 *
 * `dormant` keeps the definition the route had. A token that has never been
 * used counts as dormant only once it is older than the window — a key minted
 * this morning has not had its chance yet — so the age is measured from
 * `last_used_at` when there is one and from `created_at` when there is not.
 */
export async function apiTokenStats(pool: pg.Pool, dormantAfterMs: number): Promise<ApiTokenStats> {
  const { rows } = await pool.query<{ total: string; live: string; dormant: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE revoked_at IS NULL)::text AS live,
            count(*) FILTER (
              WHERE revoked_at IS NULL
                AND coalesce(last_used_at, created_at) < now() - ($1::bigint * interval '1 millisecond')
            )::text AS dormant
       FROM api_tokens`,
    [Math.trunc(dormantAfterMs)],
  );
  const row = rows[0]!;
  return { total: Number(row.total), live: Number(row.live), dormant: Number(row.dormant) };
}

/** A user's personal tokens — partner tokens they minted for an org are excluded. */
export async function listPersonalApiTokens(pool: pg.Pool, userId: string): Promise<ApiTokenRow[]> {
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
 * Returns null for unknown or revoked tokens, and for an organisation token
 * whose creator is no longer in that organisation.
 *
 * That last clause is the whole point of the join. A partner token is the only
 * credential on this platform that carries an authority the *token row* names
 * rather than one re-read from the presenter: `partnerApi.loadScoped` scopes
 * every request to `token.partner_id` and never consults the user behind it. So
 * when an admin moved a firm's org admin to another firm — or off the firm
 * entirely — the token they had minted went on reading, creating and uploading
 * against their old firm's engagements. One firm's client list, documents and
 * concluded 409As, reachable by someone who had left, with the only remedy
 * being that somebody at the old firm noticed a token in a settings page and
 * revoked it.
 *
 * The session path has always re-read roles and partner from the database on
 * every request, precisely so a change takes effect at once rather than at
 * token expiry. This is that same rule reaching the credential that had been
 * exempt from it.
 *
 * Refused rather than revoked: an admin who moves a user by mistake can move
 * them back and the integration resumes, where a revocation on a failed auth
 * would be permanent and would let a *stolen* token be used to kill a firm's
 * integration. The consequence — a firm's integration stops when the member who
 * minted its key leaves — is the correct one, and the same one every other
 * platform's org tokens have; the firm mints a new key under a current member.
 *
 * Personal tokens (partner_id NULL) are unaffected: they carry only their
 * owner's own scope, which is re-read per request already.
 */
export async function resolveApiToken(
  pool: pg.Pool,
  secret: string,
): Promise<{ tokenId: string; userId: string; partnerId: string | null } | null> {
  const { rows } = await pool.query<{ id: string; created_by: string; partner_id: string | null }>(
    `UPDATE api_tokens t SET last_used_at = now()
       FROM users u
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND u.id = t.created_by
        AND (t.partner_id IS NULL OR u.partner_id = t.partner_id)
     RETURNING t.id, t.created_by, t.partner_id`,
    [hashToken(secret)],
  );
  const row = rows[0];
  return row ? { tokenId: row.id, userId: row.created_by, partnerId: row.partner_id } : null;
}
