/**
 * Spending a refresh token is the one step in a connector sync that cannot be
 * replayed, and R429 (methodology M5) found three ways this module quietly gave
 * one away.
 *
 * All three end in the same place — `reconnect_required = true`, a schedule
 * stopped, and a card telling the client their provider withdrew an
 * authorisation it did not withdraw — so they are pinned together:
 *
 *   * a quoted `expires_in`, which turns proactive refreshing off for the life
 *     of the connection;
 *   * a blank rotated `refresh_token`, which `COALESCE($3, refresh_token)`
 *     writes over the live credential;
 *   * a rejected `updateTokens`, which loses a rotated token the provider has
 *     already retired, with no line anywhere saying so.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TOKEN_REFRESH_SKEW_MS,
  refreshOAuthTokens,
  storeRefreshedTokens,
  tokenNeedsRefresh,
  type RefreshedTokens,
} from '../../src/clients/oauthRefresh.js';
import { IntegrationError, ReconnectRequiredError } from '../../src/clients/deadline.js';

const INPUT = {
  label: 'Xero',
  tokenUrl: 'https://identity.example/connect/token',
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'stored-refresh',
};

/** A token endpoint that answers `body` with `status`. */
function endpoint(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('refreshOAuthTokens — the expiry the provider stated', () => {
  it('reads a quoted expires_in, which is what half of them send', async () => {
    const before = Date.now();
    const tokens = await refreshOAuthTokens({
      ...INPUT,
      fetchFn: endpoint({ access_token: 'new-access', expires_in: '3600' }),
    });
    expect(tokens.expiresAt).not.toBeNull();
    const seconds = (tokens.expiresAt!.getTime() - before) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(3600);
    expect(seconds).toBeLessThan(3610);
  });

  it('still reads a numeric expires_in', async () => {
    const tokens = await refreshOAuthTokens({
      ...INPUT,
      fetchFn: endpoint({ access_token: 'new-access', expires_in: 1800 }),
    });
    expect(tokens.expiresAt).not.toBeNull();
  });

  it.each([
    ['absent', {}],
    ['not a number at all', { expires_in: 'an hour' }],
    ['a number with a tail', { expires_in: '3600abc' }],
    ['blank', { expires_in: '  ' }],
    ['already spent', { expires_in: -1 }],
  ])('answers null for an expiry that is %s', async (_name, extra) => {
    const tokens = await refreshOAuthTokens({
      ...INPUT,
      fetchFn: endpoint({ access_token: 'new-access', ...extra }),
    });
    expect(tokens.expiresAt).toBeNull();
  });

  it('null means the connection stops refreshing proactively — which is the stake', () => {
    expect(tokenNeedsRefresh(null)).toBe(false);
    expect(tokenNeedsRefresh(new Date(Date.now() + TOKEN_REFRESH_SKEW_MS / 2))).toBe(true);
    expect(tokenNeedsRefresh(new Date(Date.now() + TOKEN_REFRESH_SKEW_MS * 10))).toBe(false);
  });
});

describe('refreshOAuthTokens — the rotated token', () => {
  it('reports a real rotation', async () => {
    const tokens = await refreshOAuthTokens({
      ...INPUT,
      fetchFn: endpoint({ access_token: 'new-access', refresh_token: 'rotated' }),
    });
    expect(tokens.refreshToken).toBe('rotated');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('treats %s as "not rotated" rather than writing it over the credential', async (_name, value) => {
    const tokens = await refreshOAuthTokens({
      ...INPUT,
      fetchFn: endpoint({ access_token: 'new-access', refresh_token: value }),
    });
    // `undefined`, not `''`: the three updateTokens statements are
    // COALESCE($3, refresh_token), so only undefined/null leaves the column be.
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('refuses a response with no access token', async () => {
    await expect(
      refreshOAuthTokens({ ...INPUT, fetchFn: endpoint({ refresh_token: 'rotated' }) }),
    ).rejects.toBeInstanceOf(IntegrationError);
  });

  it.each([400, 401])('reads %i as needing a reconnect rather than a retry', async (status) => {
    await expect(
      refreshOAuthTokens({ ...INPUT, fetchFn: endpoint({ error: 'invalid_grant' }, status) }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('reads a 503 as the provider being briefly unwell', async () => {
    const err = await refreshOAuthTokens({ ...INPUT, fetchFn: endpoint('busy', 503) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).not.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe('storeRefreshedTokens — a credential that could not be written down', () => {
  const rotated: RefreshedTokens = {
    accessToken: 'new-access',
    refreshToken: 'rotated',
    expiresAt: new Date(Date.now() + 3600_000),
  };
  const kept: RefreshedTokens = { accessToken: 'new-access', refreshToken: undefined, expiresAt: null };
  const context = { connectionId: 'conn-1', provider: 'xero', family: 'accounting' } as const;

  it('writes the tokens through and says nothing when it lands', async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const store = vi.fn(async () => undefined);
    await storeRefreshedTokens(rotated, store, { ...context, log });
    expect(store).toHaveBeenCalledWith(rotated);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not fail the sync when the write is refused — the access token is good', async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    await expect(
      storeRefreshedTokens(rotated, () => Promise.reject(new Error('pool timeout')), {
        ...context,
        log,
      }),
    ).resolves.toBeUndefined();
  });

  it('reports a lost rotated credential under the alerting contract', async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    await storeRefreshedTokens(rotated, () => Promise.reject(new Error('pool timeout')), {
      ...context,
      log,
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0]!;
    // `alert: true` is the estate's one alerting contract; `retried: false`
    // says nothing is coming back for this token. Both come from logUnretried.
    expect(fields).toMatchObject({
      alert: true,
      retried: false,
      rotated: true,
      connectionId: 'conn-1',
      provider: 'xero',
      family: 'accounting',
    });
    expect(fields.failure_reason).toBeTruthy();
    expect(message).toMatch(/reconnect/i);
  });

  it('distinguishes the harmless case, where the provider kept our refresh token', async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    await storeRefreshedTokens(kept, () => Promise.reject(new Error('pool timeout')), {
      ...context,
      log,
    });
    const [fields, message] = log.error.mock.calls[0]!;
    expect(fields).toMatchObject({ rotated: false });
    expect(message).toMatch(/renew it again/);
  });

  it('never lets a write failure escape, even with nowhere to report it', async () => {
    await expect(
      storeRefreshedTokens(rotated, () => Promise.reject(new Error('pool timeout')), context),
    ).resolves.toBeUndefined();
  });
});
