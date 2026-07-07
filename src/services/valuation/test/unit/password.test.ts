import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

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
