/**
 * Response caching on the counts + dashboard-analytics endpoints
 * (routes/operations.ts). Both aggregate the whole valuations table for the
 * caller's scope on every hit, so they're wrapped in a short TtlCache — see
 * the comment above registerOperationsRoutes for the staleness trade-off.
 *
 * These tests prove the cache is actually short-circuiting the query (a
 * mutation made between two rapid requests is invisible until the next
 * distinct cache key), not just that the endpoints return correct data —
 * that correctness is already covered by operations.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('operations endpoint caching', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const createValuation = async (companyName: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation as { id: string };
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('serves a stale counts total from cache until a differently-keyed request is made', async () => {
    await createValuation('CacheCo One');
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/counts',
      headers: authHeader(client.token),
    });
    expect(first.json().counts.all).toBe(1);

    // A second valuation lands, but the same query hits the cached value.
    await createValuation('CacheCo Two');
    const second = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/counts',
      headers: authHeader(client.token),
    });
    expect(second.json().counts.all).toBe(1);

    // A distinctly-keyed request (different filter) is not served from that
    // cache entry and sees the current state.
    const distinctKey = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/counts?user_id=${client.id}`,
      headers: authHeader(client.token),
    });
    expect(distinctKey.json().counts.all).toBe(2);
  });

  it('serves a stale dashboard total from cache until a differently-keyed request is made', async () => {
    const other = await seedUser(ctx, { roles: ['valuation_user'] });
    const createFor = async (token: string, companyName: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(token),
        payload: { kind: '409a', company_name: companyName },
      });
      expect(res.statusCode).toBe(201);
    };

    await createFor(other.token, 'DashCo One');
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/stats/dashboard',
      headers: authHeader(other.token),
    });
    expect(first.json().total).toBe(1);

    await createFor(other.token, 'DashCo Two');
    const second = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/stats/dashboard',
      headers: authHeader(other.token),
    });
    expect(second.json().total).toBe(1); // still cached

    const rangedFresh = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/stats/dashboard?created_from=2000-01-01',
      headers: authHeader(other.token),
    });
    expect(rangedFresh.json().total).toBe(2); // different key, current state
  });
});
