import type { FastifyReply } from 'fastify';

/**
 * httpOnly session cookie (audit F-2 / B-1 P1). The SPA no longer keeps the JWT
 * in localStorage where injected script can read it; the browser holds it in a
 * cookie that JavaScript cannot touch. `SameSite=Strict` blocks cross-site
 * sends (CSRF), and `Secure` is on in production. The token is still returned in
 * the JSON body so API clients and the SSE/download flows keep working.
 */
export const SESSION_COOKIE = 'n409_session';

export interface SessionCookieConfig {
  /** Set the Secure flag — true in production (HTTPS only). */
  secure: boolean;
  /** Cookie lifetime, mirrors the JWT TTL. */
  ttlSeconds: number;
}

export function setSessionCookie(reply: FastifyReply, token: string, config: SessionCookieConfig): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secure,
    path: '/',
    maxAge: config.ttlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: SessionCookieConfig): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secure,
    path: '/',
  });
}

/**
 * "Remember this device for 30 days" cookie (feature: 2FA). Holds an opaque
 * random token whose SHA-256 hash is stored server-side (mfa_trusted_devices);
 * presence of a live trust lets login skip the second-factor challenge.
 */
export const DEVICE_COOKIE = 'n409_device';
export const DEVICE_TRUST_DAYS = 30;
const DEVICE_TTL_SECONDS = DEVICE_TRUST_DAYS * 24 * 60 * 60;

export function setDeviceCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: DEVICE_TTL_SECONDS,
  });
}
