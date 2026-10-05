import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * A PATCH echoing back the current `state` alongside other field changes must
 * not trigger the transition write guard.
 *
 * Before R383 the route attached `preCommit: stateWriteGuard(…)` whenever
 * `parsed.data.state` was truthy, regardless of whether it differed from the
 * row's current state. `assertTransitionForWrite` then read `live === to` and
 * threw a 409 ("already at X — someone else made that change"), so any client
 * that echoed the current state back with another field edit got a bogus
 * conflict.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('PATCH with unchanged state alongside other fields', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  async function createEngagement(state: string): Promise<{ id: string; version: number }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'NoOp State Co' },
    });
    expect(res.statusCode).toBe(201);
    const { id, version } = res.json().valuation;
    if (state !== 'pending') await forceState(ctx, id, state);
    return { id, version };
  }

  it('accepts a PATCH echoing back the current state with a field change', async () => {
    const { id } = await createEngagement('started');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state: 'started', company_name: 'Renamed Co' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.company_name).toBe('Renamed Co');
    expect(res.json().valuation.state).toBe('started');
  });

  it('still refuses an actual illegal transition alongside a field change', async () => {
    const { id } = await createEngagement('pending');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state: 'published', company_name: 'Renamed Co' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('accepts a no-op state PATCH on a terminal state with a field change', async () => {
    const { id } = await createEngagement('published');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state: 'published', company_name: 'Terminal Rename' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.company_name).toBe('Terminal Rename');
  });
});
