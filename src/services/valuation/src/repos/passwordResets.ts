import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { hashToken } from './apiTokens.js';

/**
 * Password reset tokens (P0 #3). The raw 32-byte secret only ever lives in
 * the emailed link — rows store its sha256. Tokens are single-use, expire
 * after 1 hour, and requesting a new one invalidates anything outstanding.
 */

export const RESET_TOKEN_TTL = '1 hour';

/** Mints a fresh token for the user, retiring any outstanding ones. */
export async function createPasswordResetToken(pool: pg.Pool, userId: string): Promise<string> {
  const secret = randomBytes(32).toString('base64url');
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_sha256, expires_at)
       VALUES ($1, $2, $3, now() + interval '${RESET_TOKEN_TTL}')`,
      [newUlid(), userId, hashToken(secret)],
    );
  });
  return secret;
}

/**
 * Consumes the token and sets the new digest atomically. False for unknown,
 * expired, already-used tokens, or a since-deactivated account.
 */
export async function resetPasswordWithToken(
  pool: pg.Pool,
  rawToken: string,
  passwordDigest: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashToken(rawToken)],
    );
    const userId = rows[0]?.user_id;
    if (!userId) return false;
    const { rowCount } = await client.query(
      `UPDATE users SET password_digest = $2 WHERE id = $1 AND deleted_at IS NULL`,
      [userId, passwordDigest],
    );
    if ((rowCount ?? 0) === 0) return false;
    // A successful reset retires every other outstanding token for the user.
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return true;
  });
}
