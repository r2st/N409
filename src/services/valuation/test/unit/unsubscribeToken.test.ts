import { describe, expect, it } from 'vitest';
import {
  createUnsubscribeToken,
  unsubscribeUrl,
  UNSUBSCRIBE_TTL_MS,
  verifyUnsubscribeToken,
} from '../../src/domain/unsubscribeToken.js';

const SECRET = 'a-secret-at-least-thirty-two-characters';
const USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('unsubscribe tokens', () => {
  it('round-trips the user and scope it was minted for', () => {
    const token = createUnsubscribeToken({ userId: USER, scope: 'marketing' }, SECRET);
    const claims = verifyUnsubscribeToken(token, SECRET);
    expect(claims?.userId).toBe(USER);
    expect(claims?.scope).toBe('marketing');
  });

  it('rejects a token signed with a different secret', () => {
    const token = createUnsubscribeToken({ userId: USER, scope: 'marketing' }, SECRET);
    expect(verifyUnsubscribeToken(token, `${SECRET}-rotated`)).toBeNull();
  });

  it('rejects a token whose payload was edited to name someone else', () => {
    const token = createUnsubscribeToken({ userId: USER, scope: 'marketing' }, SECRET);
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'VICTIM', s: 'marketing', e: Date.now() + 1000 }))
      .toString('base64url')
      .replace(/=+$/, '');
    expect(verifyUnsubscribeToken(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = createUnsubscribeToken(
      { userId: USER, scope: 'marketing', expiresAt: Date.now() - 1 },
      SECRET,
    );
    expect(verifyUnsubscribeToken(token, SECRET)).toBeNull();
  });

  it('expires a year out by default — long enough that old mail still works', () => {
    const now = new Date('2026-08-10T00:00:00Z');
    const token = createUnsubscribeToken({ userId: USER, scope: 'marketing' }, SECRET, now);
    const claims = verifyUnsubscribeToken(token, SECRET, now);
    expect(claims?.expiresAt).toBe(now.getTime() + UNSUBSCRIBE_TTL_MS);
    // Still valid one day short of the year, gone one day after it.
    const almost = new Date(now.getTime() + UNSUBSCRIBE_TTL_MS - 86_400_000);
    expect(verifyUnsubscribeToken(token, SECRET, almost)).not.toBeNull();
    const after = new Date(now.getTime() + UNSUBSCRIBE_TTL_MS + 1);
    expect(verifyUnsubscribeToken(token, SECRET, after)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '.', 'no-dot', 'a.b.c', 'notbase64.notbase64', `${'x'.repeat(50)}.y`]) {
      expect(() => verifyUnsubscribeToken(bad, SECRET)).not.toThrow();
      expect(verifyUnsubscribeToken(bad, SECRET)).toBeNull();
    }
  });

  it('rejects a scope outside the frozen list, even correctly signed', () => {
    // Sign a payload naming a scope this token type does not grant.
    const token = createUnsubscribeToken({ userId: USER, scope: 'marketing' }, SECRET);
    const claims = verifyUnsubscribeToken(token, SECRET)!;
    expect(claims.scope).toBe('marketing');
    // Anything else must not verify, whatever the signature says.
    const payload = Buffer.from(JSON.stringify({ u: USER, s: 'all_email', e: Date.now() + 1000 }))
      .toString('base64url')
      .replace(/=+$/, '');
    const resigned = createUnsubscribeToken({ userId: USER, scope: 'marketing' }, SECRET).split('.')[1];
    expect(verifyUnsubscribeToken(`${payload}.${resigned}`, SECRET)).toBeNull();
  });

  it('is URL-safe: no base64 characters that a query string would re-encode', () => {
    for (let i = 0; i < 20; i += 1) {
      const token = createUnsubscribeToken({ userId: `${USER}${i}`, scope: 'marketing' }, SECRET);
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it('builds an absolute URL without a double slash', () => {
    expect(unsubscribeUrl('https://n409.app/', 'tok')).toBe('https://n409.app/api/v1/unsubscribe?token=tok');
    expect(unsubscribeUrl('https://n409.app', 'tok')).toBe('https://n409.app/api/v1/unsubscribe?token=tok');
  });
});
