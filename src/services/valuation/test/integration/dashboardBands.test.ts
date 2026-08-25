import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The landing dashboard's three added bands (design §3.1).
 *
 * The property that has to hold across every one of them is scope. A count, a
 * company name in an activity row and a throughput bar are all disclosures, and
 * an aggregate that includes engagements the caller may not open is the same
 * cross-firm leak the scope sweep exists to catch — just in a smaller font.
 */
describe.skipIf(!dbUp)('dashboard bands', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let outsider: Awaited<ReturnType<typeof seedUser>>;
  let ownId: string;

  interface Bands {
    buckets: Record<string, { total: number; unread: number }>;
    activity: Array<{ type: string; label: string; company_name: string; valuation_id: string }>;
    throughput: Array<{ week: string; count: number }>;
    sla: { overdue: number; waiting_stale: number; waiting_days: number };
  }

  const dashboard = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: authHeader(token) });

  const create = async (companyName: string, token: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: companyName },
    });
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    outsider = await seedUser(ctx, { roles: ['valuation_user'] });

    ownId = await create('OwnCo', client.token);
    const otherId = await create('OtherCo', outsider.token);
    const overdueId = await create('OverdueCo', client.token);
    const waitingId = await create('WaitingCo', client.token);
    const publishedId = await create('PublishedCo', client.token);

    // Overdue: due last week, nothing published.
    await pool.query(`UPDATE valuations SET due_date = now() - interval '8 days' WHERE id = $1`, [overdueId]);
    // Waiting on the client, with no contact for a fortnight.
    await pool.query(
      `UPDATE valuations
          SET waiting_on_client = true, state = 'completed', created_at = now() - interval '20 days'
        WHERE id = $1`,
      [waitingId],
    );
    // Published two weeks ago — inside the twelve-week window.
    await pool.query(
      `UPDATE valuations SET state = 'published', published_at = now() - interval '14 days' WHERE id = $1`,
      [publishedId],
    );
    // Delivered a month late: past its due date, but finished. Not a breach.
    const latePublishedId = await create('LatePublishedCo', client.token);
    await pool.query(
      `UPDATE valuations
          SET due_date = now() - interval '30 days', state = 'published', published_at = now()
        WHERE id = $1`,
      [latePublishedId],
    );
    // A client comment leaves the admin side of the conversation unread.
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${ownId}/comments`,
      headers: authHeader(client.token),
      payload: { kind: 'chat', body: 'any update?' },
    });
    // …and one an operator has already read, so the two readers' tallies have
    // to differ. This is the case migration 0113 exists for: one badge shared
    // by every reader goes stale for all of them at once.
    const readId = await create('ReadCo', client.token);
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${readId}/comments`,
      headers: authHeader(client.token),
      payload: { kind: 'chat', body: 'and this one?' },
    });
    await pool.query(`UPDATE valuations SET admin_read_at = now() WHERE id = $1`, [readId]);
    expect(otherId).toBeTruthy();
    // Everything below reads one 20-second-cached snapshot of the same six
    // engagements. Seeding inside a test would have it compared against the
    // snapshot taken before it, which is the cache working as designed.
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('serves a tally per named bucket', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    expect(bands.buckets.all.total).toBe(7);
    expect(bands.buckets.published.total).toBe(2);
    expect(bands.buckets.waiting_on_client.total).toBe(1);
    // `pending` is where a freshly created engagement starts.
    expect(bands.buckets.incomplete.total).toBe(4);
  });

  it('counts unread per bucket for the asking reader', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    // The operator has read ReadCo, so only OwnCo is outstanding for them.
    expect(bands.buckets.all.unread).toBe(1);
    expect(bands.buckets.incomplete.unread).toBe(1);
    // The unread bucket is the unread rows themselves.
    expect(bands.buckets.unread.total).toBe(1);
    // The client's side of both conversations is unmarked, so they see two —
    // per-reader, which is the whole point of the read markers.
    const own = (await dashboard(client.token)).json() as Bands;
    expect(own.buckets.all.unread).toBe(2);
  });

  it('reports the two SLA figures', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    expect(bands.sla.overdue).toBe(1);
    expect(bands.sla.waiting_stale).toBe(1);
    expect(bands.sla.waiting_days).toBe(7);
  });

  it('does not count a published engagement as overdue', async () => {
    // LatePublishedCo is thirty days past its due date and delivered. Finished
    // late is not an open breach, so only OverdueCo counts.
    const bands = (await dashboard(ops.token)).json() as Bands;
    expect(bands.sla.overdue).toBe(1);
    expect(bands.buckets.published.total).toBe(2);
  });

  it('returns every week in the window, including the empty ones', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    expect(bands.throughput).toHaveLength(12);
    // A sparkline drawn only from the non-empty weeks would compress an outage
    // into a continuous line.
    expect(bands.throughput.filter((w) => w.count === 0).length).toBeGreaterThan(0);
    expect(bands.throughput.reduce((n, w) => n + w.count, 0)).toBe(2);
    // Ordered oldest first, so the last bar is this week.
    const weeks = bands.throughput.map((w) => w.week);
    expect([...weeks].sort()).toEqual(weeks);
  });

  it('carries an activity feed naming the engagement each row is about', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    expect(bands.activity.length).toBeGreaterThan(0);
    expect(bands.activity.every((row) => typeof row.company_name === 'string')).toBe(true);
    expect(bands.activity.some((row) => row.company_name === 'OwnCo')).toBe(true);
  });

  /**
   * The feed used to send only the type, and the browser named it from a map
   * of its own that had drifted from the service's event catalog — the row
   * read "State changed" here and "Stage changed" in the change log. The
   * label is decided once, server-side, and travels with the row.
   */
  it('names each activity row from the event catalog', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    const created = bands.activity.find((row) => row.type === 'valuation_created');
    expect(created?.label).toBe('Valuation created');
    // Every row, not just the catalogued ones: the feed mixes in `admin_events`,
    // which have no catalog, and a row with no name is worse than a derived one.
    expect(bands.activity.every((row) => (row.label ?? '').length > 0)).toBe(true);
  });

  it('never shows a client another client’s engagements in any band', async () => {
    const bands = (await dashboard(outsider.token)).json() as Bands;
    expect(bands.buckets.all.total).toBe(1);
    expect(bands.sla.overdue).toBe(0);
    expect(bands.sla.waiting_stale).toBe(0);
    expect(bands.throughput.reduce((n, w) => n + w.count, 0)).toBe(0);
    // The feed is the sharpest of the four: it carries company names.
    expect(bands.activity.every((row) => row.company_name === 'OtherCo')).toBe(true);
  });

  it('agrees with the listing tab strip, which reads the same tallies', async () => {
    const bands = (await dashboard(ops.token)).json() as Bands;
    const counts = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/valuations/counts?buckets=named',
        headers: authHeader(ops.token),
      })
    ).json().counts as Record<string, number>;
    for (const [key, tally] of Object.entries(bands.buckets)) {
      expect(counts[key]).toBe(tally.total);
    }
  });
});
