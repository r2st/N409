import { describe, expect, it } from 'vitest';
import { signOidcState, signSession, verifyOidcState, verifySession } from '../../src/auth/jwt.js';

const cfg = { secret: 'test-secret-0123456789abcdef-0123456789', issuer: 'n409', ttlSeconds: 3600 };

describe('session JWTs (issue #3)', () => {
  it('round-trips claims', async () => {
    const token = await signSession({ sub: '01ABC', roles: ['admin'], partner_id: null }, cfg);
    const claims = await verifySession(token, cfg);
    expect(claims).toEqual({ sub: '01ABC', roles: ['admin'], partner_id: null });
  });

  it('preserves partner scoping claims', async () => {
    const token = await signSession({ sub: '01ABC', roles: ['partner'], partner_id: '01PARTNER' }, cfg);
    const claims = await verifySession(token, cfg);
    expect(claims.partner_id).toBe('01PARTNER');
  });

  it('rejects a tampered token', async () => {
    const token = await signSession({ sub: '01ABC', roles: [], partner_id: null }, cfg);
    await expect(verifySession(token + 'x', cfg)).rejects.toThrow();
  });

  it('rejects the wrong issuer', async () => {
    const token = await signSession({ sub: '01ABC', roles: [], partner_id: null }, cfg);
    await expect(verifySession(token, { ...cfg, issuer: 'other' })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await signSession(
      { sub: '01ABC', roles: [], partner_id: null },
      { ...cfg, ttlSeconds: -10 },
    );
    await expect(verifySession(token, cfg)).rejects.toThrow();
  });

  it('OIDC state round-trips and rejects session tokens as state', async () => {
    const state = await signOidcState(cfg);
    await expect(verifyOidcState(state, cfg)).resolves.toBeUndefined();
    const session = await signSession({ sub: '01ABC', roles: [], partner_id: null }, cfg);
    await expect(verifyOidcState(session, cfg)).rejects.toThrow();
  });
});
