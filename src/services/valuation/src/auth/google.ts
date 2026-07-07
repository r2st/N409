import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Google OIDC SSO (issue #3). Plain OAuth2 authorization-code flow against
 * Google's published endpoints; the key resolver and fetch are injectable so
 * tests can run without Google.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  givenName?: string;
  familyName?: string;
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let defaultJwks: JWTVerifyGetKey | undefined;

export class GoogleOidc {
  constructor(
    private readonly cfg: GoogleConfig,
    private readonly deps: { fetch?: typeof fetch; getKey?: JWTVerifyGetKey } = {},
  ) {}

  authorizationUrl(state: string): string {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async exchangeCode(code: string): Promise<string> {
    const doFetch = this.deps.fetch ?? fetch;
    const res = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: this.cfg.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error('Google token response missing id_token');
    return body.id_token;
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    const getKey = this.deps.getKey ?? (defaultJwks ??= createRemoteJWKSet(new URL(JWKS_URI)));
    const { payload } = await jwtVerify(idToken, getKey, {
      issuer: ISSUERS,
      audience: this.cfg.clientId,
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new Error('Google id_token missing sub/email');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      givenName: payload.given_name as string | undefined,
      familyName: payload.family_name as string | undefined,
    };
  }
}
