import { describe, it, expect } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
  TOTP_PERIOD_SECONDS,
} from '../../src/auth/totp.js';
import {
  backupCodeMatches,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  hashBackupCode,
} from '../../src/auth/mfaCrypto.js';

// RFC 4226 Appendix D reference secret ("12345678901234567890").
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_HOTP = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const buf = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('!!!!')).toThrow();
  });
});

describe('HOTP (RFC 4226 vectors)', () => {
  it.each(RFC_HOTP.map((code, counter) => [counter, code]))(
    'counter %i -> %s',
    (counter, expected) => {
      expect(hotp(RFC_SECRET, counter as number)).toBe(expected);
    },
  );
});

describe('TOTP', () => {
  it('is HOTP over the 30s time step', () => {
    const atMs = 1_000_000 * 1000;
    const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
    expect(totp(RFC_SECRET, atMs)).toBe(hotp(RFC_SECRET, counter));
  });

  it('accepts the current code', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now), { atMs: now })).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
  });

  it('tolerates ±1 step of clock skew but not more', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000 * 1000;
    const prev = totp(secret, now - TOTP_PERIOD_SECONDS * 1000);
    const twoAgo = totp(secret, now - 2 * TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp(secret, prev, { atMs: now })).toBe(true);
    expect(verifyTotp(secret, twoAgo, { atMs: now, window: 1 })).toBe(false);
  });

  it('builds an otpauth URI carrying the secret and issuer', () => {
    const uri = otpauthUri('ABCDEF', 'user@example.com', 'N409');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('secret=ABCDEF');
    expect(uri).toContain('issuer=N409');
  });
});

describe('backup codes', () => {
  it('generates ten formatted codes', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('hashes deterministically, ignoring case and separators', () => {
    expect(hashBackupCode('ABCD-EFGH')).toBe(hashBackupCode('abcd efgh'));
  });

  it('matches a known code in constant time and rejects unknown ones', () => {
    const codes = generateBackupCodes();
    const hashes = codes.map(hashBackupCode);
    expect(backupCodeMatches(codes[0]!, hashes)).toBe(hashes[0]);
    expect(backupCodeMatches('ZZZZ-ZZZZ', hashes)).toBeNull();
  });
});

describe('secret encryption', () => {
  const KEY = Buffer.alloc(32, 7);

  it('round-trips with a key', () => {
    const secret = generateTotpSecret();
    const enc = encryptSecret(secret, KEY);
    expect(enc).not.toBe(secret);
    expect(decryptSecret(enc, KEY)).toBe(secret);
  });

  it('stores plaintext when no key is configured in dev/test', () => {
    const secret = generateTotpSecret();
    expect(encryptSecret(secret, null)).toBe(secret);
    expect(decryptSecret(secret, null)).toBe(secret);
  });

  it('throws in production when no encryption key is configured', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => encryptSecret(generateTotpSecret(), null)).toThrow(
        /must be set in production/,
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('fails to decrypt with the wrong key', () => {
    const enc = encryptSecret(generateTotpSecret(), KEY);
    expect(() => decryptSecret(enc, Buffer.alloc(32, 9))).toThrow();
  });
});
