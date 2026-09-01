import type pg from 'pg';
import { createHash } from 'node:crypto';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { encryptSecret, generateBackupCodes, hashBackupCode } from '../auth/mfaCrypto.js';

/**
 * Persistence for TOTP 2FA (migration 0077). Enrolment is two-phase: the
 * encrypted secret is staged un-enabled, then a first valid code confirms it
 * and materialises the backup codes. All secret encryption happens here so the
 * plaintext base32 never touches the database.
 */

/**
 * Stage a freshly generated (plaintext base32) secret, un-enabled.
 *
 * False when the account already has 2FA on, and the predicate is the point:
 * this statement clears `totp_enabled` and `totp_confirmed_at` on its way past.
 * The route refuses a re-enrolment ("disable it first"), but that read is one
 * statement earlier on another connection, so a `/setup` racing the `/confirm`
 * that finishes an enrolment saw an un-enrolled account and then turned the
 * factor back off — silently, with no `user_mfa_disabled` on the admin trail
 * and with the user holding the backup codes `/confirm` had just handed them.
 * The one thing the second factor must not do is come off without being asked.
 *
 * Not `AND totp_secret IS NULL` as well: re-staging over an *unconfirmed*
 * secret is what re-opening the setup page does, and the route's comment says
 * so — harmless, because nothing is enabled until `/confirm`.
 */
export async function stageTotpSecret(pool: pg.Pool, userId: string, secretBase32: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE users
       SET totp_secret = $2, totp_enabled = false, totp_confirmed_at = NULL
     WHERE id = $1 AND totp_enabled = false`,
    [userId, encryptSecret(secretBase32)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Insert a whole backup-code set in one statement.
 *
 * One round trip rather than one per code, batched over unnest() arrays the
 * same way `workbook.ts` batches a bulk cell paste. This runs inside the
 * login-critical enrolment transaction, so the round trips it saves are ones
 * a user waits on while holding a write lock on their own row.
 */
async function insertBackupCodes(client: pg.ClientBase, userId: string, codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  await client.query(
    `INSERT INTO mfa_backup_codes (id, user_id, code_hash)
     SELECT id, $1, code_hash FROM unnest($2::ulid[], $3::text[]) AS t(id, code_hash)`,
    [userId, codes.map(() => newUlid()), codes.map(hashBackupCode)],
  );
}

/**
 * Confirm enrolment: enable TOTP and replace the backup-code set. Returns the
 * plaintext backup codes for one-time display (only their hashes are stored).
 */
export async function confirmTotpEnrollment(pool: pg.Pool, userId: string): Promise<string[]> {
  const codes = generateBackupCodes();
  await withTransaction(pool, async (client) => {
    await client.query(`UPDATE users SET totp_enabled = true, totp_confirmed_at = now() WHERE id = $1`, [
      userId,
    ]);
    await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
    await insertBackupCodes(client, userId, codes);
  });
  return codes;
}

/**
 * Claim a TOTP time-step for this user, refusing one already used (migration
 * 0097, RFC 6238 §5.2). Returns false when the code has been spent.
 *
 * The compare and the write are one conditional UPDATE rather than a read
 * followed by a write, because the case worth defending against is precisely
 * two submissions of the same code arriving together — a phishing proxy
 * replaying what the user typed races the user's own login. Read-then-write
 * would let both see an older counter and both succeed, which is the whole
 * attack.
 */
export async function consumeTotpCounter(pool: pg.Pool, userId: string, counter: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE users SET totp_last_counter = $2
      WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)`,
    [userId, counter],
  );
  return (rowCount ?? 0) > 0;
}

/** Fully disable 2FA: wipe the secret, backup codes and trusted devices. */
export async function disableTotp(pool: pg.Pool, userId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE users
          SET totp_secret = NULL, totp_enabled = false,
              totp_confirmed_at = NULL, totp_last_counter = NULL
        WHERE id = $1`,
      [userId],
    );
    await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM mfa_trusted_devices WHERE user_id = $1', [userId]);
  });
}

/** Regenerate the backup-code set (invalidates the old one). */
export async function regenerateBackupCodes(pool: pg.Pool, userId: string): Promise<string[]> {
  const codes = generateBackupCodes();
  await withTransaction(pool, async (client) => {
    await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
    await insertBackupCodes(client, userId, codes);
  });
  return codes;
}

export async function listUnusedBackupCodeHashes(pool: pg.Pool, userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ code_hash: string }>(
    'SELECT code_hash FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return rows.map((r) => r.code_hash);
}

export async function countUnusedBackupCodes(pool: pg.Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Consume a backup code by its stored hash. Returns true if it was unused. */
export async function consumeBackupCode(pool: pg.Pool, userId: string, codeHash: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE mfa_backup_codes SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, codeHash],
  );
  return (rowCount ?? 0) > 0;
}

// ── Trusted devices ("remember this device for 30 days") ─────────────────────

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function trustDevice(
  pool: pg.Pool,
  userId: string,
  rawToken: string,
  expiresAt: Date,
  label?: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO mfa_trusted_devices (id, user_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, last_used_at = now()`,
    [newUlid(), userId, sha256(rawToken), label ?? null, expiresAt],
  );
}

/** True if the raw device token is a live, unexpired trust for this user. */
export async function isDeviceTrusted(pool: pg.Pool, userId: string, rawToken: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE mfa_trusted_devices SET last_used_at = now()
     WHERE user_id = $1 AND token_hash = $2 AND expires_at > now()
     RETURNING id`,
    [userId, sha256(rawToken)],
  );
  return rows.length > 0;
}
