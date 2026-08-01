/**
 * The read-through cache in front of `findValuationById` (repos/valuations.ts).
 *
 * The point of these tests is not that the endpoints return correct data —
 * that is covered everywhere else — but that the cache's two obligations hold:
 * it must actually save the query, and it must never outlive a write. The
 * second is the one that would hurt: a client PATCHes a valuation, the page
 * reloads, and the old value comes back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearValuationCache, findValuationById, invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('valuation read cache', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  /** Counts the point lookups the cache is meant to absorb. */
  function countPointLookups(): { calls: () => number; restore: () => void } {
    const original = ctx.pool.query.bind(ctx.pool);
    let calls = 0;
     
    (ctx.pool as any).query = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (sql.includes('FROM valuations WHERE id = $1')) calls += 1;
       
      return (original as any)(...args);
    };
    return {
      calls: () => calls,
       
      restore: () => void ((ctx.pool as any).query = original),
    };
  }

  const create = async (companyName: string) => {
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
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('serves a repeated lookup without going back to the database', async () => {
    const v = await create('Cached Holdings');
    clearValuationCache();

    const spy = countPointLookups();
    try {
      await findValuationById(ctx.pool, v.id);
      await findValuationById(ctx.pool, v.id);
      await findValuationById(ctx.pool, v.id);
      expect(spy.calls()).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it('collapses concurrent lookups of the same id into one query', async () => {
    // This is the case that actually matters: opening a valuation fans out to
    // several routes at once, each authorizing against the same row.
    const v = await create('Stampede Inc');
    clearValuationCache();

    const spy = countPointLookups();
    try {
      await Promise.all(Array.from({ length: 8 }, () => findValuationById(ctx.pool, v.id)));
      expect(spy.calls()).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it('does not confuse one valuation for another', async () => {
    const a = await create('Distinct A');
    const b = await create('Distinct B');
    clearValuationCache();

    expect((await findValuationById(ctx.pool, a.id))?.company_name).toBe('Distinct A');
    expect((await findValuationById(ctx.pool, b.id))?.company_name).toBe('Distinct B');
  });

  it('shows a PATCH immediately on the next read', async () => {
    const v = await create('Renamed Co');
    // Warm the cache the way a real page load would.
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });
    expect(before.json().valuation.company_name).toBe('Renamed Co');

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
      payload: { company_name: 'Renamed Later Co' },
    });
    expect(patched.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });
    expect(after.json().valuation.company_name).toBe('Renamed Later Co');
  });

  it('shows a state change immediately, including to a different reader', async () => {
    // Ops publishes; the owner must not keep seeing the previous state.
    const v = await create('Transitioning Co');
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });

    const moved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(ops.token),
      payload: { state: 'started' },
    });
    expect(moved.statusCode).toBe(200);

    const seen = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(client.token),
    });
    expect(seen.json().valuation.state).toBe('started');
  });

  it('reflects a write made through another repo', async () => {
    // repos/organizations.ts writes the valuations row directly; it has to
    // invalidate too, or the entity type stays stale for the whole TTL.
    const v = await create('Subsidiary Co');
    await findValuationById(ctx.pool, v.id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}/entity`,
      headers: authHeader(client.token),
      payload: { entity_type: 'subsidiary' },
    });
    expect(patched.statusCode).toBe(200);

    expect((await findValuationById(ctx.pool, v.id))?.entity_type).toBe('subsidiary');
  });

  it('re-reads after an explicit invalidation', async () => {
    const v = await create('Manual Invalidation Co');
    await findValuationById(ctx.pool, v.id);

    await ctx.pool.query('UPDATE valuations SET company_name = $2 WHERE id = $1', [
      v.id,
      'Renamed Behind The Cache',
    ]);
    invalidateValuation(v.id);

    expect((await findValuationById(ctx.pool, v.id))?.company_name).toBe('Renamed Behind The Cache');
  });

  it('caches a miss without turning it into a false hit for a real id', async () => {
    const absent = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(await findValuationById(ctx.pool, absent)).toBeNull();
    const v = await create('Exists After A Miss');
    expect((await findValuationById(ctx.pool, v.id))?.id).toBe(v.id);
  });
});
