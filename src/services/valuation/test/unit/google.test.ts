import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { GoogleOidc } from '../../src/auth/google.js';

const cfg = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'shhh',
  redirectUri: 'http://localhost:3001/api/v1/auth/google/callback',
};

async function makeSigner() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? 'https://accounts.google.com')
      .setAudience(opts.aud ?? cfg.clientId)
      .setSubject('google-sub-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return { getKey, sign };
}

describe('Google OIDC (issue #3)', () => {
  it('builds a correct authorization URL', () => {
    const oidc = new GoogleOidc(cfg);
    const url = new URL(oidc.authorizationUrl('the-state'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(cfg.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('the-state');
  });

  it('exchanges a code for an id_token', async () => {
    const oidc = new GoogleOidc(cfg, {
      fetch: (async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/token');
        const params = new URLSearchParams(String(init?.body));
        expect(params.get('code')).toBe('auth-code');
        expect(params.get('grant_type')).toBe('authorization_code');
        return new Response(JSON.stringify({ id_token: 'the-id-token' }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await oidc.exchangeCode('auth-code')).toBe('the-id-token');
  });

  it('throws on a failed exchange', async () => {
    const oidc = new GoogleOidc(cfg, {
      fetch: (async () => new Response('nope', { status: 400 })) as typeof fetch,
    });
    await expect(oidc.exchangeCode('bad')).rejects.toThrow('token exchange failed');
  });

  it('verifies a valid id_token and extracts identity', async () => {
    const { getKey, sign } = await makeSigner();
    const oidc = new GoogleOidc(cfg, { getKey });
    const token = await sign({
      email: 'founder@acme.com',
      email_verified: true,
      given_name: 'Ada',
      family_name: 'Lovelace',
    });
    const identity = await oidc.verifyIdToken(token);
    expect(identity).toEqual({
      sub: 'google-sub-1',
      email: 'founder@acme.com',
      emailVerified: true,
      givenName: 'Ada',
      familyName: 'Lovelace',
    });
  });

  it('rejects an id_token for a different audience', async () => {
    const { getKey, sign } = await makeSigner();
    const oidc = new GoogleOidc(cfg, { getKey });
    const token = await sign({ email: 'x@y.z', email_verified: true }, { aud: 'someone-else' });
    await expect(oidc.verifyIdToken(token)).rejects.toThrow();
  });

  it('rejects an id_token from a different issuer', async () => {
    const { getKey, sign } = await makeSigner();
    const oidc = new GoogleOidc(cfg, { getKey });
    const token = await sign({ email: 'x@y.z', email_verified: true }, { iss: 'https://evil.example' });
    await expect(oidc.verifyIdToken(token)).rejects.toThrow();
  });
});
