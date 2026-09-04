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

import { logUnretried, type FailureLogger } from '@n409/shared';
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
   *
   * A *blank* one is the same hazard by the other door (R429, methodology M5).
   * `access_token` is checked for emptiness here and `refresh_token` was not,
   * so `"refresh_token": ""` — which a provider emits by rendering an absent
   * field rather than omitting it — arrived as a string, and the three
   * `updateTokens` statements are `COALESCE($3, refresh_token)`: only `null`
   * leaves the column alone, so an empty string is written over the live
   * credential. The next tick reads `!connection.refresh_token`, declines to
   * refresh, presents an access token that expires within the hour, and the
   * connection is dead with no way back but a reconnect. Blank is treated as
   * "the provider did not rotate it", which is the reading that keeps the
   * credential we already have.
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
  const expiresIn = parseExpiresIn(body.expires_in);
  const rotated = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
  return {
    accessToken: body.access_token,
    refreshToken: rotated === '' ? undefined : rotated,
    expiresAt: expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

/**
 * `expires_in` as seconds, or null when the provider did not usefully say.
 *
 * RFC 6749 §5.1 types it as a JSON number and a good many token endpoints send
 * `"3600"` anyway — which is the deviation that costs the most here, because
 * of what null means downstream (R429, methodology M5). A null expiry is read
 * by all three `accessTokenFor`s as "unknown", and `tokenNeedsRefresh(null)`
 * is `false`: the connection stops refreshing proactively, works until the
 * access token lapses an hour later, and then answers 401 on every tick until
 * somebody reconnects — which is precisely the failure R252 introduced this
 * whole module to prevent, reached through a quoted number.
 *
 * `Number` rather than `parseInt`: `parseInt('3600abc')` is 3600, and a body
 * that says `3600abc` is not one to take a credential lifetime from. An empty
 * string is `Number('') === 0`, which the `> 0` test at the call site rejects
 * along with a negative one.
 */
function parseExpiresIn(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw.trim() === '' ? NaN : raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Write tokens the provider has already handed over, and never lose them quietly.
 *
 * THE STEP THAT CANNOT BE REPLAYED (R429, methodology M5). All three connector
 * families spelled this `await updateTokens(...)` and let the rejection out, on
 * the reading that a failed write fails the sync and the next tick will try
 * again. That reading holds for every other write in a sync and not for this
 * one, because the exchange above is *not idempotent at the provider*: Xero
 * rotates the refresh token on every use and invalidates the old one, and
 * QuickBooks and the cap-table providers rotate on a shorter clock than the
 * connection's life. So the token in `refreshed` is, at that moment, the only
 * live credential for the connection — and it exists solely in this process's
 * heap. A statement timeout, a pool with no connections, a failover: the
 * rejection propagates, the heap goes, and the row keeps a refresh token the
 * provider has already retired.
 *
 * What happens next is the part that makes it worth a line. The next tick
 * spends the dead token, the endpoint answers `400 invalid_grant`, and the
 * refusal above turns that into a `ReconnectRequiredError` — so the connection
 * lands on `reconnect_required = true` with `next_sync_at = NULL` and tells the
 * client their provider withdrew the authorisation. It did not. One database
 * blip on this side severed the connection, and the only trace was an ordinary
 * sync failure logged in passing tens of minutes earlier.
 *
 * So the failure is reported through `logUnretried` — nothing comes back for a
 * spent refresh token, which is the exact condition that helper exists for, and
 * it carries the `alert: true` that makes the difference between a rule firing
 * and a line nobody reads. `rotated` is the field to read first: `false` means
 * the provider kept our refresh token and the only casualty is one access
 * token the next tick will renew, while `true` means the credential is gone and
 * the connection needs a person.
 *
 * And the pull carries on with the access token that was just obtained rather
 * than failing. That is the choice `updateTokens` already documents for the
 * other way this write can decline to land — a refresh that no longer owns the
 * row "still returns its access token to the caller, and the pull carries on
 * with it". Failing here would lose the credential *and* the sync.
 */
export async function storeRefreshedTokens(
  refreshed: RefreshedTokens,
  store: (tokens: RefreshedTokens) => Promise<void>,
  context: {
    log?: FailureLogger;
    connectionId: string;
    provider: string;
    family: 'accounting' | 'hris' | 'cap_table';
  },
): Promise<void> {
  try {
    await store(refreshed);
  } catch (err) {
    const rotated = refreshed.refreshToken !== undefined;
    if (context.log) {
      logUnretried(
        context.log,
        err,
        {
          connectionId: context.connectionId,
          provider: context.provider,
          family: context.family,
          rotated,
        },
        rotated
          ? 'refreshed OAuth credentials could not be stored and the provider rotated the refresh token — ' +
              'this connection now holds a retired credential and will need reconnecting'
          : 'refreshed OAuth access token could not be stored; the next sync will renew it again',
      );
    }
  }
}
