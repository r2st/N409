import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { adminPatchUser, softDeleteUser } from '../../src/repos/adminUsers.js';
import { signAccountingState, signCapTableSyncState, signHrisState } from '../../src/auth/jwt.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const JWT = { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 };

/**
 * The three OAuth callbacks, against an actor whose access ended during the hop.
 *
 * R334 made the callbacks re-ask whether the engagement is still live. The other
 * half of the same token is the person, and nothing re-asked about them: a
 * callback carries no session, its whole authority is a thirty-minute JWT that
 * nothing can withdraw, and closing an account is this platform's "their access
 * ends now".
 *
 * Both halves are asserted for the same reason the retirement suite gives:
 * spending the code mints a third party's refresh token in the name of somebody
 * whose access ended, so the token endpoint must never be reached either.
 */
describe.skipIf(!dbUp)('integration OAuth callbacks — the actor’s access ended during the hop', () => {
  let ctx: TestApp;
  const fetchFn = vi.fn(async () => {
    throw new Error('the token endpoint must not be reached for an actor who cannot act');
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
  });

  afterAll(async () => ctx?.teardown());

  const engagementFor = async (userId: string, name: string) =>
    createValuation(
      ctx.pool,
      { kind: '409a', companyName: name, userId },
      { actorType: 'human', actorId: userId, source: 'test' },
    );

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
    it(`${name}: a closed account connects nothing`, async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const v = await engagementFor(user.id, `Closed ${provider} Inc`);
      const state = await sign({ valuationId: v.id, provider, userId: user.id }, JWT);
      await softDeleteUser(ctx.pool, user.id, { actorType: 'human', actorId: user.id, source: 'test' });
      fetchFn.mockClear();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `${path}?state=${encodeURIComponent(state)}&code=abc`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('=unauthorized');
      expect(fetchFn).not.toHaveBeenCalled();
      const { rows } = await ctx.pool.query(`SELECT id FROM ${table} WHERE valuation_id = $1`, [v.id]);
      expect(rows).toHaveLength(0);
    });
  }

  it('a suspension refuses it too — `ignored` subtracts every scope', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const v = await engagementFor(user.id, 'Suspended Inc');
    const state = await signCapTableSyncState({ valuationId: v.id, provider: 'carta', userId: user.id }, JWT);
    await adminPatchUser(ctx.pool, user.id, { roles: ['valuation_user', 'ignored'] });
    fetchFn.mockClear();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc`,
    });

    expect(res.headers.location).toContain('sync=unauthorized');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an engagement that left the actor’s scope refuses it', async () => {
    // The state names a valuation this user never could open: the same refusal
    // a partner-scope change during the hop produces.
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
    const v = await engagementFor(stranger.id, 'Someone Else Inc');
    const state = await signCapTableSyncState({ valuationId: v.id, provider: 'carta', userId: user.id }, JWT);
    fetchFn.mockClear();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc`,
    });

    expect(res.headers.location).toContain('sync=unauthorized');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /**
   * R340, methodology M5. The three doors are not the same door: HRIS
   * `/connect` calls `requireOps` where accounting and cap-table sync do not,
   * because what it connects pulls a client's employee roster and payroll. The
   * callback's re-check asked `canReadValuation` for all three, so of the four
   * ways this file's own note says an actor's access can end, the demotion was
   * the one it did not close — on the one door where it applies.
   */
  it('HRIS: an operator demoted out of ops mid-hop connects nothing', async () => {
    const user = await seedUser(ctx, { roles: ['admin'] });
    const v = await engagementFor(user.id, 'Demoted Payroll Inc');
    const state = await signHrisState({ valuationId: v.id, provider: 'rippling', userId: user.id }, JWT);
    // Still able to read the engagement — they own it — but no longer ops, so
    // `/connect` would refuse to start this hop now.
    await adminPatchUser(ctx.pool, user.id, { roles: ['valuation_user'] });
    fetchFn.mockClear();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc`,
    });

    expect(res.headers.location).toContain('hris=unauthorized');
    expect(fetchFn).not.toHaveBeenCalled();
    const { rows } = await ctx.pool.query('SELECT id FROM hris_connections WHERE valuation_id = $1', [v.id]);
    expect(rows).toHaveLength(0);
  });

  it('HRIS: an operator who is still ops connects', async () => {
    // The other side of the same parameter — `'ops'` must not refuse the door's
    // own legitimate caller.
    const user = await seedUser(ctx, { roles: ['admin'] });
    const v = await engagementFor(user.id, 'Still Ops Payroll Inc');
    const state = await signHrisState({ valuationId: v.id, provider: 'rippling', userId: user.id }, JWT);
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
      url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc`,
    });

    expect(res.headers.location).toContain('hris=connected');
  });

  it('a live actor still connects through the same door', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const v = await engagementFor(user.id, 'Still Here Inc');
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

    expect(res.headers.location).toContain('sync=connected');
  });
});
