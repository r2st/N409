import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The shared inbox (409.ai §17) — cross-engagement threads with per-reader
 * unread state.
 */
describe.skipIf(!dbUp)('inbox API', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let support: Awaited<ReturnType<typeof seedUser>>;
  let partnerUser: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let outsider: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;
  let ownValuation: string;
  let partnerValuation: string;

  const createValuation = async (token: string, companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const comment = async (token: string, valuationId: string, body: string, kind = 'chat') => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(token),
      payload: { kind, body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().comment.id as string;
  };

  const inbox = async (token: string, query = '') => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/inbox${query}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      items: Array<{ id: string; body: string; kind: string; unread: boolean; valuation_id: string }>;
      total: number;
      unread_total: number;
    };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    partnerId = await seedPartner(ctx, 'Inbox Firm');
    admin = await seedUser(ctx, { roles: ['admin'] });
    support = await seedUser(ctx, { roles: ['support'] });
    partnerUser = await seedUser(ctx, { roles: ['partner'], partnerId });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    outsider = await seedUser(ctx, { roles: ['valuation_user'] });

    ownValuation = await createValuation(client.token, 'Client Co');
    partnerValuation = await createValuation(partnerUser.token, 'Firm Portfolio Co');

    await comment(client.token, ownValuation, 'Where do I upload the cap table?');
    await comment(admin.token, ownValuation, 'Internal: chase the charter', 'note');
    await comment(partnerUser.token, partnerValuation, 'Any update on this one?');
  });
  afterAll(async () => ctx?.teardown());

  describe('scoping', () => {
    it('shows ops every thread on the platform', async () => {
      const body = await inbox(admin.token);
      expect(body.total).toBe(3);
      expect(body.items.map((i) => i.body)).toContain('Where do I upload the cap table?');
      expect(body.items.map((i) => i.body)).toContain('Any update on this one?');
    });

    it("shows a partner user only their firm's threads", async () => {
      const body = await inbox(partnerUser.token);
      expect(body.total).toBe(1);
      expect(body.items[0]!.valuation_id).toBe(partnerValuation);
    });

    it('shows a client only their own thread', async () => {
      const body = await inbox(client.token);
      expect(body.items.map((i) => i.valuation_id)).toEqual([ownValuation]);
    });

    it('shows an unrelated client nothing at all', async () => {
      expect((await inbox(outsider.token)).total).toBe(0);
    });

    it('never leaks an internal note outside ops', async () => {
      // Same rule the per-engagement thread uses: a client sees `chat` and
      // nothing else, so the note on their own valuation stays invisible.
      const body = await inbox(client.token);
      expect(body.items.map((i) => i.kind)).not.toContain('note');
      expect(await inbox(admin.token).then((b) => b.items.map((i) => i.kind))).toContain('note');
    });

    it('refuses to filter to a kind the reader cannot see', async () => {
      const body = await inbox(client.token, '?kind=note');
      expect(body.total).toBe(0);
    });
  });

  describe('read state', () => {
    it('starts everything unread for a reader who has never looked', async () => {
      const body = await inbox(support.token);
      expect(body.unread_total).toBe(body.total);
      expect(body.items.every((i) => i.unread)).toBe(true);
    });

    it('is per reader — one analyst reading does not clear it for another', async () => {
      const before = await inbox(admin.token);
      expect(before.unread_total).toBeGreaterThan(0);

      const read = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/read',
        headers: authHeader(support.token),
        payload: { valuation_id: ownValuation },
      });
      expect(read.statusCode).toBe(200);

      const supportAfter = await inbox(support.token);
      expect(supportAfter.items.filter((i) => i.valuation_id === ownValuation).every((i) => i.unread)).toBe(
        false,
      );
      // The other analyst's inbox is untouched.
      expect((await inbox(admin.token)).unread_total).toBe(before.unread_total);
    });

    it('counts threads and not comments in the nav badge', async () => {
      // "3" should mean three files want attention, not "someone wrote nine
      // paragraphs".
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/inbox/unread-count',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().unread_threads).toBe(2); // two engagements, three comments
    });

    it('marks a thread unread again when a new comment lands', async () => {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/read',
        headers: authHeader(support.token),
        payload: { valuation_id: partnerValuation },
      });
      expect((await inbox(support.token)).unread_total).toBe(0);

      await comment(client.token, ownValuation, 'Following up on the above.');
      const after = await inbox(support.token);
      expect(after.unread_total).toBe(1);
      expect(after.items[0]!.body).toBe('Following up on the above.');
    });

    it('clears everything in scope with read-all, and only in scope', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/read-all',
        headers: authHeader(partnerUser.token),
      });
      expect(res.statusCode).toBe(200);
      expect((await inbox(partnerUser.token)).unread_total).toBe(0);
      // The partner admin's sweep did not touch anyone else's engagements.
      expect((await inbox(admin.token)).unread_total).toBeGreaterThan(0);
    });

    it('404s a read mark on an engagement the caller cannot see', async () => {
      // A read mark is keyed to an engagement id; writing one for an id the
      // caller cannot read would confirm it exists.
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/read',
        headers: authHeader(outsider.token),
        payload: { valuation_id: ownValuation },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('filtering and paging', () => {
    it('searches body, company name and engagement number', async () => {
      expect((await inbox(admin.token, '?q=cap%20table')).total).toBe(1);
      expect((await inbox(admin.token, '?q=Firm%20Portfolio')).total).toBe(1);
    });

    it('filters to unread only', async () => {
      const all = await inbox(admin.token);
      const unread = await inbox(admin.token, '?unread=true');
      expect(unread.total).toBeLessThanOrEqual(all.total);
      expect(unread.items.every((i) => i.unread)).toBe(true);
    });

    it('pages without dropping rows to the scope filter', async () => {
      // The scope predicate runs in SQL before LIMIT — filtering after paging
      // would hand back a short page and call it page one.
      const first = await inbox(admin.token, '?per_page=2&page=1');
      const second = await inbox(admin.token, '?per_page=2&page=2');
      expect(first.items).toHaveLength(2);
      expect(first.total).toBe(second.total);
      expect(first.items.map((i) => i.id)).not.toEqual(second.items.map((i) => i.id));
    });

    it('rejects an implausible page rather than 500ing on OFFSET', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/inbox?page=10000000000000000000',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
