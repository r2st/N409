import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed one-click unsubscribe tokens (RFC 8058).
 *
 * The `List-Unsubscribe-Post` contract is that the mailbox provider POSTs the
 * URL *itself*, from its own infrastructure, with no session and no user
 * interaction. So the link has to carry its own authority — which means a
 * bearer credential in a URL, and every property of one has to be deliberate:
 *
 *   * **Scoped.** The token says "turn off marketing email for this user" and
 *     nothing else. Leaked, it cannot read an engagement, change an address, or
 *     silence a notification about the client's own valuation.
 *   * **Signed, not encrypted.** The user id is not a secret — it is in every
 *     URL the app already serves — and a MAC is what stops a caller from
 *     unsubscribing somebody else by editing the id.
 *   * **Expiring.** Mail is archived forever; a token that never expires is a
 *     credential sitting in a mailbox for years. A year is long enough that a
 *     genuine click on old mail still works, which matters because a link that
 *     silently fails is exactly what makes a recipient press "report spam"
 *     instead.
 *   * **Constant-time compared.** The signature check is a secret comparison.
 *
 * Deliberately not JWT: this needs no algorithm negotiation, and the whole
 * class of `alg: none` confusion comes free with not having a header.
 */

/** What a token authorises. One value today; named so adding a second is safe. */
export const UNSUBSCRIBE_SCOPES = ['marketing'] as const;
export type UnsubscribeScope = (typeof UNSUBSCRIBE_SCOPES)[number];

export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export interface UnsubscribeClaims {
  userId: string;
  scope: UnsubscribeScope;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * `<payload>.<signature>`, both base64url so the whole thing survives a URL
 * query string, an HTML attribute and a `List-Unsubscribe` header unescaped.
 */
export function createUnsubscribeToken(
  claims: { userId: string; scope: UnsubscribeScope; expiresAt?: number },
  secret: string,
  now: Date = new Date(),
): string {
  const payload = base64url(
    JSON.stringify({
      u: claims.userId,
      s: claims.scope,
      e: claims.expiresAt ?? now.getTime() + UNSUBSCRIBE_TTL_MS,
    }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The claims a token carries, or null.
 *
 * Null for every failure — bad shape, bad signature, expired, unknown scope —
 * because the caller is an unauthenticated endpoint and distinguishing "this
 * token was forged" from "this token has expired" tells a prober which of the
 * two they achieved.
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): UnsubscribeClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];

  const expected = sign(payload, secret);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself an oracle for
  // the length — but the length of a SHA-256 MAC is a constant, so a mismatch
  // means the token is malformed rather than merely wrong.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const { u, s, e } = decoded as { u?: unknown; s?: unknown; e?: unknown };
  if (typeof u !== 'string' || u === '') return null;
  if (typeof s !== 'string' || !UNSUBSCRIBE_SCOPES.includes(s as UnsubscribeScope)) return null;
  if (typeof e !== 'number' || !Number.isFinite(e) || e <= now.getTime()) return null;

  return { userId: u, scope: s as UnsubscribeScope, expiresAt: e };
}

/** The absolute URL a `List-Unsubscribe` header and footer link point at. */
export function unsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/unsubscribe?token=${encodeURIComponent(token)}`;
}
