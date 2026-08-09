import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Design §4.2 — the nine named tabs, end to end.
 *
 * The contract worth pinning is that the count on a tab and the rows behind it
 * come from the same definition. A tab reading "In Progress 4" that lists three
 * rows is worse than no tab: it makes the operator distrust the whole screen.
 */
describe.skipIf(!dbUp)('named listing buckets', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const counts = async (query = '') => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/counts?buckets=named${query}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().counts as Record<string, number>;
  };

  const listBucket = async (bucket: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations?bucket=${bucket}&per_page=100`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode, bucket).toBe(200);
    return res.json().valuations as Array<{ id: string; state: string }>;
  };

  const create = async (company: string, state: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: company },
    });
    const id = res.json().valuation.id as string;
    await pool.query('UPDATE valuations SET state = $2 WHERE id = $1', [id, state]);
    return id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { email: 'buckets@client.example', roles: ['valuation_user'] });

    await create('Incomplete One', 'started');
    await create('Incomplete Two', 'onboarding_completed');
    await create('Unverified One', 'user_finished');
    await create('InProgress One', 'review');
    await create('InProgress Two', 'paid');
    await create('Drafted One', 'drafted');
    await create('Published One', 'published');
    await create('Ignored One', 'cancelled');
    const waiting = await create('Waiting One', 'review');
    await pool.query('UPDATE valuations SET waiting_on_client = true WHERE id = $1', [waiting]);
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('serves nine buckets with their labels', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations/counts?buckets=named',
      headers: authHeader(ops.token),
    });
    const buckets = res.json().buckets as Array<{ key: string; label: string }>;
    expect(buckets).toHaveLength(9);
    expect(buckets.map((b) => b.label)).toContain('Waiting On Client');
  });

  it('counts each named bucket', async () => {
    const c = await counts();
    expect(c.all).toBe(9);
    expect(c.incomplete).toBe(2);
    expect(c.unverified).toBe(1);
    // 'review' ×2 (one of which is also waiting) + 'paid'.
    expect(c.in_progress).toBe(3);
    expect(c.drafted).toBe(1);
    expect(c.published).toBe(1);
    expect(c.ignored).toBe(1);
    expect(c.waiting_on_client).toBe(1);
  });

  it('counts the state buckets to exactly All', async () => {
    const c = await counts();
    const stateBuckets = c.incomplete + c.unverified + c.in_progress + c.drafted + c.published + c.ignored;
    expect(stateBuckets).toBe(c.all);
  });

  it('the count on a tab equals the rows the tab lists', async () => {
    const c = await counts();
    for (const bucket of [
      'incomplete',
      'unverified',
      'in_progress',
      'drafted',
      'published',
      'ignored',
      'waiting_on_client',
    ]) {
      expect((await listBucket(bucket)).length, bucket).toBe(c[bucket]);
    }
  });

  it('counts the waiting bucket across the lifecycle, not as a state', async () => {
    // The one already counted under In Progress is also here — a file can be
    // both, which is why this bucket is a boolean and not a state list.
    const waiting = await listBucket('waiting_on_client');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.state).toBe('review');
  });

  it('tracks unread per reader', async () => {
    const before = await counts();
    expect(before.unread).toBe(0);

    const target = (await listBucket('published'))[0]!.id;
    const posted = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${target}/comments`,
      headers: authHeader(client.token),
      payload: { kind: 'chat', body: 'Any update?' },
    });
    expect(posted.statusCode).toBe(201);

    // The count cache is keyed per reader side and holds for 15s, so the
    // assertion goes through the list — same predicate, no cache.
    expect(await listBucket('unread')).toHaveLength(1);
  });

  it('still answers the five-group shape by default', async () => {
    // `group` remains a URL alias so saved views and shared links do not break.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations/counts',
      headers: authHeader(ops.token),
    });
    const c = res.json().counts as Record<string, number>;
    expect(Object.keys(c).sort()).toEqual(
      ['all', 'closed', 'drafted', 'in_review', 'open', 'published'].sort(),
    );
  });

  it('scopes named counts to the caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations/counts?buckets=named',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    // The client owns all nine, so this is a scoping smoke test rather than a
    // leak test; the cross-firm case is covered by the partner sweep.
    expect(res.json().counts.all).toBe(9);
  });
});
