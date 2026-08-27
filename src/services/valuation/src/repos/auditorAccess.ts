import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { newUlid } from '@n409/shared';

/**
 * Shareable, expiring auditor access links (feature 8). The raw token is shown
 * once on creation; only its SHA-256 hash is stored. The token grants a
 * read-only, single-valuation view via the public auditor portal.
 */

export interface AuditorAccessRow {
  id: string;
  valuation_id: string;
  token_hash: string;
  label: string | null;
  expires_at: Date;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  last_accessed_at: Date | null;
  access_count: number;
}

export type PublicAuditorAccess = Omit<AuditorAccessRow, 'token_hash'>;

export function toPublic(row: AuditorAccessRow): PublicAuditorAccess {
  const { token_hash: _t, ...rest } = row;
  return rest;
}

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function createAuditorAccess(
  pool: pg.Pool,
  input: { valuationId: string; label?: string | null; expiresAt: Date; createdBy: string },
): Promise<{ access: AuditorAccessRow; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<AuditorAccessRow>(
    `INSERT INTO auditor_access (id, valuation_id, token_hash, label, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), input.valuationId, hashToken(token), input.label ?? null, input.expiresAt, input.createdBy],
  );
  return { access: rows[0]!, token };
}

export async function listAuditorAccess(pool: pg.Pool, valuationId: string): Promise<AuditorAccessRow[]> {
  const { rows } = await pool.query<AuditorAccessRow>(
    'SELECT * FROM auditor_access WHERE valuation_id = $1 ORDER BY created_at DESC',
    [valuationId],
  );
  return rows;
}

export async function revokeAuditorAccess(
  pool: pg.Pool,
  valuationId: string,
  accessId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE auditor_access SET revoked_at = now()
      WHERE id = $1 AND valuation_id = $2 AND revoked_at IS NULL`,
    [accessId, valuationId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Resolve a raw token to a live (unrevoked, unexpired) access row, recording
 * the access. Returns null for an invalid / revoked / expired token.
 */
/**
 * The same validity test as {@link redeemAuditorToken}, without counting it.
 *
 * `access_count` and `last_accessed_at` answer "how often has this auditor
 * opened the link", and ops read both off the access list to decide whether a
 * link is still in use. A write from the portal — the auditor submitting a note
 * — is not an opening, and redeeming for it would inflate the one figure the
 * list exists to report, on the auditors who engage with the work the most.
 */
export async function verifyAuditorToken(
  pool: pg.Pool,
  rawToken: string,
): Promise<AuditorAccessRow | null> {
  const { rows } = await pool.query<AuditorAccessRow>(
    `SELECT * FROM auditor_access
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

export async function redeemAuditorToken(pool: pg.Pool, rawToken: string): Promise<AuditorAccessRow | null> {
  const { rows } = await pool.query<AuditorAccessRow>(
    `UPDATE auditor_access
        SET last_accessed_at = now(), access_count = access_count + 1
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING *`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}
