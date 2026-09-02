import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findConnection } from '../../src/repos/accountingConnections.js';
import { applyEngineInputs, findParams } from '../../src/repos/params.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The accounting HTTP surface (`routes/accounting.ts`).
 *
 * `clients/accounting.ts` was well covered for parsing and `repos/
 * accountingConnections.ts` for storage; the route joining them was not. What
 * lives only here is the OAuth state round-trip, the redirect contract the
 * provider's browser hop depends on, and — the reason this file is worth
 * writing — what an import *does* to the valuation once the numbers arrive.
 *
 * The callback is the security-interesting half: it is the one unauthenticated
 * endpoint in the service, so until the state JWT verifies every field on it is
 * attacker-controlled.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const xeroRow = (label: string, value: string) => ({ Cells: [{ Value: label }, { Value: value }] });

const XERO_PL = {
  Reports: [
    {
      Fields: [
        { Id: 'Currency', Value: 'USD' },
        { Id: 'FromDate', Value: '2025-07-01' },
        { Id: 'ToDate', Value: '2026-06-30' },
      ],
      Rows: [
        {
          Rows: [
            { Cells: [{ Value: 'Total Income' }, { Value: '500000' }, { Value: '400000' }] },
            { Cells: [{ Value: 'Net Profit' }, { Value: '75000' }] },
          ],
        },
      ],
    },
  ],
};

const XERO_BALANCE_SHEET = {
  Reports: [
    {
      Fields: [
        { Id: 'ToDate', Value: '2026-06-30' },
        { Id: 'Currency', Value: 'USD' },
      ],
      Rows: [
        { Rows: [xeroRow('Total Assets', '900000.00')] },
        { Rows: [xeroRow('Total Liabilities', '250000.00')] },
      ],
    },
  ],
};

/**
 * Stands in for every Xero endpoint the flow touches, keyed by URL. `calls`
 * records what was asked for so a test can prove the exchange actually
 * happened rather than infer it from a stored row.
 */
function xeroStub(overrides: { tokenStatus?: number; plStatus?: number; refreshStatus?: number } = {}) {
  const calls: string[] = [];
  /** The `grant_type` of each token-endpoint call, in order. */
  const grants: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.includes('identity.xero.com/connect/token')) {
      const grantType = new URLSearchParams(String(init?.body ?? '')).get('grant_type') ?? '';
      grants.push(grantType);
      if (grantType === 'refresh_token') {
        if (overrides.refreshStatus && overrides.refreshStatus !== 200) {
          return new Response('nope', { status: overrides.refreshStatus });
        }
        return json({ access_token: 'xero-renewed-token', expires_in: 1800 });
      }
      if (overrides.tokenStatus && overrides.tokenStatus !== 200) {
        return new Response('nope', { status: overrides.tokenStatus });
      }
      return json({
        access_token: 'xero-access-token',
        refresh_token: 'xero-refresh-token',
        expires_in: 1800,
      });
    }
    if (url.includes('/connections')) return json([{ tenantId: 'tenant-1', tenantName: 'Acme' }]);
    if (url.includes('BalanceSheet')) return json(XERO_BALANCE_SHEET);
    if (url.includes('ProfitAndLoss')) {
      if (overrides.plStatus && overrides.plStatus !== 200) {
        return new Response('upstream is down', { status: overrides.plStatus });
      }
      return json(XERO_PL);
    }
    return json({});
  }) as unknown as typeof fetch;
  return { fetchFn, calls, grants };
}

const BASE_URL = 'https://app.test.n409.example';

describe.skipIf(!dbUp)('accounting routes', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let stub: ReturnType<typeof xeroStub>;

  const createValuation = async (company: string, token = client.token) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const connectUrl = (id: string, provider = 'xero') =>
    `/api/v1/valuations/${id}/accounting/${provider}/connect`;

  /** Drives the whole OAuth hop and returns the stored connection's id. */
  const connect = async (valuationId: string, realmId?: string) => {
    const started = await app.inject({
      method: 'POST',
      url: connectUrl(valuationId),
      headers: authHeader(client.token),
    });
    expect(started.statusCode).toBe(200);
    const state = new URL(started.json().authorize_url).searchParams.get('state')!;
    const query = new URLSearchParams({ state, code: 'auth-code' });
    if (realmId) query.set('realmId', realmId);
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/callback?${query.toString()}`,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('accounting=connected');
    return callback;
  };

  beforeAll(async () => {
    stub = xeroStub();
    ctx = await setupTestApp(
      {
        PUBLIC_BASE_URL: BASE_URL,
        XERO_CLIENT_ID: 'xero-client',
        XERO_CLIENT_SECRET: 'xero-secret',
        // quickbooks deliberately left unconfigured — the 503 path needs a
        // provider the deployment knows about but has no credentials for.
      },
      { accountingFetch: stub.fetchFn },
    );
    app = ctx.app;
    pool = ctx.pool;
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('listing providers', () => {
    it('reports which providers are configured and which can import', async () => {
      const id = await createValuation('Provider List Co');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/accounting`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      const providers: Array<Record<string, unknown>> = res.json().providers;
      expect(providers).toHaveLength(6);

      const xero = providers.find((p) => p.provider === 'xero')!;
      expect(xero.configured).toBe(true);
      expect(xero.import_supported).toBe(true);
      expect(xero.connection).toBeNull();

      // Configured and connectable, but the importer does not exist yet.
      const sage = providers.find((p) => p.provider === 'sage')!;
      expect(sage.configured).toBe(false);
      expect(sage.import_supported).toBe(false);
    });

    it('404s for a stranger rather than revealing the valuation exists', async () => {
      const id = await createValuation('Private Co');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/accounting`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s a non-ULID id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/valuations/not-a-ulid/accounting',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      const id = await createValuation('Auth Co');
      const res = await app.inject({ method: 'GET', url: `/api/v1/valuations/${id}/accounting` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('starting a connection', () => {
    it('returns an authorize URL carrying the redirect and a signed state', async () => {
      const id = await createValuation('Connect Co');
      const res = await app.inject({
        method: 'POST',
        url: connectUrl(id),
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().authorize_url);
      expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize');
      expect(url.searchParams.get('client_id')).toBe('xero-client');
      expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/v1/accounting/callback`);
      expect(url.searchParams.get('state')).toBeTruthy();
    });

    it('is 503 for a provider this deployment has no credentials for', async () => {
      const id = await createValuation('Unconfigured Co');
      const res = await app.inject({
        method: 'POST',
        url: connectUrl(id, 'quickbooks'),
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().type).toBe('urn:n409:problem:accounting-unavailable');
    });

    it('404s a provider that does not exist', async () => {
      const id = await createValuation('Bad Provider Co');
      const res = await app.inject({
        method: 'POST',
        url: connectUrl(id, 'not-a-provider'),
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('the OAuth callback', () => {
    it('rejects a call with no state at all', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/callback' });
      expect(res.statusCode).toBe(400);
    });

    // The signature is the only authentication this endpoint has.
    it('rejects a forged state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/accounting/callback?state=not-a-jwt&code=x',
      });
      expect(res.statusCode).toBe(422);
      // The wording is `integrationCallbackRefusal`'s, which R239 rewrote from
      // "Invalid or expired state" into something a stranded person can act
      // on. Matched on the sentence that carries the meaning rather than on
      // the whole paragraph.
      expect(res.json().detail).toMatch(/could not be matched to the approval/i);
    });

    it('rejects an over-long state instead of trying to verify it', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/accounting/callback?state=${'a'.repeat(5000)}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('bounces back as denied when the user refuses consent', async () => {
      const id = await createValuation('Denied Co');
      const started = await app.inject({
        method: 'POST',
        url: connectUrl(id),
        headers: authHeader(client.token),
      });
      const state = new URL(started.json().authorize_url).searchParams.get('state')!;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/accounting/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        `${BASE_URL}/valuations/${id}/documents?accounting=denied&provider=xero`,
      );
      expect(await findConnection(pool, id, 'xero')).toBeNull();
    });

    it('stores the connection and redirects to the documents tab', async () => {
      const id = await createValuation('Callback Co');
      const res = await connect(id, 'realm-42');
      expect(res.headers.location).toBe(
        `${BASE_URL}/valuations/${id}/documents?accounting=connected&provider=xero`,
      );

      const connection = await findConnection(pool, id, 'xero');
      expect(connection).not.toBeNull();
      expect(connection!.access_token).toBe('xero-access-token');
      expect(connection!.external_org_id).toBe('realm-42');
      expect(connection!.connected_by).toBe(client.id);
    });

    // A failed exchange must not 500 into a provider's browser redirect; the
    // user has to land back in the product either way.
    it('redirects as error when the token exchange fails', async () => {
      const failing = xeroStub({ tokenStatus: 401 });
      const other = await setupTestApp(
        { PUBLIC_BASE_URL: BASE_URL, XERO_CLIENT_ID: 'xero-client', XERO_CLIENT_SECRET: 'xero-secret' },
        { accountingFetch: failing.fetchFn },
      );
      try {
        const user = await seedUser(other, { roles: ['valuation_user'] });
        const created = await other.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(user.token),
          payload: { kind: '409a', company_name: 'Exchange Fails Co' },
        });
        const id = created.json().valuation.id as string;
        const started = await other.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/accounting/xero/connect`,
          headers: authHeader(user.token),
        });
        const state = new URL(started.json().authorize_url).searchParams.get('state')!;
        const res = await other.app.inject({
          method: 'GET',
          url: `/api/v1/accounting/callback?state=${encodeURIComponent(state)}&code=abc`,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('accounting=error');
        expect(await findConnection(other.pool, id, 'xero')).toBeNull();
      } finally {
        await other.teardown();
      }
    });
  });

  describe('importing', () => {
    const importUrl = (id: string, provider = 'xero') =>
      `/api/v1/valuations/${id}/accounting/${provider}/import`;

    it('refuses a provider whose importer has not shipped', async () => {
      const id = await createValuation('Sage Import Co');
      const res = await app.inject({
        method: 'POST',
        url: importUrl(id, 'sage'),
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/isn't available yet/i);
    });

    it('refuses when the provider was never connected', async () => {
      const id = await createValuation('Never Connected Co');
      const res = await app.inject({
        method: 'POST',
        url: importUrl(id),
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.detail).toMatch(/is not connected/i);
      // R350: the remedy names the panel the connect control is actually on.
      expect(body.detail).toContain('Documents → Accounting');
      expect(body.connection_status).toBe('absent');

    });

    it('pulls the P&L and writes revenue onto the valuation params', async () => {
      const id = await createValuation('Import Co');
      await connect(id);
      const res = await app.inject({
        method: 'POST',
        url: importUrl(id),
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().imported.revenue_cents).toBe(50_000_000);

      const params = await findParams(pool, id);
      expect(params!.ytd_revenue_cents).toBe('50000000');
      expect(params!.revenue_status).toBe('post_revenue');
    });

    /**
     * The asset approach refuses to run without these two, and pulling them
     * from the ledger is the point of connecting the software. Cents at the
     * boundary, currency units in the engine.
     */
    it('lands the balance sheet on the asset approach inputs', async () => {
      const id = await createValuation('Balance Sheet Co');
      await connect(id);
      await app.inject({ method: 'POST', url: importUrl(id), headers: authHeader(client.token) });

      const params = await findParams(pool, id);
      const asset = (params!.engine_inputs as Record<string, Record<string, unknown>>).asset;
      expect(asset.total_assets).toBe(900_000);
      expect(asset.total_liabilities).toBe(250_000);
    });

    /**
     * The regression the route's own comment describes: jsonb `||` replaces a
     * key wholesale, so writing `{ asset: {…} }` over an existing object would
     * silently drop whatever an analyst had already set beside these two.
     */
    it('merges into the asset object rather than replacing an analyst’s entries', async () => {
      const id = await createValuation('Asset Merge Co');
      await connect(id);
      await applyEngineInputs(
        pool,
        id,
        { asset: { intangibles: 12_345, total_assets: 1 } },
        { actorType: 'human', actorId: client.id },
      );

      await app.inject({ method: 'POST', url: importUrl(id), headers: authHeader(client.token) });

      const params = await findParams(pool, id);
      const asset = (params!.engine_inputs as Record<string, Record<string, unknown>>).asset;
      // The hand-entered key survives...
      expect(asset.intangibles).toBe(12_345);
      // ...and the imported one wins over the placeholder.
      expect(asset.total_assets).toBe(900_000);
    });

    it('renews a spent access token before importing (R252)', async () => {
      // Xero's access token lasts thirty minutes and QuickBooks' an hour, so
      // every import but the first after a connect was a 401 — with the
      // refresh token that would have fixed it stored, unread, in the next
      // column since the feature shipped.
      const id = await createValuation('Stale Token Co');
      await connect(id);
      await pool.query(
        `UPDATE accounting_connections SET token_expires_at = now() - interval '1 hour'
          WHERE valuation_id = $1`,
        [id],
      );
      const before = stub.grants.length;

      const res = await app.inject({
        method: 'POST',
        url: importUrl(id),
        headers: authHeader(client.token),
      });

      expect(res.statusCode).toBe(200);
      expect(stub.grants.slice(before)).toContain('refresh_token');
      const connection = await findConnection(pool, id, 'xero');
      expect(connection!.token_expires_at!.getTime()).toBeGreaterThan(Date.now());
      expect(connection!.access_token).toBe('xero-renewed-token');
    });

    it('asks for a reconnect when Xero refuses the refresh (R252)', async () => {
      // `invalid_grant` is not a transient fault: the authorisation is over,
      // and the only thing that clears it is a person running the OAuth hop
      // again. The message has to say that.
      const failing = xeroStub({ refreshStatus: 400 });
      const other = await setupTestApp(
        { PUBLIC_BASE_URL: BASE_URL, XERO_CLIENT_ID: 'xero-client', XERO_CLIENT_SECRET: 'xero-secret' },
        { accountingFetch: failing.fetchFn },
      );
      try {
        const user = await seedUser(other, { roles: ['valuation_user'] });
        const created = await other.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(user.token),
          payload: { kind: '409a', company_name: 'Dead Grant Co' },
        });
        const id = created.json().valuation.id as string;
        const started = await other.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/accounting/xero/connect`,
          headers: authHeader(user.token),
        });
        const state = new URL(started.json().authorize_url).searchParams.get('state')!;
        await other.app.inject({
          method: 'GET',
          url: `/api/v1/accounting/callback?state=${encodeURIComponent(state)}&code=abc`,
        });
        await other.pool.query(
          `UPDATE accounting_connections SET token_expires_at = now() - interval '1 hour'
            WHERE valuation_id = $1`,
          [id],
        );

        const res = await other.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/accounting/xero/import`,
          headers: authHeader(user.token),
        });

        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toMatch(/reconnect Xero/i);
        // The ledger was never asked for with a credential we knew was spent.
        expect(failing.calls.some((u) => u.includes('ProfitAndLoss'))).toBe(false);
        const connection = await findConnection(other.pool, id, 'xero');
        expect(connection!.last_error).toMatch(/reconnect Xero/i);
      } finally {
        await other.teardown();
      }
    });

    it('records the failure against the connection when the provider errors', async () => {
      const failing = xeroStub({ plStatus: 500 });
      const other = await setupTestApp(
        { PUBLIC_BASE_URL: BASE_URL, XERO_CLIENT_ID: 'xero-client', XERO_CLIENT_SECRET: 'xero-secret' },
        { accountingFetch: failing.fetchFn },
      );
      try {
        const user = await seedUser(other, { roles: ['valuation_user'] });
        const created = await other.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(user.token),
          payload: { kind: '409a', company_name: 'Import Fails Co' },
        });
        const id = created.json().valuation.id as string;
        const started = await other.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/accounting/xero/connect`,
          headers: authHeader(user.token),
        });
        const state = new URL(started.json().authorize_url).searchParams.get('state')!;
        await other.app.inject({
          method: 'GET',
          url: `/api/v1/accounting/callback?state=${encodeURIComponent(state)}&code=abc`,
        });

        const res = await other.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/accounting/xero/import`,
          headers: authHeader(user.token),
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toMatch(/import failed/i);

        // The error is kept on the connection so the UI can explain itself.
        const connection = await findConnection(other.pool, id, 'xero');
        expect(connection!.last_error).toBeTruthy();
      } finally {
        await other.teardown();
      }
    });
  });

  describe('disconnecting', () => {
    it('revokes a live connection and 404s a second attempt', async () => {
      const id = await createValuation('Revoke Co');
      await connect(id);

      const first = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/accounting/xero`,
        headers: authHeader(client.token),
      });
      expect(first.statusCode).toBe(204);

      const second = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/accounting/xero`,
        headers: authHeader(client.token),
      });
      expect(second.statusCode).toBe(404);
    });

    it('refuses to import through a revoked connection', async () => {
      const id = await createValuation('Revoked Import Co');
      await connect(id);
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/accounting/xero`,
        headers: authHeader(client.token),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/accounting/xero/import`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      /*
       * The other half of the same predicate (R350). `revoked` is written by
       * nothing but an explicit disconnect, so this is a lost race with a
       * colleague or with the reader's own earlier click — and "is not
       * connected" sends them looking for a connect button while describing a
       * state somebody chose. Reconnecting is a fresh authorisation, because
       * the disconnect blanked the tokens.
       */
      expect(body.detail).toMatch(/was disconnected/i);
      expect(body.detail).not.toMatch(/is not connected/i);
      expect(body.detail).toMatch(/fresh authorisation/i);
      expect(body.connection_status).toBe('revoked');
    });

    it('404s a disconnect for a valuation the caller cannot read', async () => {
      const id = await createValuation('Stranger Revoke Co');
      await connect(id);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${id}/accounting/xero`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
