import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The partner-scoped entry point (design §4.4, P2-19).
 *
 * Shipped as a saved view over the existing listing rather than as a second
 * listing page, so what the tests hold is that the *existing* listing really
 * is partner-scoped end to end — counts, tabs and rows — and that the pin is a
 * one-click, repeatable way back to it.
 */
describe.skipIf(!dbUp)('partner-scoped listing entry point', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let alpha: string;
  let beta: string;

  const create = async (companyName: string, partnerId: string | null, state?: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().valuation.id as string;
    await ctx.pool.query(
      `UPDATE valuations SET partner_id = $2, state = COALESCE($3::valuation_state, state) WHERE id = $1`,
      [id, partnerId, state ?? null],
    );
    return id;
  };

  const detail = async (partnerId: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/partners/${partnerId}`,
      headers: authHeader(admin.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().partner as {
      valuations_by_bucket: Record<string, number>;
      valuations_by_group: Record<string, number>;
    };
  };

  const pin = async (partnerId: string, token = admin.token) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/saved-view`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    alpha = await seedPartner(ctx, 'Alpha Advisors');
    beta = await seedPartner(ctx, 'Beta Partners');

    await create('Alpha One', alpha, 'started');
    await create('Alpha Two', alpha, 'published');
    await create('Alpha Three', alpha, 'review');
    await create('Beta One', beta, 'started');
    await create('Unaffiliated Co', null, 'started');
  });
  afterAll(async () => ctx?.teardown());

  describe('counts of its own', () => {
    it('carries the nine named buckets scoped to the firm', async () => {
      const partner = await detail(alpha);
      expect(partner.valuations_by_bucket.all).toBe(3);
      expect(partner.valuations_by_bucket.published).toBe(1);
      expect(partner.valuations_by_bucket.in_progress).toBe(1);
      expect(partner.valuations_by_bucket.incomplete).toBe(1);
    });

    it('counts each firm separately and excludes unaffiliated engagements', async () => {
      expect((await detail(beta)).valuations_by_bucket.all).toBe(1);
    });

    it('agrees with the listing’s own counts for the same scope', async () => {
      // The firm page and the page it links to must not be two answers to
      // "how many are in progress".
      const partner = await detail(alpha);
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/counts?buckets=named&partner_id=${alpha}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      const counts = res.json().counts as Record<string, number>;
      for (const key of Object.keys(partner.valuations_by_bucket)) {
        expect(counts[key], key).toBe(partner.valuations_by_bucket[key]);
      }
    });

    it('keeps the state-group rollups the page already showed', async () => {
      const partner = await detail(alpha);
      expect(partner.valuations_by_group.published).toBe(1);
    });
  });

  describe('the listing behind it', () => {
    it('returns only the firm’s engagements', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?partner_id=${alpha}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().valuations as Array<{ company_name: string }>;
      expect(rows.map((r) => r.company_name).sort()).toEqual(['Alpha One', 'Alpha Three', 'Alpha Two']);
    });

    it('composes the firm scope with a bucket tab', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?partner_id=${alpha}&bucket=published`,
        headers: authHeader(admin.token),
      });
      const rows = res.json().valuations as Array<{ company_name: string }>;
      expect(rows.map((r) => r.company_name)).toEqual(['Alpha Two']);
    });
  });

  describe('pinning', () => {
    it('creates a shared view holding the firm’s query', async () => {
      const res = await pin(alpha);
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as {
        view: { name: string; query: string; visibility: string };
        created: boolean;
      };
      expect(body).toMatchObject({ created: true });
      expect(body.view).toMatchObject({
        name: 'Alpha Advisors',
        query: `partner_id=${alpha}`,
        visibility: 'shared',
      });
    });

    it('is idempotent — a second pin returns the same view, not a conflict', async () => {
      // The button reads "open the firm's queue" to an operator, and a second
      // click has to mean that too.
      const res = await pin(alpha);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ created: false });

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/saved-views',
        headers: authHeader(admin.token),
      });
      const views = list.json().views as Array<{ query: string }>;
      expect(views.filter((v) => v.query === `partner_id=${alpha}`)).toHaveLength(1);
    });

    it('does not confuse one firm’s view for another’s', async () => {
      const res = await pin(beta);
      expect(res.statusCode).toBe(201);
      expect(res.json().view.query).toBe(`partner_id=${beta}`);
    });

    it('survives the firm being renamed — the query is what the view is', async () => {
      await ctx.pool.query('UPDATE partners SET name = $2 WHERE id = $1', [beta, 'Beta Capital']);
      const res = await pin(beta);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ created: false });
    });

    it('is operations-only', async () => {
      expect((await pin(alpha, client.token)).statusCode).toBe(403);
    });

    it('404s an unknown firm rather than pinning an empty query', async () => {
      expect((await pin('01N409PARTNERMISSING000001')).statusCode).toBe(404);
      expect((await pin('not-a-ulid')).statusCode).toBe(404);
    });
  });
});
