import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signOidcState, signSession, verifyOidcState, verifySession } from '../../src/auth/jwt.js';

const cfg = { secret: 'test-secret-0123456789abcdef-0123456789', issuer: 'n409', ttlSeconds: 3600 };

const claims = (over: Partial<Parameters<typeof signSession>[0]> = {}) => ({
  sub: '01ABC',
  roles: [] as never[],
  partner_id: null,
  session_epoch: 0,
  ...over,
});

describe('session JWTs (issue #3)', () => {
  it('round-trips claims', async () => {
    const token = await signSession(claims({ roles: ['admin'] }), cfg);
    expect(await verifySession(token, cfg)).toEqual({
      sub: '01ABC',
      roles: ['admin'],
      partner_id: null,
      session_epoch: 0,
    });
  });

  it('preserves partner scoping claims', async () => {
    const token = await signSession(claims({ roles: ['partner'], partner_id: '01PARTNER' }), cfg);
    expect((await verifySession(token, cfg)).partner_id).toBe('01PARTNER');
  });

  it('carries the session epoch it was minted against', async () => {
    const token = await signSession(claims({ session_epoch: 7 }), cfg);
    expect((await verifySession(token, cfg)).session_epoch).toBe(7);
  });

  it('reads a token minted before the epoch claim existed as epoch 0', async () => {
    // Matches the column default, so deploying the claim doesn't sign everyone
    // out of their existing sessions.
    const legacy = await new SignJWT({ roles: ['admin'], partner_id: null })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('01ABC')
      .setIssuer(cfg.issuer)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(cfg.secret));
    expect((await verifySession(legacy, cfg)).session_epoch).toBe(0);
  });

  it('rejects a tampered token', async () => {
    const token = await signSession(claims(), cfg);
    await expect(verifySession(token + 'x', cfg)).rejects.toThrow();
  });

  it('rejects the wrong issuer', async () => {
    const token = await signSession(claims(), cfg);
    await expect(verifySession(token, { ...cfg, issuer: 'other' })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await signSession(claims(), { ...cfg, ttlSeconds: -10 });
    await expect(verifySession(token, cfg)).rejects.toThrow();
  });

  it('OIDC state round-trips and rejects session tokens as state', async () => {
    const state = await signOidcState(cfg);
    await expect(verifyOidcState(state, cfg)).resolves.toBeUndefined();
    const session = await signSession(claims(), cfg);
    await expect(verifyOidcState(session, cfg)).rejects.toThrow();
  });
});

describe('session JWT purpose claim (token confusion prevention)', () => {
  it('rejects an MFA challenge token used as a session token', async () => {
    // MFA tokens carry purpose: 'mfa-challenge' — they must not authenticate a session
    const mfaToken = await new SignJWT({ purpose: 'mfa-challenge' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('01ABC')
      .setIssuer(cfg.issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifySession(mfaToken, cfg)).rejects.toThrow('wrong token purpose');
  });

  it('rejects an OIDC state token used as a session token', async () => {
    const oidcToken = await new SignJWT({ purpose: 'oidc-state' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('01ABC')
      .setIssuer(cfg.issuer)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifySession(oidcToken, cfg)).rejects.toThrow('wrong token purpose');
  });

  it('rejects an accounting state token used as a session token', async () => {
    const acctToken = await new SignJWT({ purpose: 'accounting-state', v: '01V', p: 'qbo' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('01ABC')
      .setIssuer(cfg.issuer)
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(new TextEncoder().encode(cfg.secret));
    await expect(verifySession(acctToken, cfg)).rejects.toThrow('wrong token purpose');
  });

  it('still accepts legacy tokens without a purpose claim (backward compat)', async () => {
    const legacy = await new SignJWT({ roles: ['admin'], partner_id: null })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('01ABC')
      .setIssuer(cfg.issuer)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(cfg.secret));
    const result = await verifySession(legacy, cfg);
    expect(result.sub).toBe('01ABC');
  });
});
