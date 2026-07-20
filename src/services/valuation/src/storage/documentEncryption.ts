import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope-style encryption of document blobs at rest (audit B-5 P1).
 *
 * A firm holding cap tables, SSNs, and financials shouldn't keep raw uploads on
 * disk in the clear. When DOCUMENTS_ENCRYPTION_KEY is set we AES-256-GCM every
 * stored blob; when it's unset (local dev / tests) blobs are written as-is.
 *
 * On-disk format: MAGIC(8) ‖ IV(12) ‖ authTag(16) ‖ ciphertext. The MAGIC
 * prefix lets reads transparently handle a mix of encrypted and legacy
 * plaintext blobs, so turning the key on doesn't require a migration to keep
 * serving files uploaded before it.
 */
const MAGIC = Buffer.from('N409ENC1');
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null | undefined;

/** Resolve the 32-byte key from hex or base64 env, memoized. Returns null when unset. */
export function documentKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  // Re-read if the env var changed (tests toggle it); cache the common case.
  const raw = env.DOCUMENTS_ENCRYPTION_KEY;
  if (!raw) {
    cachedKey = null;
    return null;
  }
  if (cachedKey && cachedKey.length === 32 && cachedKey.equals(parseKey(raw))) return cachedKey;
  cachedKey = parseKey(raw);
  return cachedKey;
}

function parseKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('DOCUMENTS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  }
  return key;
}

export function isEncrypted(blob: Buffer): boolean {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptDocument(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

export function decryptDocument(blob: Buffer, key: Buffer): Buffer {
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Bytes to write to disk: encrypted when a key is configured, else the plaintext. */
export function encodeForStorage(plain: Buffer, key: Buffer | null = documentKey()): Buffer {
  return key ? encryptDocument(plain, key) : plain;
}

/**
 * Plaintext from a stored blob. Legacy plaintext (no MAGIC) passes through so a
 * newly-enabled key doesn't break older uploads; an encrypted blob with no key
 * available is a hard error rather than silent corruption.
 */
export function decodeFromStorage(stored: Buffer, key: Buffer | null = documentKey()): Buffer {
  if (!isEncrypted(stored)) return stored;
  if (!key) {
    throw new Error('Stored document is encrypted but DOCUMENTS_ENCRYPTION_KEY is not set');
  }
  return decryptDocument(stored, key);
}
