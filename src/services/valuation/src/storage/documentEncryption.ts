import { envelope, keyRing, type KeyRing } from '../crypto/envelope.js';

/**
 * Envelope-style encryption of document blobs at rest (audit B-5 P1).
 *
 * A firm holding cap tables, SSNs, and financials shouldn't keep raw uploads on
 * disk in the clear. When DOCUMENTS_ENCRYPTION_KEY is set we AES-256-GCM every
 * stored blob; when it's unset (local dev / tests) blobs are written as-is.
 *
 * On-disk format and key parsing come from crypto/envelope.ts, which is also
 * where the reasoning about MAGIC and about the retired key lives. Reads accept
 * DOCUMENTS_ENCRYPTION_KEY_PREVIOUS as well, so the key can be rotated without
 * every file uploaded before the rotation becoming unreadable. Writes only ever
 * use the current key; `tools/rotate-at-rest-keys.mjs` re-seals the backlog,
 * because nothing else in the product ever rewrites a stored document.
 */
const MAGIC = 'N409ENC1';
const box = envelope(MAGIC);

let cachedKey: Buffer | null | undefined;
let cachedRaw: string | undefined;

/**
 * Resolve the 32-byte key from hex or base64 env, memoized. Returns null when
 * unset. This is the key blobs are *written* with; see `documentKeyRing` for
 * the set a read may try.
 */
export function documentKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.DOCUMENTS_ENCRYPTION_KEY;
  if (!raw) {
    cachedKey = null;
    cachedRaw = undefined;
    return null;
  }
  // Only re-parse when the env value actually changed.
  if (cachedKey && cachedRaw === raw) return cachedKey;
  cachedKey = keyRing(env, ['DOCUMENTS_ENCRYPTION_KEY']).current;
  cachedRaw = raw;
  return cachedKey;
}

/** Current key plus the retired one, if `DOCUMENTS_ENCRYPTION_KEY_PREVIOUS` is set. */
export function documentKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  return keyRing(env, ['DOCUMENTS_ENCRYPTION_KEY']);
}

export function isEncrypted(blob: Buffer): boolean {
  return box.isSealed(blob);
}

export function encryptDocument(plain: Buffer, key: Buffer): Buffer {
  return box.seal(plain, key);
}

export function decryptDocument(blob: Buffer, key: Buffer | readonly Buffer[]): Buffer {
  return box.open(blob, Array.isArray(key) ? key : [key as Buffer]);
}

/** Bytes to write to disk: encrypted when a key is configured, else the plaintext. */
export function encodeForStorage(plain: Buffer, key: Buffer | null = documentKey()): Buffer {
  return key ? encryptDocument(plain, key) : plain;
}

/**
 * Plaintext from a stored blob. Legacy plaintext (no MAGIC) passes through so a
 * newly-enabled key doesn't break older uploads; an encrypted blob with no key
 * available is a hard error rather than silent corruption.
 *
 * Omitting `key` reads the whole ring — current key first, then the retired
 * one. Passing an explicit key (or null) pins the read to exactly that, which
 * is what the rotation tool needs to tell "already re-sealed" from "not yet".
 */
export function decodeFromStorage(stored: Buffer, key?: Buffer | null | readonly Buffer[]): Buffer {
  if (!isEncrypted(stored)) return stored;
  const keys =
    key === undefined
      ? documentKeyRing().accepted
      : key === null
        ? []
        : Array.isArray(key)
          ? key
          : [key as Buffer];
  if (keys.length === 0) {
    throw new Error('Stored document is encrypted but DOCUMENTS_ENCRYPTION_KEY is not set');
  }
  return decryptDocument(stored, keys);
}
