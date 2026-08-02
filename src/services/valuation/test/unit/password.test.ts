import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, verifyPasswordOrDecoy } from '../../src/auth/password.js';

/** Milliseconds spent in `fn`, to compare one scrypt against another. */
async function elapsed(fn: () => Promise<unknown>): Promise<number> {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe('password hashing (issue #3)', () => {
  it('hashes and verifies a password', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(digest.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', digest)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', digest)).toBe(false);
  });

  it('produces unique salts per hash', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('rejects malformed digests without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-digest')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$10$whatever')).toBe(false);
  });
});

// ── The absence of a digest must not be observable ──────────────────────────
//
// scrypt is the entire cost of a sign-in request, so skipping it when there is
// no user (or no password on one) answers "does this address have an account?"
// in the response time — an oracle no amount of response-shaping can close,
// because it is not in the response.

describe('verifyPasswordOrDecoy', () => {
  it('still refuses when there is nothing to compare against', async () => {
    expect(await verifyPasswordOrDecoy('x', null)).toBe(false);
    expect(await verifyPasswordOrDecoy('x', undefined)).toBe(false);
    expect(await verifyPasswordOrDecoy('x', '')).toBe(false);
    expect(await verifyPasswordOrDecoy('x', 'not-a-digest')).toBe(false);
  });

  it('still accepts a real password against a real digest', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(await verifyPasswordOrDecoy('correct horse battery staple', digest)).toBe(true);
    expect(await verifyPasswordOrDecoy('wrong password', digest)).toBe(false);
  });

  it('spends the same scrypt work with a digest and without one', async () => {
    const digest = await hashPassword('correct horse battery staple');
    // Warm both paths — the first scrypt of a process is not representative.
    await verifyPasswordOrDecoy('wrong', digest);
    await verifyPasswordOrDecoy('wrong', null);

    const withDigest = await elapsed(() => verifyPasswordOrDecoy('wrong', digest));
    const without = await elapsed(() => verifyPasswordOrDecoy('wrong', null));

    // A generous band: both do exactly one scrypt at the same parameters, so
    // this only has to catch the difference that matters — a path that does no
    // scrypt at all, which was ~33ms against ~0ms. Anything short-circuiting
    // lands orders of magnitude below the floor, not just outside the band.
    expect(without).toBeGreaterThan(withDigest * 0.25);
    expect(without).toBeLessThan(withDigest * 4);
  });

  it('does not depend on the decoy hash failing to match', async () => {
    // The decoy's own comparison result is discarded, so even the 2^-256 case
    // where random bytes happen to be the right hash cannot sign anyone in.
    // Asserted over many calls because a probabilistic guard would look fine in
    // any single one.
    for (let i = 0; i < 25; i += 1) {
      expect(await verifyPasswordOrDecoy(`attempt-${i}`, null)).toBe(false);
    }
  });
});
