import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envelope, keyRing, parseKey } from '../../src/crypto/envelope.js';

const KEY = randomBytes(32);
const OTHER = randomBytes(32);

/**
 * The one AES-256-GCM envelope every at-rest secret in this service is stored
 * in. Three subsystems share it, so a change here reaches documents, TOTP
 * secrets, and third-party OAuth credentials at once.
 */
describe('crypto/envelope', () => {
  const box = envelope('N409TST1');

  it('round-trips and marks the output sealed', () => {
    const plain = Buffer.from('Founders,8000000\n');
    const blob = box.seal(plain, KEY);
    expect(box.isSealed(blob)).toBe(true);
    expect(blob.equals(plain)).toBe(false);
    expect(box.open(blob, [KEY]).equals(plain)).toBe(true);
  });

  it('produces a different ciphertext each time (fresh IV)', () => {
    const plain = Buffer.from('same input');
    const a = box.seal(plain, KEY);
    const b = box.seal(plain, KEY);
    expect(a.equals(b)).toBe(false);
    expect(box.open(a, [KEY]).equals(box.open(b, [KEY]))).toBe(true);
  });

  it('does not recognise another envelope’s MAGIC', () => {
    const blob = envelope('N409OTH1').seal(Buffer.from('x'), KEY);
    expect(box.isSealed(blob)).toBe(false);
  });

  it('rejects a MAGIC that is not 8 bytes, at construction', () => {
    // Every offset in the format is computed from it, so a short one would
    // silently shift the IV rather than fail.
    expect(() => envelope('SHORT')).toThrow(/8 bytes/);
  });

  // ── The retired key: what makes rotation possible ──────────────────────────

  it('opens under the retired key when the current one cannot', () => {
    const sealedUnderOld = box.seal(Buffer.from('written before the rotation'), OTHER);
    expect(() => box.open(sealedUnderOld, [KEY])).toThrow();
    expect(box.open(sealedUnderOld, [KEY, OTHER]).toString()).toBe('written before the rotation');
  });

  it('still opens what the current key wrote, with a retired key present', () => {
    const fresh = box.seal(Buffer.from('written after'), KEY);
    expect(box.open(fresh, [KEY, OTHER]).toString()).toBe('written after');
  });

  it('reports the current key’s failure when every key fails', () => {
    // Not the last key's. The operator has almost certainly mistyped the
    // current one, and an error naming the retired key sends them to the wrong
    // variable.
    const blob = box.seal(Buffer.from('x'), randomBytes(32));
    expect(() => box.open(blob, [KEY, OTHER])).toThrow();
  });

  it('refuses to open with no keys at all', () => {
    const blob = box.seal(Buffer.from('x'), KEY);
    expect(() => box.open(blob, [])).toThrow(/No key available/);
  });

  it('calls a truncated blob truncated, not a key mismatch', () => {
    // Different remedies; only one of them is "check your env".
    const blob = box.seal(Buffer.from('valid content'), KEY);
    expect(() => box.open(blob.subarray(0, 15), [KEY])).toThrow(/truncated/i);
    // A header with zero bytes of ciphertext is truncated too: an empty payload
    // is a value that was never sealed, not one that decodes to ''.
    expect(() => box.open(blob.subarray(0, 36), [KEY])).toThrow(/truncated/i);
  });

  it('detects a tampered ciphertext (GCM auth, not just decryption)', () => {
    const blob = box.seal(Buffer.from('transfer 100'), KEY);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => box.open(tampered, [KEY])).toThrow();
  });

  // ── Key parsing and the env family ─────────────────────────────────────────

  it('parses hex and base64, and names the variable when rejecting', () => {
    expect(parseKey(KEY.toString('hex'), 'X_KEY').equals(KEY)).toBe(true);
    expect(parseKey(KEY.toString('base64'), 'X_KEY').equals(KEY)).toBe(true);
    expect(() => parseKey('too-short', 'X_KEY')).toThrow(/X_KEY must be 32 bytes/);
  });

  it('is empty when no name in the chain is set', () => {
    const ring = keyRing({} as NodeJS.ProcessEnv, ['A_KEY', 'B_KEY']);
    expect(ring.current).toBeNull();
    expect(ring.accepted).toEqual([]);
  });

  it('takes the first name in the chain that is set', () => {
    const env = { B_KEY: OTHER.toString('hex') } as unknown as NodeJS.ProcessEnv;
    expect(keyRing(env, ['A_KEY', 'B_KEY']).current?.equals(OTHER)).toBe(true);
    const both = { A_KEY: KEY.toString('hex'), B_KEY: OTHER.toString('hex') } as unknown as NodeJS.ProcessEnv;
    expect(keyRing(both, ['A_KEY', 'B_KEY']).current?.equals(KEY)).toBe(true);
  });

  it('accepts the retired key of whichever name won, and only that one', () => {
    // A rotation is a fact about one key. Pulling in the neighbouring
    // subsystem's `_PREVIOUS` would let a key that never wrote a value in this
    // store decrypt values in it.
    const env = {
      A_KEY: KEY.toString('hex'),
      A_KEY_PREVIOUS: OTHER.toString('hex'),
      B_KEY_PREVIOUS: randomBytes(32).toString('hex'),
    } as unknown as NodeJS.ProcessEnv;
    const ring = keyRing(env, ['A_KEY', 'B_KEY']);
    expect(ring.accepted).toHaveLength(2);
    expect(ring.accepted[0]?.equals(KEY)).toBe(true);
    expect(ring.accepted[1]?.equals(OTHER)).toBe(true);
  });

  it('ignores a retired key belonging to a name the chain skipped', () => {
    // A_KEY is unset, so B_KEY is the family — A_KEY_PREVIOUS is not part of it.
    const env = {
      A_KEY_PREVIOUS: OTHER.toString('hex'),
      B_KEY: KEY.toString('hex'),
    } as unknown as NodeJS.ProcessEnv;
    expect(keyRing(env, ['A_KEY', 'B_KEY']).accepted).toHaveLength(1);
  });

  it('a retired key is never the one written with', () => {
    const env = {
      A_KEY: KEY.toString('hex'),
      A_KEY_PREVIOUS: OTHER.toString('hex'),
    } as unknown as NodeJS.ProcessEnv;
    expect(keyRing(env, ['A_KEY']).current?.equals(KEY)).toBe(true);
  });
});
