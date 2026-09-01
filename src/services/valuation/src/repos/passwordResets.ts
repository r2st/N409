import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { hashToken } from './apiTokens.js';

/**
 * Password reset tokens (P0 #3). The raw 32-byte secret only ever lives in
 * the emailed link — rows store its sha256. Tokens are single-use, expire
 * after 1 hour, requesting a new one invalidates anything outstanding, and each
 * is bound to the address it was sent to, so a link issued before a login email
 * moved cannot set the password afterwards (0204).
 */

export const RESET_TOKEN_TTL = '1 hour';

/**
 * Mints a fresh token for the user, retiring any outstanding ones.
 *
 * BOUND TO THE ADDRESS IT IS ABOUT TO BE SENT TO (round 342, methodology M3).
 * A reset token named a `user_id` and nothing else, and the link goes to
 * whichever address is on the account at the moment of minting. Three doors
 * move that address — the self-service profile PATCH, the admin console's
 * `ADMIN_PATCH_COLUMNS` (which includes `email` and demands nothing from the
 * subject), and SCIM provisioning — and none of them touched this table. So a
 * link already sitting in the old mailbox went on working, and redeeming it
 * sets `password_digest` and bumps `session_epoch`: it takes the account and
 * signs the owner out of it. The ordinary reason to move a login address in a
 * hurry is that the old mailbox is the thing that was compromised, so the
 * remediation left the exploit live for the rest of the hour.
 *
 * `email_verification_tokens` solved this the round it was created and its own
 * schema comment states the rule — "stored so a since-changed email can't be
 * verified by an old link". The higher-value credential beside it never got the
 * column. Migration 0204 is that column.
 *
 * Read from the row here rather than passed in by the two callers. Both have
 * the address to hand, and a rule spelled at each call site is one the third
 * caller will not spell — the same argument `releaseAssignedWork` makes about
 * its three doors. Reading it under the same transaction as the INSERT also
 * makes the stored address the one the link is actually addressed to, rather
 * than one from a read the caller took earlier.
 */
export async function createPasswordResetToken(pool: pg.Pool, userId: string): Promise<string> {
  const secret = randomBytes(32).toString('base64url');
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO password_reset_tokens (id, user_id, email, token_sha256, expires_at)
       SELECT $1, u.id, u.email, $3, now() + interval '${RESET_TOKEN_TTL}'
         FROM users u WHERE u.id = $2`,
      [newUlid(), userId, hashToken(secret)],
    );
  });
  return secret;
}

/**
 * Consumes the token and sets the new digest atomically. False for unknown,
 * expired, already-used tokens, or a since-deactivated account.
 *
 * The reset also bumps `session_epoch`: whoever forced the reset — the user
 * who forgot their password, or an admin acting on a compromise — expects
 * every session already out there to stop working.
 */
/**
 * Redeem a reset token, returning *who* it belonged to.
 *
 * The boolean this used to return was enough for the route's answer and not
 * enough for its audit record: "a password was reset" with no subject is a row
 * nobody can act on. A reset is the one credential change that happens without
 * a session, so it is also the one the trail most needs to name.
 */
export async function resetPasswordWithToken(
  pool: pg.Pool,
  rawToken: string,
  passwordDigest: string,
): Promise<{ userId: string } | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ user_id: string; email: string | null }>(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, email`,
      [hashToken(rawToken)],
    );
    const userId = rows[0]?.user_id;
    if (!userId) return null;
    // The address half of the guard. A token whose address no longer matches
    // the account's is one the login email moved away from since the link went
    // out — see {@link createPasswordResetToken}. It is still marked used
    // above, which is the same treatment the closed-account arm gets: the
    // presenter learns nothing from the difference, and a link that has been
    // refused once should not be worth presenting again.
    //
    // A NULL address is a row minted before migration 0204 and means "not
    // bound", not "matches nothing" — refusing those would have invalidated
    // every reset link in flight at deploy, and `RESET_TOKEN_TTL` closes that
    // window an hour later on its own.
    const { rowCount } = await client.query(
      `UPDATE users
       SET password_digest = $2, session_epoch = session_epoch + 1
       WHERE id = $1 AND deleted_at IS NULL
         AND ($3::text IS NULL OR lower(email) = lower($3))`,
      [userId, passwordDigest, rows[0]?.email ?? null],
    );
    if ((rowCount ?? 0) === 0) return null;
    // A successful reset retires every other outstanding token for the user.
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return { userId };
  });
}
