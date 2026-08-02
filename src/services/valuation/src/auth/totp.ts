import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) with the standard authenticator-app defaults: SHA-1, 6
 * digits, a 30-second step. Implemented on node:crypto rather than pulling in
 * speakeasy/otplib — the algorithm is small, and keeping it in-tree lets the
 * secret handling sit next to the AES-256-GCM at-rest encryption (mfaCrypto.ts).
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ISSUER = 'N409';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (no padding) — the encoding authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte (160-bit) secret, returned base32-encoded for storage/QR. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The `otpauth://totp/...` URI an authenticator app scans from a QR code. */
export function otpauthUri(secretBase32: string, accountName: string, issuer = TOTP_ISSUER): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** HOTP (RFC 4226): the per-counter code from a base32 secret. */
export function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  // 53-bit safe counter split across the 8-byte big-endian block.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The current TOTP code (used in tests and for symmetry). */
export function totp(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(secretBase32, Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
}

/**
 * Constant-time verification of a submitted code, accepting the adjacent steps
 * (default ±1) to tolerate clock skew and the moment-of-submission boundary.
 * Returns the time-step counter the code matched, or null if none did.
 *
 * Callers authenticating a user want the counter, not just the verdict: RFC
 * 6238 §5.2 requires a code to be accepted once, and "once" is per counter.
 * Every step in the window is checked even after a match so the work does not
 * depend on which step matched.
 */
export function verifyTotpCounter(
  secretBase32: string,
  token: string,
  { window = 1, atMs = Date.now() }: { window?: number; atMs?: number } = {},
): number | null {
  const submitted = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(submitted)) return null;
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  let matched: number | null = null;
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(secretBase32, counter + i);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(submitted))) matched = counter + i;
  }
  return matched;
}

/** Whether a code is currently valid, ignoring replay. */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: { window?: number; atMs?: number } = {},
): boolean {
  return verifyTotpCounter(secretBase32, token, opts) !== null;
}
