import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { signAccountingState, signCapTableSyncState, signHrisState } from '../../src/auth/jwt.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const JWT = { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 };

/**
 * The three OAuth callbacks, against an engagement retired during the hop.
 *
 * `/connect` refuses to start on a withdrawn engagement and the pulls re-ask
 * before they write, but the callback in between asked nobody — and it is the
 * step with the longest window by a wide margin: the signed state lives thirty
 * minutes, and what it has to survive is a person reading a provider's consent
 * screen.
 *
 * `retiredEngagementWrites.test.ts` cannot reach these. It drives the routes
 * registered under `/api/v1/valuations/:id/…`, and a callback names its
 * engagement in a signed token rather than in the path — the same blind spot
 * the subject-id writes of R279/R282 fell into. So the guard is pinned here,
 * by the door rather than by the census.
 *
 * Both halves are asserted, because either alone would pass with the bug still
 * present: the redirect says `retired` *and* the token endpoint is never
 * reached, since spending the code is itself telling a third party the firm is
 * working a file it has withdrawn.
 */
describe.skipIf(!dbUp)('integration OAuth callbacks — engagement retired during the hop', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;
  const fetchFn = vi.fn(async () => {
    throw new Error('the token endpoint must not be reached for a withdrawn engagement');
  });

  beforeAll(async () => {
    ctx = await setupTestApp(
      {
        AUTO_PIPELINE: 'off',
        EMAIL_MODE: 'off',
        CARTA_CLIENT_ID: 'cid',
        CARTA_CLIENT_SECRET: 'csecret',
        QUICKBOOKS_CLIENT_ID: 'cid',
        QUICKBOOKS_CLIENT_SECRET: 'csecret',
        RIPPLING_CLIENT_ID: 'cid',
        RIPPLING_CLIENT_SECRET: 'csecret',
      },
      {
        capTableSyncFetch: fetchFn as unknown as typeof fetch,
        accountingFetch: fetchFn as unknown as typeof fetch,
        hrisFetch: fetchFn as unknown as typeof fetch,
      },
    );
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => ctx?.teardown());

  async function retiredValuation() {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme Inc', userId: user.id },
      { actorType: 'human', actorId: user.id, source: 'test' },
    );
    await retireValuations(ctx.pool, [v.id]);
    return v;
  }

  const CASES = [
    {
      name: 'cap-table sync',
      path: '/api/v1/cap-table-sync/callback',
      provider: 'carta',
      table: 'cap_table_connections',
      sign: signCapTableSyncState,
    },
    {
      name: 'accounting',
      path: '/api/v1/accounting/callback',
      provider: 'quickbooks',
      table: 'accounting_connections',
      sign: signAccountingState,
    },
    {
      name: 'HRIS',
      path: '/api/v1/hris/callback',
      provider: 'rippling',
      table: 'hris_connections',
      sign: signHrisState,
    },
  ] as const;

  for (const { name, path, provider, table, sign } of CASES) {
    it(`${name}: redirects with retired and connects nothing`, async () => {
      const v = await retiredValuation();
      const state = await sign({ valuationId: v.id, provider, userId: user.id }, JWT);
      fetchFn.mockClear();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `${path}?state=${encodeURIComponent(state)}&code=abc`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('=retired');
      // The authorization code is never spent: no refresh token is minted for
      // work the firm has closed, and the provider is never told we are on it.
      expect(fetchFn).not.toHaveBeenCalled();
      const { rows } = await ctx.pool.query(`SELECT id FROM ${table} WHERE valuation_id = $1`, [v.id]);
      expect(rows).toHaveLength(0);
    });
  }

  it('a live engagement still connects through the same door', async () => {
    // The guard must refuse the withdrawn case only; without this the test
    // above passes just as well against a callback that refuses everything.
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Live Inc', userId: user.id },
      { actorType: 'human', actorId: user.id, source: 'test' },
    );
    const state = await signCapTableSyncState({ valuationId: v.id, provider: 'carta', userId: user.id }, JWT);
    fetchFn.mockClear();
    fetchFn.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as never,
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('sync=connected');
  });
});
