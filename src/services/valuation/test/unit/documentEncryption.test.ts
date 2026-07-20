import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeFromStorage,
  decryptDocument,
  documentKey,
  encodeForStorage,
  encryptDocument,
  isEncrypted,
} from '../../src/storage/documentEncryption.js';

const KEY = randomBytes(32);
const HEX_KEY = KEY.toString('hex');

/** Document-at-rest encryption (audit B-5 P1). */
describe('documentEncryption', () => {
  const original = process.env.DOCUMENTS_ENCRYPTION_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.DOCUMENTS_ENCRYPTION_KEY;
    else process.env.DOCUMENTS_ENCRYPTION_KEY = original;
  });

  it('round-trips a blob and marks it encrypted', () => {
    const plain = Buffer.from('Founders,8000000\nPreferred,2000000\n');
    const blob = encryptDocument(plain, KEY);
    expect(isEncrypted(blob)).toBe(true);
    expect(blob.equals(plain)).toBe(false);
    expect(decryptDocument(blob, KEY).equals(plain)).toBe(true);
  });

  it('fails to decrypt with the wrong key (GCM auth)', () => {
    const blob = encryptDocument(Buffer.from('secret'), KEY);
    expect(() => decryptDocument(blob, randomBytes(32))).toThrow();
  });

  it('parses a 64-hex-char and a base64 key, rejects a wrong length', () => {
    process.env.DOCUMENTS_ENCRYPTION_KEY = HEX_KEY;
    expect(documentKey()?.equals(KEY)).toBe(true);
    process.env.DOCUMENTS_ENCRYPTION_KEY = KEY.toString('base64');
    expect(documentKey()?.length).toBe(32);
    process.env.DOCUMENTS_ENCRYPTION_KEY = 'too-short';
    expect(() => documentKey()).toThrow(/32 bytes/);
  });

  it('returns null and stores plaintext when no key is configured', () => {
    delete process.env.DOCUMENTS_ENCRYPTION_KEY;
    expect(documentKey()).toBeNull();
    const plain = Buffer.from('plaintext');
    expect(encodeForStorage(plain, null).equals(plain)).toBe(true);
    expect(isEncrypted(plain)).toBe(false);
  });

  it('encodeForStorage/decodeFromStorage are inverse with a key', () => {
    const plain = Buffer.from('cap table bytes');
    const stored = encodeForStorage(plain, KEY);
    expect(isEncrypted(stored)).toBe(true);
    expect(decodeFromStorage(stored, KEY).equals(plain)).toBe(true);
  });

  it('reads legacy plaintext transparently even with a key set', () => {
    const legacy = Buffer.from('uploaded before encryption');
    expect(decodeFromStorage(legacy, KEY).equals(legacy)).toBe(true);
  });

  it('refuses an encrypted blob when no key is available', () => {
    const blob = encryptDocument(Buffer.from('x'), KEY);
    expect(() => decodeFromStorage(blob, null)).toThrow(/not set/);
  });
});
