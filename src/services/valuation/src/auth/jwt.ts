import { SignJWT, jwtVerify } from 'jose';
import type { RoleKey } from '../domain/roles.js';

export interface SessionClaims {
  sub: string; // user id (ulid)
  roles: RoleKey[];
  partner_id: string | null;
  /**
   * The value of `users.session_epoch` when this token was minted. A token
   * whose epoch trails the user's row has been revoked — see plugins/auth.ts.
   * Tokens minted before this claim existed report 0, which matches the
   * column default, so deploying this does not sign everyone out.
   */
  session_epoch: number;
}

export interface JwtConfig {
  secret: string;
  issuer: string;
  ttlSeconds: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(claims: SessionClaims, cfg: JwtConfig): Promise<string> {
  return new SignJWT({
    purpose: 'session',
    roles: claims.roles,
    partner_id: claims.partner_id,
    session_epoch: claims.session_epoch,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(cfg.issuer)
    .setAudience('n409-valuation')
    .setIssuedAt()
    .setExpirationTime(`${cfg.ttlSeconds}s`)
    .sign(key(cfg.secret));
}

export async function verifySession(token: string, cfg: JwtConfig): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, key(cfg.secret), { issuer: cfg.issuer });
  if (typeof payload.sub !== 'string') throw new Error('missing sub');
  if (payload.purpose !== 'session' && payload.purpose !== undefined) throw new Error('wrong token purpose');
  // Reject tokens minted for a different audience; accept legacy tokens
  // (aud === undefined) so the deploy doesn't sign everyone out.
  if (payload.aud !== undefined && payload.aud !== 'n409-valuation') {
    throw new Error('wrong audience');
  }
  return {
    sub: payload.sub,
    roles: (payload.roles as RoleKey[]) ?? [],
    partner_id: (payload.partner_id as string | null) ?? null,
    session_epoch: typeof payload.session_epoch === 'number' ? payload.session_epoch : 0,
  };
}

// ── MFA challenge (feature: 2FA) ─────────────────────────────────────────────
// After the password step of a login for a 2FA-enabled account, the server
// issues a short-lived challenge token instead of a session. It proves the
// first factor passed and names the user the second factor must be verified
// for — nothing else authenticates the /auth/mfa/verify call.

/** Mint a 5-minute challenge token for `userId`. */
export async function signMfaChallenge(userId: string, cfg: JwtConfig): Promise<string> {
  return new SignJWT({ purpose: 'mfa-challenge' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(cfg.issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key(cfg.secret));
}

export async function verifyMfaChallenge(token: string, cfg: JwtConfig): Promise<string> {
  const { payload } = await jwtVerify(token, key(cfg.secret), { issuer: cfg.issuer });
  if (payload.purpose !== 'mfa-challenge' || typeof payload.sub !== 'string') {
    throw new Error('invalid mfa challenge');
  }
  return payload.sub;
}

/** Short-lived signed state for the OIDC redirect round-trip (CSRF protection). */
export async function signOidcState(cfg: JwtConfig): Promise<string> {
  return new SignJWT({
    purpose: 'oidc-state',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(cfg.issuer)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key(cfg.secret));
}

export async function verifyOidcState(state: string, cfg: JwtConfig): Promise<void> {
  const { payload } = await jwtVerify(state, key(cfg.secret), { issuer: cfg.issuer });
  if (payload.purpose !== 'oidc-state') throw new Error('invalid state');
}

// ── Third-party OAuth state (accounting §23, cap-table sync, HRIS) ───────────
// Each redirect round-trip carries which valuation/provider is being connected
// and who initiated it; the signature is the callback's only authentication.
//
// The three integrations share this shape but NOT their purpose claim. A state
// minted to connect a payroll provider must not be redeemable at the accounting
// or cap-table callback: those callbacks write a provider connection against
// `valuationId`, and cross-flow replay would let a caller aim one flow's
// authorization at another flow's table. `purpose` is checked on the way out,
// so the integrations cannot be confused for one another.

export interface IntegrationState {
  valuationId: string;
  provider: string;
  userId: string;
}

/** @deprecated Historical name — `IntegrationState` covers all three flows. */
export type AccountingState = IntegrationState;

const INTEGRATION_PURPOSES = {
  accounting: 'accounting-state',
  capTable: 'captable-state',
  hris: 'hris-state',
} as const;

type IntegrationKind = keyof typeof INTEGRATION_PURPOSES;

async function signIntegrationState(
  kind: IntegrationKind,
  s: IntegrationState,
  cfg: JwtConfig,
): Promise<string> {
  return new SignJWT({ purpose: INTEGRATION_PURPOSES[kind], v: s.valuationId, p: s.provider })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.userId)
    .setIssuer(cfg.issuer)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(key(cfg.secret));
}

async function verifyIntegrationState(
  kind: IntegrationKind,
  state: string,
  cfg: JwtConfig,
): Promise<IntegrationState> {
  const { payload } = await jwtVerify(state, key(cfg.secret), { issuer: cfg.issuer });
  if (
    payload.purpose !== INTEGRATION_PURPOSES[kind] ||
    typeof payload.v !== 'string' ||
    typeof payload.p !== 'string' ||
    typeof payload.sub !== 'string'
  ) {
    throw new Error('invalid state');
  }
  return { valuationId: payload.v, provider: payload.p, userId: payload.sub };
}

export const signAccountingState = (s: IntegrationState, cfg: JwtConfig): Promise<string> =>
  signIntegrationState('accounting', s, cfg);
export const verifyAccountingState = (state: string, cfg: JwtConfig): Promise<IntegrationState> =>
  verifyIntegrationState('accounting', state, cfg);

export const signCapTableSyncState = (s: IntegrationState, cfg: JwtConfig): Promise<string> =>
  signIntegrationState('capTable', s, cfg);
export const verifyCapTableSyncState = (state: string, cfg: JwtConfig): Promise<IntegrationState> =>
  verifyIntegrationState('capTable', state, cfg);

export const signHrisState = (s: IntegrationState, cfg: JwtConfig): Promise<string> =>
  signIntegrationState('hris', s, cfg);
export const verifyHrisState = (state: string, cfg: JwtConfig): Promise<IntegrationState> =>
  verifyIntegrationState('hris', state, cfg);
