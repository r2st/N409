import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { envelope, keyRing, type KeyRing } from '../crypto/envelope.js';

/**
 * At-rest protection for TOTP secrets (feature: MFA/2FA). A TOTP secret is a
 * bearer credential — anyone holding it can mint valid codes — so it is stored
 * AES-256-GCM encrypted, reusing the envelope format and key-resolution rules
 * of storage/documentEncryption.ts. Both now come from crypto/envelope.ts.
 *
 * Encoded form (base64): MAGIC(8) ‖ IV(12) ‖ authTag(16) ‖ ciphertext.
 *
 * The key comes from MFA_ENCRYPTION_KEY, falling back to
 * DOCUMENTS_ENCRYPTION_KEY so a single configured key covers both subsystems.
 * With no key configured (local dev / tests) secrets are stored in the clear —
 * the MAGIC prefix lets reads distinguish the two transparently.
 *
 * Rotation: whichever of those two names supplied the key, its `_PREVIOUS` is
 * also accepted on read. Unlike documents, TOTP secrets need no backfill tool —
 * a rotation is invisible until a user re-enrols, and until then the retired
 * key reads their secret. Drop `_PREVIOUS` once nobody is left on it.
 */
const MAGIC = 'N409MFA1';
const box = envelope(MAGIC);

/** The env names, in the order the fallback prefers them. */
const KEY_NAMES = ['MFA_ENCRYPTION_KEY', 'DOCUMENTS_ENCRYPTION_KEY'] as const;

export function mfaKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  return keyRing(env, KEY_NAMES);
}

export function mfaKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return mfaKeyRing(env).current;
}

/** Encrypt a base32 TOTP secret for storage; returns base64 of the envelope. */
export function encryptSecret(secretBase32: string, key: Buffer | null = mfaKey()): string {
  if (!key) {
    // In production, storing TOTP secrets in plaintext is a data-breach risk.
    // Fail fast rather than silently degrading to unencrypted storage.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MFA_ENCRYPTION_KEY (or DOCUMENTS_ENCRYPTION_KEY) must be set in production — ' +
          'refusing to store TOTP secrets in plaintext.',
      );
    }
    return secretBase32; // dev/test: store plaintext, no MAGIC prefix
  }
  return box.seal(Buffer.from(secretBase32, 'utf8'), key).toString('base64');
}

/**
 * Decrypt a stored secret. Plaintext (dev) passes through unchanged.
 *
 * Omitting `key` reads the whole ring, so a secret sealed under a retired key
 * still verifies. Passing one pins the read to exactly that key.
 */
export function decryptSecret(stored: string, key?: Buffer | null): string {
  let blob: Buffer;
  try {
    blob = Buffer.from(stored, 'base64');
  } catch {
    return stored;
  }
  if (!box.isSealed(blob)) return stored;
  const keys = key === undefined ? mfaKeyRing().accepted : key === null ? [] : [key];
  if (keys.length === 0) throw new Error('TOTP secret is encrypted but no MFA key is configured');
  return box.open(blob, keys).toString('utf8');
}

// ── Backup codes ─────────────────────────────────────────────────────────────
// One-time recovery codes for when the authenticator device is unavailable.
// They are high-entropy random tokens, so a fast SHA-256 hash is sufficient
// (unlike passwords, no slow KDF is needed) and lets verification stay cheap.

const BACKUP_CODE_COUNT = 10;
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

/** Generate N display codes, formatted `XXXX-XXXX` for readability. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let raw = '';
    for (const b of bytes) raw += BACKUP_ALPHABET[b % BACKUP_ALPHABET.length];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

/** Normalise (strip formatting, upper-case) then SHA-256 for storage/compare. */
export function hashBackupCode(code: string): string {
  const normalized = code.replace(/[\s-]+/g, '').toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Constant-time membership test of a submitted code against stored hashes. */
export function backupCodeMatches(code: string, storedHashes: string[]): string | null {
  const candidate = Buffer.from(hashBackupCode(code), 'hex');
  for (const stored of storedHashes) {
    const storedBuf = Buffer.from(stored, 'hex');
    if (storedBuf.length === candidate.length && timingSafeEqual(storedBuf, candidate)) {
      return stored;
    }
  }
  return null;
}
