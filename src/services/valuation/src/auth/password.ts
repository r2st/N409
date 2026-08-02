import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

/** scrypt password hashing — no native deps; format: scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

interface ParsedDigest {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

function parseDigest(digest: string): ParsedDigest | null {
  const parts = digest.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  return {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
    salt: Buffer.from(saltB64!, 'base64'),
    expected: Buffer.from(hashB64!, 'base64'),
  };
}

async function compare(password: string, d: ParsedDigest): Promise<boolean> {
  const actual = await scrypt(password, d.salt, d.expected.length, {
    N: d.N,
    r: d.r,
    p: d.p,
    maxmem: MAXMEM,
  });
  return actual.length === d.expected.length && timingSafeEqual(actual, d.expected);
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const parsed = parseDigest(digest);
  if (!parsed) return false;
  return compare(password, parsed);
}

/**
 * A well-formed digest at the current parameters whose hash is simply random.
 * Nothing ever needs to match it — its only job is to give `verifyPasswordOrDecoy`
 * something to burn the same scrypt work on. Built synchronously (no hashPassword
 * call) so the first use costs exactly one scrypt like every later one, rather
 * than two; a one-off asymmetry on the first unknown email is still a signal.
 */
const DECOY_DIGEST = `scrypt$${N}$${R}$${P}$${randomBytes(16).toString('base64')}$${randomBytes(KEYLEN).toString('base64')}`;

/**
 * `verifyPassword` for the sign-in path, where the *absence* of a digest must
 * not be observable. Returning early when there is no user — or no password on
 * one — skips scrypt entirely, and scrypt is the whole cost of the request:
 * ~33ms with a digest against ~0ms without. That gap is an account-enumeration
 * oracle wide enough to read over the open internet, and it survives every
 * response-shaping defence, because it is not in the response. Same story for a
 * soft-deleted account and for a row whose digest is corrupt.
 *
 * So there is no early return. A missing or unparseable digest is compared
 * against a decoy at the same parameters, and the caller gets `false` either
 * way. The decoy's own result is discarded rather than returned: an accidental
 * match is a 2^-256 event, but "an unknown email cannot sign in" should not
 * rest on a probability when it can rest on the control flow.
 */
export async function verifyPasswordOrDecoy(
  password: string,
  digest: string | null | undefined,
): Promise<boolean> {
  const parsed = digest ? parseDigest(digest) : null;
  if (parsed) return compare(password, parsed);
  await compare(password, parseDigest(DECOY_DIGEST)!);
  return false;
}
