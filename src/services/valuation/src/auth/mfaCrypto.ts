import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * At-rest protection for TOTP secrets (feature: MFA/2FA). A TOTP secret is a
 * bearer credential — anyone holding it can mint valid codes — so it is stored
 * AES-256-GCM encrypted, reusing the envelope format and key-resolution rules
 * of storage/documentEncryption.ts.
 *
 * Encoded form (base64): MAGIC(8) ‖ IV(12) ‖ authTag(16) ‖ ciphertext.
 *
 * The key comes from MFA_ENCRYPTION_KEY, falling back to
 * DOCUMENTS_ENCRYPTION_KEY so a single configured key covers both subsystems.
 * With no key configured (local dev / tests) secrets are stored in the clear —
 * the MAGIC prefix lets reads distinguish the two transparently.
 */
const MAGIC = Buffer.from('N409MFA1');
const IV_LEN = 12;
const TAG_LEN = 16;

function parseKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  }
  return key;
}

export function mfaKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.MFA_ENCRYPTION_KEY ?? env.DOCUMENTS_ENCRYPTION_KEY;
  return raw ? parseKey(raw) : null;
}

function isEncrypted(blob: Buffer): boolean {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Encrypt a base32 TOTP secret for storage; returns base64 of the envelope. */
export function encryptSecret(secretBase32: string, key: Buffer | null = mfaKey()): string {
  if (!key) return secretBase32; // dev/test: store plaintext, no MAGIC prefix
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Decrypt a stored secret. Plaintext (dev) passes through unchanged. */
export function decryptSecret(stored: string, key: Buffer | null = mfaKey()): string {
  let blob: Buffer;
  try {
    blob = Buffer.from(stored, 'base64');
  } catch {
    return stored;
  }
  if (!isEncrypted(blob)) return stored;
  if (!key) throw new Error('TOTP secret is encrypted but no MFA key is configured');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
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
