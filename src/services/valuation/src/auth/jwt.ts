import { SignJWT, jwtVerify } from 'jose';
import type { RoleKey } from '../domain/roles.js';

export interface SessionClaims {
  sub: string; // user id (ulid)
  roles: RoleKey[];
  partner_id: string | null;
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
  return new SignJWT({ roles: claims.roles, partner_id: claims.partner_id })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(cfg.issuer)
    .setIssuedAt()
    .setExpirationTime(`${cfg.ttlSeconds}s`)
    .sign(key(cfg.secret));
}

export async function verifySession(token: string, cfg: JwtConfig): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, key(cfg.secret), { issuer: cfg.issuer });
  if (typeof payload.sub !== 'string') throw new Error('missing sub');
  return {
    sub: payload.sub,
    roles: (payload.roles as RoleKey[]) ?? [],
    partner_id: (payload.partner_id as string | null) ?? null,
  };
}

/** Short-lived signed state for the OIDC redirect round-trip (CSRF protection). */
export async function signOidcState(cfg: JwtConfig): Promise<string> {
  return new SignJWT({ purpose: 'oidc-state' })
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
