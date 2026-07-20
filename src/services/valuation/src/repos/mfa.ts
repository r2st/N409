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

/** Stage a freshly generated (plaintext base32) secret, un-enabled. */
export async function stageTotpSecret(pool: pg.Pool, userId: string, secretBase32: string): Promise<void> {
  await pool.query(
    `UPDATE users
       SET totp_secret = $2, totp_enabled = false, totp_confirmed_at = NULL
     WHERE id = $1`,
    [userId, encryptSecret(secretBase32)],
  );
}

/**
 * Confirm enrolment: enable TOTP and replace the backup-code set. Returns the
 * plaintext backup codes for one-time display (only their hashes are stored).
 */
export async function confirmTotpEnrollment(pool: pg.Pool, userId: string): Promise<string[]> {
  const codes = generateBackupCodes();
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE users SET totp_enabled = true, totp_confirmed_at = now() WHERE id = $1`,
      [userId],
    );
    await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
    for (const code of codes) {
      await client.query(
        `INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`,
        [newUlid(), userId, hashBackupCode(code)],
      );
    }
  });
  return codes;
}

/** Fully disable 2FA: wipe the secret, backup codes and trusted devices. */
export async function disableTotp(pool: pg.Pool, userId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_confirmed_at = NULL WHERE id = $1`,
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
    for (const code of codes) {
      await client.query(
        `INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`,
        [newUlid(), userId, hashBackupCode(code)],
      );
    }
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

export async function revokeTrustedDevices(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query('DELETE FROM mfa_trusted_devices WHERE user_id = $1', [userId]);
}
