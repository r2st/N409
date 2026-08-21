import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { ORG_ENTITY_PAGE_LIMIT, listPortfolioEntities } from '../../src/repos/organizations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * The organization's entity list — the last client-facing read that had no
 * bound and no soft delete.
 *
 * It looks scoped, which is why it was missed by both sweeps: `WHERE
 * organization_id = $1` reads like a small set. Nothing caps how many
 * engagements a user assigns to one organization, and the query runs a LATERAL
 * subquery per row, so the cost is one query per entity.
 *
 * Both halves matter here more than on an ordinary list, because this one is
 * not only displayed — `consolidate()` adds it up. A short read is a
 * consolidated equity value that is short by an unknown amount, and an archived
 * row is an engagement counted into a holding company's total after it has
 * disappeared from the list, the search, the dashboard and the export.
 */
describe.skipIf(!dbUp)('portfolio entity list bounds', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let orgId: string;

  /** A valued engagement, assigned to `orgId`. Returns its valuation id. */
  async function seedEntity(company: string, equity: number): Promise<string> {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: owner.id },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 1, equity_value: equity },
        equityValue: equity,
        fmvPerShare: 1,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    const assigned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/entities`,
      headers: authHeader(owner.token),
      payload: { valuation_id: v.id, entity_type: 'standalone' },
    });
    expect(assigned.statusCode).toBe(204);
    return v.id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Bounds Holdings', entity_type: 'holding_company' },
    });
    expect(created.statusCode).toBe(201);
    orgId = created.json().organization.id as string;
  });
  afterAll(async () => ctx?.teardown());

  describe('the cap', () => {
    let ids: string[];

    beforeAll(async () => {
      // Three entities, each worth 100. The cap itself is 500, far above any
      // real portfolio, so it is reached with an explicit `?limit=` — the same
      // code path, since the route clamps into the repo and the repo fetches
      // limit + 1 to decide the flag.
      ids = [
        await seedEntity('Bounds Sub A', 100),
        await seedEntity('Bounds Sub B', 100),
        await seedEntity('Bounds Sub C', 100),
      ];
      expect(ids).toHaveLength(3);
    });

    it('reports an untruncated read when the portfolio fits', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entities).toHaveLength(3);
      expect(body.truncated).toBe(false);
      expect(body.entity_page_limit).toBe(ORG_ENTITY_PAGE_LIMIT);
      expect(body.consolidated.total_equity_value).toBe(300);
    });

    it('flags a capped read rather than serving a short portfolio silently', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}?limit=2`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entities).toHaveLength(2);
      expect(body.truncated).toBe(true);
      // The point of the flag: this number is 200, not 300, and without
      // `truncated` nothing on the response distinguishes that from a
      // two-entity holding company.
      expect(body.consolidated.total_equity_value).toBe(200);
      expect(body.consolidated.entity_count).toBe(2);
    });

    it('flags the capped read on /consolidated too', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/consolidated?limit=2`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().truncated).toBe(true);
      expect(res.json().entity_page_limit).toBe(ORG_ENTITY_PAGE_LIMIT);
    });

    it('clamps a caller asking past the ceiling instead of honouring it', async () => {
      const page = await listPortfolioEntities(ctx.pool, orgId, {
        limit: ORG_ENTITY_PAGE_LIMIT + 1_000,
      });
      expect(page.entities).toHaveLength(3);
      expect(page.truncated).toBe(false);
    });

    it('refuses a limit past the ceiling on the route', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}?limit=${ORG_ENTITY_PAGE_LIMIT + 1}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it('cuts deterministically, so two reads of one cap agree', async () => {
      const first = await listPortfolioEntities(ctx.pool, orgId, { limit: 2 });
      const again = await listPortfolioEntities(ctx.pool, orgId, { limit: 2 });
      expect(again.entities.map((e) => e.valuation_id)).toEqual(first.entities.map((e) => e.valuation_id));
    });
  });

  describe('retired engagements', () => {
    let retiredId: string;

    beforeAll(async () => {
      retiredId = await seedEntity('Bounds Retired Sub', 5_000);
      // Archiving stamps `archived_at` and nothing else — not `state`, not the
      // organization link. The guard below proves the row is still attached and
      // still valued, so a passing exclusion test cannot be passing vacuously.
      await ctx.pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
    });

    it('still holds the row, attached and valued (vacuity guard)', async () => {
      const { rows } = await ctx.pool.query<{ organization_id: string | null; state: string }>(
        'SELECT organization_id, state FROM valuations WHERE id = $1',
        [retiredId],
      );
      expect(rows[0]?.organization_id).toBe(orgId);
      expect(rows[0]?.state).not.toBe('abandoned');
    });

    it('drops it from the entity list', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().entities.map((e: { valuation_id: string }) => e.valuation_id);
      expect(ids).not.toContain(retiredId);
    });

    it('drops its equity from the consolidated roll-up', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}/consolidated`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const consolidated = res.json().consolidated;
      // Three live entities at 100 each. The retired one is worth 5,000 — an
      // amount that cannot hide inside a rounding difference, so this fails
      // loudly if the archived filter is ever dropped again.
      expect(consolidated.entity_count).toBe(3);
      expect(consolidated.total_equity_value).toBe(300);
    });
  });
});
