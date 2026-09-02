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
 * Why a redeem did not set a password. One word per situation, because the
 * three are different incidents and the route answers all of them identically.
 *
 *  - `unknown_token` — no live row for this secret: never existed, already
 *    used, or expired. The ordinary one, and what a guessing sweep produces.
 *  - `closed_account` — the token is live and the account has been closed
 *    since it was minted. The same word the password and Google doors use for
 *    the same state, so a closed account being tried at any door groups.
 *  - `address_changed` — the token is live, the account is live, and the
 *    address the link was sent to is no longer the account's login address.
 *    This is migration 0204's guard firing, and it is the one that means
 *    somebody holds a working link to a mailbox the account has left.
 */
export type PasswordResetRefusal = 'unknown_token' | 'closed_account' | 'address_changed';

/** A redeem's outcome: the subject on success, and why not on every refusal. */
export type PasswordResetOutcome =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: PasswordResetRefusal;
      /** The account the token named, when the token was live enough to name one. */
      userId: string | null;
      /** The address the link was sent to — null for a pre-0204 row, or no row. */
      email: string | null;
    };

/**
 * Redeem a reset token, returning *who* it belonged to.
 *
 * The boolean this used to return was enough for the route's answer and not
 * enough for its audit record: "a password was reset" with no subject is a row
 * nobody can act on. A reset is the one credential change that happens without
 * a session, so it is also the one the trail most needs to name.
 *
 * ## And the refusals, which returned `null` for three different things (R344, M5)
 *
 * `null` was the whole vocabulary, so the route threw one 400 for all of them
 * and the trail recorded nothing at all — a redeem that failed left no row on
 * the spine, no log line (a deliberate 4xx writes neither), and no counter.
 * Every other door onto an account writes in every failing branch and says why
 * inside the row; R272 put the argument in as many words, and the login census
 * holds it. This door — where the token *is* the whole authority and nobody is
 * signed in — was the one that did not.
 *
 * What that cost is specific rather than general. Migration 0204, one round
 * ago, bound a token to the address it was sent to precisely because the
 * ordinary reason a login address moves in a hurry is that the old mailbox is
 * the thing that was compromised. The guard works. It just fires in complete
 * silence: an attacker holding a live link into the abandoned mailbox can
 * present it, be refused, and leave nothing behind for the operator who moved
 * the address to find. `address_changed` is that event, and it is the reason
 * the second UPDATE's two conditions are separated below rather than left as
 * one `rowCount === 0`.
 */
export async function resetPasswordWithToken(
  pool: pg.Pool,
  rawToken: string,
  passwordDigest: string,
): Promise<PasswordResetOutcome> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ user_id: string; email: string | null }>(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, email`,
      [hashToken(rawToken)],
    );
    const userId = rows[0]?.user_id;
    if (!userId) return { ok: false, reason: 'unknown_token', userId: null, email: null };
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
    if ((rowCount ?? 0) === 0) {
      // Which of the two conditions refused it. Asked only on the path that
      // was already refused, so the ordinary redeem still costs what it did,
      // and asked inside the transaction that marked the token used so the
      // answer is the state the refusal was actually taken against.
      const { rows: account } = await client.query<{ deleted: boolean }>(
        'SELECT deleted_at IS NOT NULL AS deleted FROM users WHERE id = $1',
        [userId],
      );
      // A row that is gone entirely reads as closed: the account is not there
      // to have an address, so `address_changed` would be the wrong word.
      const reason = account[0]?.deleted === false ? 'address_changed' : 'closed_account';
      return { ok: false, reason, userId, email: rows[0]?.email ?? null };
    }
    // A successful reset retires every other outstanding token for the user.
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return { ok: true, userId };
  });
}
