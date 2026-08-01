import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { listGrants } from '../../src/repos/grants.js';
import { signCapTableSyncState, signHrisState } from '../../src/auth/jwt.js';
import { runDueHrisSyncs } from '../../src/routes/hris.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ROSTER = {
  companyName: 'Acme',
  employees: [
    {
      id: 'e1',
      fullName: 'Ada Lovelace',
      workEmail: 'ada@acme.com',
      equityGrants: [
        {
          id: 'g1',
          optionsGranted: 10000,
          strikePrice: 1.25,
          grantDate: '2025-03-01',
          vesting: { months: 48, cliffMonths: 12 },
        },
      ],
    },
    {
      id: 'e2',
      fullName: 'Alan Turing',
      workEmail: 'alan@acme.com',
      equityGrants: [{ id: 'g2', optionsGranted: 5000, strikePrice: 1.25, grantDate: '2025-06-01' }],
    },
  ],
};

function mockFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/token'))
      return jsonResponse({ access_token: 'tok', expires_in: 3600, company_id: 'co1' });
    if (u.includes('/employees')) return jsonResponse(ROSTER);
    throw new Error(`unexpected fetch ${u}`);
  });
}

describe.skipIf(!dbUp)('HRIS sync for ASC 718 (feature 11)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp(
      { RIPPLING_CLIENT_ID: 'cid', RIPPLING_CLIENT_SECRET: 'sec' },
      { hrisFetch: mockFetch() as unknown as typeof fetch },
    );
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  async function connectedValuation() {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    const state = await signHrisState(
      { valuationId: v.id, provider: 'rippling', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co1`,
    });
    expect(cb.statusCode).toBe(302);
    return v;
  }

  it('refuses a cap-table-sync state at the HRIS callback', async () => {
    // The callback is unauthenticated by design — the signed state is its only
    // credential — so a state minted for a different integration must not be
    // redeemable here, however identical its payload looks.
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Confusable', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    const foreignState = await signCapTableSyncState(
      { valuationId: v.id, provider: 'rippling', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/hris/callback?state=${encodeURIComponent(foreignState)}&code=abc&company_id=co1`,
    });
    expect(cb.statusCode).toBe(422);
  });

  it('lists providers with Rippling configured', async () => {
    const v = await connectedValuation();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/hris`,
      headers: authHeader(ops.token),
    });
    const rippling = res.json().providers.find((p: { provider: string }) => p.provider === 'rippling');
    expect(rippling.configured).toBe(true);
    expect(rippling.connection.status).toBe('connected');
  });

  it('pulls the roster + grants into ASC 718 and re-syncs idempotently', async () => {
    const v = await connectedValuation();

    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({
      roster_count: 2,
      grants_found: 2,
      grants_created: 2,
      grants_skipped: 0,
    });

    const grants = await listGrants(ctx.pool, v.id);
    expect(grants).toHaveLength(2);
    const ada = grants.find((g) => g.grantee_email === 'ada@acme.com')!;
    expect(ada.options_count).toBe(10000);
    expect(ada.vesting_template).toBe('imported');

    // Re-sync: nothing new, all skipped (idempotent on external_id).
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(again.json()).toMatchObject({ grants_created: 0, grants_skipped: 2 });
    expect(await listGrants(ctx.pool, v.id)).toHaveLength(2);
  });

  it('forbids HRIS import for non-ops users', async () => {
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme', userId: client.id },
      { actorType: 'human', actorId: client.id, source: 'test' },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/connect`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('runs due HRIS syncs with bounded concurrency and isolates a failing one (P2-7)', async () => {
    const N = 6;
    const vals = [];
    for (let i = 0; i < N; i++) {
      vals.push(await connectedValuation());
    }
    await ctx.pool.query(`UPDATE hris_connections SET next_sync_at = now() + interval '30 days'`);
    await ctx.pool.query(
      `UPDATE hris_connections
         SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
       WHERE valuation_id = ANY($1)`,
      [vals.map((v) => v.id)],
    );

    let inFlight = 0;
    let peak = 0;
    let rosterCalls = 0;
    const trackingFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/token'))
        return jsonResponse({ access_token: 'tok', expires_in: 3600, company_id: 'co1' });
      if (u.includes('/employees')) {
        rosterCalls += 1;
        const myCall = rosterCalls;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        if (myCall === 2) return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse(ROSTER);
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const warnings: unknown[] = [];
    const processed = await runDueHrisSyncs({
      pool: ctx.pool,
      fetchFn: trackingFetch as unknown as typeof fetch,
      log: { warn: (o) => warnings.push(o) },
    });

    expect(rosterCalls).toBe(N);
    expect(processed).toBe(N - 1);
    expect(warnings).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
