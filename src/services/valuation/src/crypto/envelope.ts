import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The one AES-256-GCM envelope this codebase stores secrets in, and the one
 * place a key is turned into bytes.
 *
 * There were two copies of this before — `storage/documentEncryption.ts` and
 * `auth/mfaCrypto.ts` — written months apart, byte-identical in format and
 * subtly different in behaviour: the document one memoized its key and the MFA
 * one refused to write plaintext in production, and neither had a reason to be
 * the one that did. Adding a third for third-party OAuth credentials would have
 * made that three, so the format moved here and the three callers became
 * parameter choices: which MAGIC, which env vars, and whether an unset key is
 * allowed to degrade to plaintext.
 *
 * Wire format, unchanged from both originals so nothing already written needs
 * re-reading: MAGIC(8) ‖ IV(12) ‖ authTag(16) ‖ ciphertext. The MAGIC prefix is
 * what lets a read tell a sealed value from one written before the key existed,
 * so turning a key on never requires a migration.
 *
 * ── Why `open` takes a list of keys ──────────────────────────────────────────
 *
 * Because otherwise the key can never be changed. GCM authenticates, so a value
 * sealed under an old key does not decode to garbage under a new one — it
 * throws. With a single key that makes rotation indistinguishable from data
 * loss: set a new DOCUMENTS_ENCRYPTION_KEY and every document uploaded before
 * that moment becomes permanently unreadable, with no warning until somebody
 * clicks download. A key that cannot be rotated is a key that cannot be
 * rotated *after it leaks*, which is the only time anybody wants to.
 *
 * So decryption accepts the current key and a retired one, tries them in that
 * order, and re-seals under the current key whenever the value is next written.
 * `tools/rotate-at-rest-keys.mjs` walks the one store nothing else rewrites.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const MAGIC_LEN = 8;

/**
 * A 32-byte key from hex or base64.
 *
 * `envVar` is only ever used to name the offending variable in the error. It is
 * required rather than defaulted because "must be 32 bytes" with no subject is
 * the least useful thing a process can say while refusing to start.
 */
export function parseKey(raw: string, envVar: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${envVar} must be 32 bytes (64 hex chars or base64)`);
  }
  return key;
}

/** The keys a store may decrypt with: `current` also being the one it writes. */
export interface KeyRing {
  /** Null when nothing is configured — the store then writes plaintext. */
  current: Buffer | null;
  /**
   * Every key `open` may try, current first. Empty when nothing is configured.
   * A retired key appears here and never in `current`, so it can decrypt what
   * it wrote and can never claim another value.
   */
  accepted: readonly Buffer[];
}

export interface Envelope {
  /** True when `blob` carries this envelope's MAGIC — i.e. is not legacy plaintext. */
  isSealed(blob: Buffer): boolean;
  seal(plain: Buffer, key: Buffer): Buffer;
  /**
   * Opens under the first key that authenticates.
   *
   * A truncated blob is reported as truncated rather than as a key mismatch:
   * the two have different remedies and only one of them is "check your env".
   * When every key fails, the error is the *first* key's — the current one,
   * which is the one the operator is most likely to have got wrong.
   */
  open(blob: Buffer, keys: readonly Buffer[]): Buffer;
}

export function envelope(magicText: string): Envelope {
  const magic = Buffer.from(magicText);
  if (magic.length !== MAGIC_LEN) {
    // A shorter or longer MAGIC would shift every offset below, so this is a
    // programming error caught at module load rather than at first decrypt.
    throw new Error(`envelope magic must be ${MAGIC_LEN} bytes, got ${magic.length} (${magicText})`);
  }
  const HEADER = MAGIC_LEN + IV_LEN + TAG_LEN;

  return {
    isSealed(blob: Buffer): boolean {
      return blob.length >= MAGIC_LEN && blob.subarray(0, MAGIC_LEN).equals(magic);
    },

    seal(plain: Buffer, key: Buffer): Buffer {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([magic, iv, cipher.getAuthTag(), ct]);
    },

    open(blob: Buffer, keys: readonly Buffer[]): Buffer {
      // At least one byte of ciphertext: a zero-length payload is a value that
      // was never sealed, not one that decodes to the empty string.
      if (blob.length < HEADER + 1) {
        throw new Error(`Encrypted value is truncated (${blob.length} bytes, need at least ${HEADER + 1})`);
      }
      if (keys.length === 0) throw new Error('No key available to decrypt a sealed value');
      const iv = blob.subarray(MAGIC_LEN, MAGIC_LEN + IV_LEN);
      const tag = blob.subarray(MAGIC_LEN + IV_LEN, HEADER);
      const ct = blob.subarray(HEADER);
      let firstError: unknown;
      for (const key of keys) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          return Buffer.concat([decipher.update(ct), decipher.final()]);
        } catch (err) {
          firstError ??= err;
        }
      }
      throw firstError;
    },
  };
}

/**
 * The key ring for one *family* of env vars — `NAME` and `NAME_PREVIOUS`.
 *
 * `names` is a fallback chain, and it is resolved as a whole: the first name
 * that has a current key decides the family, and the retired key is read from
 * that same name's `_PREVIOUS`. It deliberately does not mix families. If MFA
 * has its own key, its retired key is `MFA_ENCRYPTION_KEY_PREVIOUS` and the
 * document one is irrelevant; a rotation is a fact about one key, and pulling a
 * neighbouring subsystem's retired key into the ring would let a key that was
 * never used for this store decrypt values in it.
 */
export function keyRing(env: NodeJS.ProcessEnv, names: readonly string[]): KeyRing {
  for (const name of names) {
    const raw = env[name];
    if (!raw) continue;
    const current = parseKey(raw, name);
    const retiredRaw = env[`${name}_PREVIOUS`];
    const accepted = retiredRaw ? [current, parseKey(retiredRaw, `${name}_PREVIOUS`)] : [current];
    return { current, accepted };
  }
  return { current: null, accepted: [] };
}
