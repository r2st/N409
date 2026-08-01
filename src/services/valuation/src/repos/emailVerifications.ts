import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { hashToken } from './apiTokens.js';

/**
 * Email verification tokens (gap #26). The raw 32-byte secret only ever lives
 * in the emailed link — rows store its sha256. Tokens are single-use, expire
 * after 24 hours, and are bound to the exact address they were sent to, so a
 * link issued for an old address can't verify a since-changed email. Minting a
 * new token retires any outstanding ones for the user.
 */

export const VERIFICATION_TOKEN_TTL = '24 hours';

/** Mints a fresh verification token for `email`, retiring the user's outstanding ones. */
export async function createEmailVerificationToken(
  pool: pg.Pool,
  userId: string,
  email: string,
): Promise<string> {
  const secret = randomBytes(32).toString('base64url');
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO email_verification_tokens (id, user_id, email, token_sha256, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '${VERIFICATION_TOKEN_TTL}')`,
      [newUlid(), userId, email, hashToken(secret)],
    );
  });
  return secret;
}

export type VerifyEmailOutcome = 'verified' | 'already_verified' | 'invalid';

/**
 * Consumes the token and flips `users.verified` atomically. Returns:
 *  - 'verified' when a valid, unused, unexpired token flipped the flag;
 *  - 'already_verified' when the address is already verified (idempotent — a
 *    user who clicks the link twice, or whose account SSO-verified in the
 *    meantime, sees success rather than an error);
 *  - 'invalid' for unknown, expired, already-used tokens, an account that no
 *    longer holds the token's address, or a deactivated account.
 *
 * The token is bound to the address it was minted for: if the user changed
 * their email after the link went out, the address no longer matches and the
 * link is rejected.
 */
export async function verifyEmailWithToken(pool: pg.Pool, rawToken: string): Promise<VerifyEmailOutcome> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ user_id: string; email: string }>(
      `UPDATE email_verification_tokens SET used_at = now()
       WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, email`,
      [hashToken(rawToken)],
    );
    const token = rows[0];
    if (!token) return 'invalid';

    const { rows: userRows } = await client.query<{ verified: boolean }>(
      `SELECT verified FROM users
       WHERE id = $1 AND deleted_at IS NULL AND lower(email) = lower($2)`,
      [token.user_id, token.email],
    );
    const user = userRows[0];
    if (!user) return 'invalid';
    if (user.verified) return 'already_verified';

    await client.query(`UPDATE users SET verified = true WHERE id = $1`, [token.user_id]);
    // A successful verification retires every other outstanding token.
    await client.query(
      `UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [token.user_id],
    );
    return 'verified';
  });
}
