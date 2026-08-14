import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_PAGE_LIMIT, recordEvent } from '../../src/events/record.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The raw event spine is read a page at a time, not all of it.
 *
 * `valuation_events` is append-only and nothing prunes it: a param patch, a
 * calculation, a document, a comment and an AI job each write a row, and each
 * carries a `payload` JSONB. `GET /valuations/:id/events` selected every one of
 * them for a sidebar panel — on the same table whose audit-trail route had
 * already been given a ceiling. Two doors onto one growing table, one bounded
 * and one not.
 *
 * The engagement panel had the mirror-image of the same bug: it read the whole
 * spine and then `.slice(-40)`, so the cap it documented cost exactly as much
 * as having no cap at all.
 */
describe.skipIf(!dbUp)('event spine read bounds', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    valuationId = res.json().valuation.id as string;

    // A long-lived engagement's worth of spine. `note_added` is a real type and
    // carries a payload, so the rows cost what production rows cost.
    for (let i = 0; i < 120; i += 1) {
      await recordEvent(ctx.pool, {
        valuationId,
        type: 'note_added',
        actor: { actorType: 'human', actorId: ops.id, source: 'api' },
        payload: { n: i },
      });
    }
  });
  afterAll(async () => ctx?.teardown());

  const events = (query = '') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events${query}`,
      headers: authHeader(ops.token),
    });

  it('serves the newest page and says the history runs deeper', async () => {
    const res = await events('?limit=25');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(25);
    expect(body.truncated).toBe(true);
    expect(body.page_limit).toBe(EVENT_PAGE_LIMIT);

    // Ascending, and it is the *newest* 25 — an activity panel that kept the
    // oldest 25 would freeze on the day the engagement was opened.
    const ns = body.events.map((e: { payload: { n?: number } }) => e.payload.n);
    expect(ns).toEqual([...ns].sort((a: number, b: number) => a - b));
    expect(ns.at(-1)).toBe(119);
  });

  it('does not claim truncation when the page holds everything', async () => {
    const res = await events();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 120 notes plus the creation events — comfortably inside the ceiling.
    expect(body.truncated).toBe(false);
    expect(body.events.length).toBeGreaterThan(120);
    expect(body.events.length).toBeLessThanOrEqual(EVENT_PAGE_LIMIT);
  });

  it('refuses a limit past the ceiling rather than honouring it', async () => {
    // The ceiling is the point. A caller that can ask for 10,000,000 rows has
    // an unbounded query with extra steps.
    const res = await events(`?limit=${EVENT_PAGE_LIMIT + 1}`);
    expect(res.statusCode).toBe(400);
    const res0 = await events('?limit=0');
    expect(res0.statusCode).toBe(400);
  });

  it('caps the engagement activity feed in SQL, not after it', async () => {
    // Advance the engagement so the panel has one to render.
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect([200, 201]).toContain(created.statusCode);

    // Count what the *database* hands back, not what the response keeps: the
    // bug was a correct forty-row panel sitting on top of a select of the
    // whole spine, which no assertion on the response body can see.
    const spineReads: number[] = [];
    const realQuery = ctx.pool.query.bind(ctx.pool);
    (ctx.pool as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await (realQuery as (...a: unknown[]) => Promise<{ rowCount: number | null }>)(
        ...args,
      );
      const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      if (/FROM valuation_events/i.test(sql)) spineReads.push(result.rowCount ?? 0);
      return result;
    };

    let body: { activity: Array<{ occurred_at: string }> };
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/engagement`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      body = res.json();
    } finally {
      (ctx.pool as { query: unknown }).query = realQuery;
    }

    // The engagement has 120+ events. No read of the spine may return more
    // than the forty the panel renders.
    expect(spineReads.length).toBeGreaterThan(0);
    for (const rows of spineReads) expect(rows).toBeLessThanOrEqual(40);

    // ...and the panel still shows the newest forty, newest first.
    expect(body.activity).toHaveLength(40);
    const times = body.activity.map((e) => Date.parse(e.occurred_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('still refuses a reader who cannot see the engagement', async () => {
    const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events?limit=5`,
      headers: authHeader(stranger.token),
    });
    // 404 rather than 403: the paging parameters must not become an oracle for
    // whether the id exists.
    expect(res.statusCode).toBe(404);
  });
});
