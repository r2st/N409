/**
 * Spending a stored refresh token, written once for the three connector
 * families that hold one.
 *
 * `accounting_connections`, `hris_connections` and `cap_table_connections` are
 * the same row three times — an access token, a refresh token, an expiry — and
 * until R252 not one of the three read the second or third column. What that
 * cost is described at {@link ReconnectRequiredError}: a connection that works
 * until the provider's first access token expires and then fails identically
 * forever, with the credential that would renew it sitting unread beside the
 * one that no longer works.
 *
 * The exchange is RFC 6749 §6 and is the same at every provider these clients
 * talk to, so the differences that remain are the two this takes as arguments:
 * which token endpoint, and what to call the provider in a sentence somebody
 * reads.
 */

import {
  IntegrationError,
  OAUTH_TIMEOUT_MS,
  ReconnectRequiredError,
  providerRefused,
  readJson,
  withDeadline,
} from './deadline.js';

/**
 * How long before a stored access token expires we stop trusting it.
 *
 * A cap-table or roster pull is a 30-second call against a provider doing real
 * work, and a token that expires while it is in flight fails the whole sync.
 * Ninety seconds covers the call plus ordinary clock skew between this box and
 * the provider's auth server — which is the other half of why a token that is
 * "still valid for four seconds" is not.
 */
export const TOKEN_REFRESH_SKEW_MS = 90_000;

/** Whether a stored expiry is close enough that the token should be renewed first. */
export function tokenNeedsRefresh(expiresAt: Date | null, now = Date.now()): boolean {
  return expiresAt !== null && expiresAt.getTime() - now <= TOKEN_REFRESH_SKEW_MS;
}

export interface RefreshedTokens {
  accessToken: string;
  /**
   * The rotated refresh token, or `undefined` for the common case where the
   * provider answered with an access token alone and expects the caller to
   * keep the one it has. Not `null`: a repo told `null` writes `null`, and
   * that turns a successful refresh into the last one this connection can ever
   * perform.
   */
  refreshToken: string | undefined;
  /**
   * `null` when the provider did not say. Deliberately not defaulted to an
   * hour — a guessed expiry is a number nobody chose governing when we hand a
   * third party a credential — and the callers read `null` as "unknown", which
   * stops proactive refreshing rather than starting it early.
   */
  expiresAt: Date | null;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export async function refreshOAuthTokens(input: {
  label: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchFn?: typeof fetch;
}): Promise<RefreshedTokens> {
  const { label } = input;
  const fetchFn = input.fetchFn ?? fetch;
  const res = await withDeadline(label, OAUTH_TIMEOUT_MS, (signal) =>
    fetchFn(input.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }).toString(),
      signal,
    }),
  );
  if (!res.ok) {
    // RFC 6749 §5.2: the token endpoint answers `400 invalid_grant` for a
    // refresh token that has been revoked or has expired, and `401
    // invalid_client` for credentials this deployment can no longer use.
    // Neither improves on the next tick, and retrying either is how a dead
    // connection becomes a dead connection we call every fifteen minutes
    // forever. Everything else — a 5xx, a gateway, a rate limit — is the
    // provider being briefly unwell, and keeps the wording every other refusal
    // in these clients has.
    if (res.status === 400 || res.status === 401) {
      throw new ReconnectRequiredError(
        `${label} no longer accepts the stored authorisation — reconnect ${label} to resume syncing.`,
      );
    }
    throw providerRefused(label, 'token refresh', res);
  }
  const body = (await readJson(res, label)) as TokenResponse;
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new IntegrationError(`${label} returned no access token`);
  }
  const expiresIn =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}
