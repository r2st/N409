import type { FastifyInstance } from 'fastify';
import { newUlid } from '@n409/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { decodeCursor } from '../../src/domain/pagination.js';
import {
  DELIVERIES_PAGE_MAX,
  listDeliveries,
} from '../../src/repos/partnerWebhooks.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Cursor pagination, against a real database.
 *
 * The unit suite proves a cursor round-trips and that a forged one is refused.
 * Neither says the thing that matters, which is that walking the cursor visits
 * every row exactly once — and the two ways that fails (a skipped row, a
 * repeated row) are both invisible from inside a single page. So these tests
 * walk to the end and compare the *set* of ids against what was written, which
 * is the only assertion that can catch either.
 *
 * The concurrent-write cases are the point of the exercise. Offset paging is
 * correct on a table nobody is writing to; it is wrong exactly when the table
 * is being appended to while it is read, which is the normal condition of a
 * delivery log and the condition an incident review reads it under.
 */
describe.skipIf(!dbUp)('cursor pagination', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let webhookId: string;

  const keyHeader = () => ({ authorization: `Bearer ${apiKey}` });

  /**
   * Writes deliveries directly rather than through the send path.
   *
   * `created_at` is passed in so ties can be *forced*: the interesting case for
   * a keyset predicate is a group of rows sharing a timestamp straddling a page
   * boundary, and letting `now()` assign them would produce that only by luck.
   */
  const seedDeliveries = async (count: number, createdAt?: string): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = newUlid();
      ids.push(id);
      await ctx.pool.query(
        `INSERT INTO partner_webhook_deliveries
           (id, webhook_id, event_type, payload, status, created_at)
         VALUES ($1, $2, 'valuation.published', '{}'::jsonb, 'delivered',
                 coalesce($3::timestamptz, now() + ($4 || ' microseconds')::interval))`,
        [id, webhookId, createdAt ?? null, String(i)],
      );
    }
    return ids;
  };

  const clearDeliveries = async () => {
    await ctx.pool.query('DELETE FROM partner_webhook_deliveries WHERE webhook_id = $1', [webhookId]);
  };

  /** Walks every page via the HTTP endpoint, returning ids in the order served. */
  const walkHttp = async (limit: number): Promise<{ ids: string[]; pages: number }> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      const res = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?${query.toString()}`,
        headers: keyHeader(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        deliveries: Array<{ id: string; cursor: string }>;
        next_cursor: string | null;
        has_more: boolean;
      };
      pages++;
      ids.push(...body.deliveries.map((d) => d.id));
      expect(body.next_cursor !== null).toBe(body.has_more);
      if (!body.has_more) break;
      cursor = body.next_cursor;
      // A walk that does not terminate is a bug in its own right; fail loudly
      // rather than hanging the suite until the runner's timeout.
      expect(pages).toBeLessThan(200);
    }
    return { ids, pages };
  };

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(10_000, 60_000) });
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Cursor Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'cursors' },
    });
    apiKey = minted.json().secret as string;

    webhookId = newUlid();
    await ctx.pool.query(
      `INSERT INTO partner_webhooks (id, partner_id, url, secret, events, enabled)
       VALUES ($1, $2, 'https://example.com/hook', 'sekrit', '{}', true)`,
      [webhookId, partnerId],
    );
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  describe('reaching history past the first page', () => {
    it('walks past the fifty rows the endpoint used to cap at', async () => {
      // The regression this round exists for. `listDeliveries` was `LIMIT 50`
      // with no cursor, so a partner reconciling an outage that produced more
      // than fifty deliveries could see the tail of it and never the start.
      await clearDeliveries();
      const written = await seedDeliveries(120);
      const { ids } = await walkHttp(25);
      expect(ids).toHaveLength(120);
      expect(new Set(ids)).toEqual(new Set(written));
    });

    it('serves each row exactly once across page boundaries', async () => {
      await clearDeliveries();
      await seedDeliveries(37);
      const { ids } = await walkHttp(10);
      expect(ids).toHaveLength(new Set(ids).size);
      expect(ids).toHaveLength(37);
    });

    it('orders newest first, and the same way on every page size', async () => {
      await clearDeliveries();
      // Each row is written a microsecond after the last, so the order the
      // endpoint should serve is exactly the reverse of the write order.
      const written = await seedDeliveries(30);
      const byOne = await walkHttp(1);
      const byThirteen = await walkHttp(13);
      const byAll = await walkHttp(100);
      expect(byAll.ids).toEqual([...written].reverse());
      // And the page size must not change *which* rows land where — a client
      // that raises its page size should see the same sequence, not a reshuffle.
      expect(byOne.ids).toEqual(byAll.ids);
      expect(byThirteen.ids).toEqual(byAll.ids);
      expect(byOne.pages).toBe(30);
      expect(byAll.pages).toBe(1);
    });
  });

  describe('rows that tie on created_at', () => {
    it('walks a tied group that straddles a page boundary', async () => {
      // Every row shares one instant to the microsecond — the case
      // `created_at DESC` alone cannot order, and where a keyset predicate
      // without an id tiebreaker either loops forever or skips the group.
      await clearDeliveries();
      const written = await seedDeliveries(20, '2026-03-01T12:00:00.500000Z');
      const { ids } = await walkHttp(7);
      expect(ids).toHaveLength(20);
      expect(new Set(ids)).toEqual(new Set(written));
    });

    it('does not re-serve the tied group when the cursor lands inside it', async () => {
      await clearDeliveries();
      await seedDeliveries(6, '2026-03-01T12:00:00.500000Z');
      const first = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=3`,
        headers: keyHeader(),
      });
      const firstBody = first.json() as { deliveries: Array<{ id: string }>; next_cursor: string };
      const second = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=3&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
        headers: keyHeader(),
      });
      const secondBody = second.json() as { deliveries: Array<{ id: string }> };
      const firstIds = firstBody.deliveries.map((d) => d.id);
      const secondIds = secondBody.deliveries.map((d) => d.id);
      // The bug a `<=` on the timestamp would produce: the whole tied group
      // served again on page two.
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    });

    it('preserves the microseconds the cursor is compared on', async () => {
      await clearDeliveries();
      await seedDeliveries(2, '2026-03-01T12:00:00.123456Z');
      const res = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=1`,
        headers: keyHeader(),
      });
      const body = res.json() as { next_cursor: string };
      // A cursor rounded to milliseconds would read `.123000Z` and exclude the
      // row it was built from — and every other row inside that millisecond.
      expect(decodeCursor(body.next_cursor)?.at).toBe('2026-03-01T12:00:00.123456Z');
    });
  });

  describe('under concurrent writes', () => {
    it('never skips a pre-existing row when new ones arrive mid-walk', async () => {
      // The failure offset paging has and keyset paging does not. With OFFSET,
      // a row inserted between page 1 and page 2 pushes every unread row down
      // by one, and the row that crossed the boundary is never served.
      await clearDeliveries();
      const original = await seedDeliveries(40);
      const seen: string[] = [];
      let cursor: string | null = null;
      let page = 0;
      for (;;) {
        const query = new URLSearchParams({ limit: '10' });
        if (cursor) query.set('cursor', cursor);
        const res = await app.inject({
          method: 'GET',
          url: `/api/partner/v1/webhooks/${webhookId}/deliveries?${query.toString()}`,
          headers: keyHeader(),
        });
        const body = res.json() as {
          deliveries: Array<{ id: string }>;
          next_cursor: string | null;
          has_more: boolean;
        };
        seen.push(...body.deliveries.map((d) => d.id));
        page++;
        // Five new deliveries land between every page, as they would during an
        // incident that is still generating events.
        await seedDeliveries(5);
        if (!body.has_more) break;
        cursor = body.next_cursor;
        expect(page).toBeLessThan(100);
      }
      // Every row that existed when the walk started was served…
      for (const id of original) expect(seen).toContain(id);
      // …and none was served twice. Rows written mid-walk are newer than the
      // cursor, so they land on the page the client already read past — which
      // is the trade a keyset walk makes and the one that keeps it honest.
      expect(seen).toHaveLength(new Set(seen).size);
    });

    it('does not strand the walk when the cursor row is deleted mid-walk', async () => {
      // Retention prunes this table. A cursor naming a row that no longer
      // exists must still resolve, which it does because the cursor carries the
      // position rather than a reference to be looked up.
      await clearDeliveries();
      await seedDeliveries(20);
      const first = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=5`,
        headers: keyHeader(),
      });
      const firstBody = first.json() as { deliveries: Array<{ id: string }>; next_cursor: string };
      const anchor = firstBody.deliveries[4]!.id;
      await ctx.pool.query('DELETE FROM partner_webhook_deliveries WHERE id = $1', [anchor]);

      const second = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=5&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
        headers: keyHeader(),
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as { deliveries: Array<{ id: string }>; has_more: boolean };
      expect(secondBody.deliveries).toHaveLength(5);
      expect(secondBody.deliveries.map((d) => d.id)).not.toContain(anchor);
    });
  });

  describe('per-row cursors', () => {
    it('resumes from any row the client has already seen', async () => {
      await clearDeliveries();
      await seedDeliveries(20);
      const first = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=10`,
        headers: keyHeader(),
      });
      const firstBody = first.json() as { deliveries: Array<{ id: string; cursor: string }> };
      // Resume from the third row rather than from the end of the page.
      const resumed = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=5&cursor=${encodeURIComponent(firstBody.deliveries[2]!.cursor)}`,
        headers: keyHeader(),
      });
      const resumedBody = resumed.json() as { deliveries: Array<{ id: string }> };
      expect(resumedBody.deliveries.map((d) => d.id)).toEqual(
        firstBody.deliveries.slice(3, 8).map((d) => d.id),
      );
    });
  });

  describe('bad input', () => {
    it('answers 400 for a cursor we did not write, not 500', async () => {
      // The whole point of validating in `decodeCursor`: an uncastable string
      // reaching the driver is a 500, which reads as our fault and tells a
      // partner debugging their pagination loop nothing.
      for (const bad of ['nonsense', Buffer.from('a.b').toString('base64url'), 'A'.repeat(199)]) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/partner/v1/webhooks/${webhookId}/deliveries?cursor=${encodeURIComponent(bad)}`,
          headers: keyHeader(),
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('refuses a page size past the ceiling rather than honouring it', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries?limit=${DELIVERIES_PAGE_MAX + 1}`,
        headers: keyHeader(),
      });
      expect(res.statusCode).toBe(400);
    });

    it('caps the repo at the ceiling even when called directly', async () => {
      // The route validates, but the repo is called from elsewhere too and the
      // bound belongs on the query rather than on one of its callers.
      await clearDeliveries();
      await seedDeliveries(3);
      const page = await listDeliveries(ctx.pool, webhookId, { limit: 10_000 });
      expect(page.items).toHaveLength(3);
      expect(page.hasMore).toBe(false);
    });
  });

  describe('the valuations list', () => {
    /** Created through the API, so `created_at` and scoping are the real ones. */
    const createValuation = async (companyName: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: keyHeader(),
        payload: { kind: '409a', company_name: companyName },
      });
      expect(res.statusCode).toBe(201);
      return res.json().valuation.id as string;
    };

    const listPage = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/valuations?${query}`,
        headers: keyHeader(),
      });
      expect(res.statusCode).toBe(200);
      return res.json() as {
        valuations: Array<{ id: string }>;
        total: number;
        page: number;
        per_page: number;
        next_cursor: string | null;
        has_more: boolean;
      };
    };

    let created: string[];

    beforeAll(async () => {
      created = [];
      for (let i = 0; i < 12; i++) created.push(await createValuation(`Cursor Co ${i}`));
    }, 60_000);

    it('hands back a cursor on a page nobody asked for one on', async () => {
      // Without this a client could never *start* a cursor walk: the only
      // source of a cursor would be a response it needed a cursor to get.
      const first = await listPage('per_page=5');
      expect(first.has_more).toBe(true);
      expect(first.next_cursor).not.toBeNull();
      expect(decodeCursor(first.next_cursor!)).not.toBeNull();
    });

    it('walks the whole list without repeating or skipping', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const page: Awaited<ReturnType<typeof listPage>> = await listPage(
          `per_page=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        seen.push(...page.valuations.map((v) => v.id));
        if (!page.has_more) break;
        cursor = page.next_cursor;
      }
      for (const id of created) expect(seen).toContain(id);
      expect(seen).toHaveLength(new Set(seen).size);
    });

    it('reports the size of the whole set, not of what is left after the cursor', async () => {
      // `total` counting down as a client pages would break every UI that
      // renders it, and would be a different question from the one asked.
      const first = await listPage('per_page=5');
      const second = await listPage(`per_page=5&cursor=${encodeURIComponent(first.next_cursor!)}`);
      expect(second.total).toBe(first.total);
      expect(first.total).toBeGreaterThanOrEqual(created.length);
    });

    it('keeps the page/per_page/total contract for clients that never send a cursor', async () => {
      // The compatibility assertion: cursors are additive, and a client paging
      // by number must not notice they exist.
      const body = await listPage('page=2&per_page=5');
      expect(body.page).toBe(2);
      expect(body.per_page).toBe(5);
      expect(body.valuations).toHaveLength(5);
      const firstPage = await listPage('page=1&per_page=5');
      const overlap = body.valuations
        .map((v) => v.id)
        .filter((id) => firstPage.valuations.some((v) => v.id === id));
      expect(overlap).toEqual([]);
    });

    it('agrees with offset paging on an idle table', async () => {
      // The two schemes should differ only under concurrent writes. If they
      // disagree with nothing being written, one of them is simply wrong.
      const viaOffset: string[] = [];
      for (let page = 1; page <= 4; page++) {
        viaOffset.push(...(await listPage(`page=${page}&per_page=4`)).valuations.map((v) => v.id));
      }
      const viaCursor: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const body: Awaited<ReturnType<typeof listPage>> = await listPage(
          `per_page=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        viaCursor.push(...body.valuations.map((v) => v.id));
        if (!body.has_more) break;
        cursor = body.next_cursor;
      }
      expect(viaCursor.slice(0, viaOffset.length)).toEqual(viaOffset);
    });

    it('applies the state filter to a cursor page as well', async () => {
      // A filter dropped on the second page would hand back the whole book to
      // a client that asked for one slice of it — the same failure the
      // unknown-state rejection exists to prevent, one page later.
      const filtered = await listPage('state=pending&per_page=3');
      expect(filtered.valuations.length).toBeGreaterThan(0);
      if (filtered.has_more) {
        const next = await listPage(
          `state=pending&per_page=3&cursor=${encodeURIComponent(filtered.next_cursor!)}`,
        );
        expect(next.total).toBe(filtered.total);
      }
      const unfiltered = await listPage('per_page=3');
      expect(filtered.total).toBeLessThanOrEqual(unfiltered.total);
    });

    it('answers 400 for a forged cursor', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/partner/v1/valuations?cursor=not-a-real-cursor',
        headers: keyHeader(),
      });
      expect(res.statusCode).toBe(400);
    });

    it('does not leak the cursor column into the valuation body', async () => {
      // `cursor_at` is selected to build the cursor and must be stripped before
      // the row is serialised; the response schema is strict, so a leak here is
      // a 500 rather than a cosmetic extra field.
      const body = await listPage('per_page=1');
      expect(body.valuations[0]).not.toHaveProperty('cursor_at');
    });
  });

  describe('an empty log', () => {
    it('terminates immediately rather than handing out a cursor to nowhere', async () => {
      await clearDeliveries();
      const res = await app.inject({
        method: 'GET',
        url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
        headers: keyHeader(),
      });
      const body = res.json() as { deliveries: unknown[]; next_cursor: string | null; has_more: boolean };
      expect(body.deliveries).toEqual([]);
      expect(body.has_more).toBe(false);
      expect(body.next_cursor).toBeNull();
    });
  });
});
