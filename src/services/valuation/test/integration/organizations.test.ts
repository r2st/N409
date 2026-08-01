import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('organizations / portfolio (feature 6)', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let other: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    other = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation(user: { id: string }, company: string, equity: number | null) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: user.id },
      { ...actor, actorId: user.id },
    );
    if (equity !== null) {
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
          createdBy: user.id,
        },
        { ...actor, actorId: user.id },
      );
    }
    return v;
  }

  it('creates an org, assigns entities, and consolidates the portfolio', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Acme Holdings', entity_type: 'holding_company' },
    });
    expect(created.statusCode).toBe(201);
    const orgId = created.json().organization.id;

    const parent = await seedValuation(owner, 'Acme Parent', 10_000_000);
    const sub = await seedValuation(owner, 'Acme Sub', 3_000_000);

    for (const [v, type] of [
      [parent, 'parent'],
      [sub, 'subsidiary'],
    ] as const) {
      const assign = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: v.id, entity_type: type },
      });
      expect(assign.statusCode).toBe(204);
    }

    // Inter-company reference: sub rolls up to parent.
    const rel = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${sub.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'subsidiary', parent_valuation_id: parent.id },
    });
    expect(rel.statusCode).toBe(200);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}`,
      headers: authHeader(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.entities).toHaveLength(2);
    expect(body.consolidated.total_equity_value).toBe(13_000_000);
    expect(body.consolidated.consolidated_equity_value).toBe(10_000_000); // sub excluded
    expect(body.tree.childrenOf[parent.id]).toEqual([sub.id]);
  });

  it('hides organizations from non-owners', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Private Fund' },
    });
    const orgId = created.json().organization.id;

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: authHeader(other.token),
    });
    expect(list.json().organizations.map((o: { id: string }) => o.id)).not.toContain(orgId);

    const peek = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${orgId}`,
      headers: authHeader(other.token),
    });
    expect(peek.statusCode).toBe(404);
  });

  it("refuses to assign another user's valuation", async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Grabby Holdings' },
    });
    const orgId = created.json().organization.id;
    const foreign = await seedValuation(other, 'Not Yours', 1_000_000);

    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/entities`,
      headers: authHeader(owner.token),
      payload: { valuation_id: foreign.id },
    });
    expect(assign.statusCode).toBe(404);
  });
  it('refuses to close a loop in the inter-company hierarchy', async () => {
    // A parents B; making A a child of B would leave neither with a root, and
    // buildEntityTree would drop both from the portfolio view.
    const parent = await seedValuation(owner, 'Loop Parent', 5_000_000);
    const child = await seedValuation(owner, 'Loop Child', 1_000_000);

    const link = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${child.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'subsidiary', parent_valuation_id: parent.id },
    });
    expect(link.statusCode).toBe(200);

    const loop = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${parent.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'subsidiary', parent_valuation_id: child.id },
    });
    expect(loop.statusCode).toBe(422);
    expect(loop.json().detail).toMatch(/loop/i);
  });

  it('refuses to close a longer loop, not just a direct swap', async () => {
    const a = await seedValuation(owner, 'Chain A', null);
    const b = await seedValuation(owner, 'Chain B', null);
    const c = await seedValuation(owner, 'Chain C', null);

    for (const [childId, parentId] of [
      [b.id, a.id],
      [c.id, b.id],
    ]) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${childId}/entity`,
        headers: authHeader(owner.token),
        payload: { entity_type: 'subsidiary', parent_valuation_id: parentId },
      });
      expect(res.statusCode).toBe(200);
    }

    // a → b → c → a
    const loop = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${a.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'subsidiary', parent_valuation_id: c.id },
    });
    expect(loop.statusCode).toBe(422);
  });

  it('refuses to close a loop in the organization hierarchy', async () => {
    const mk = async (name: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authHeader(owner.token),
        payload: { name },
      });
      return res.json().organization.id as string;
    };
    const top = await mk('Top Holdings');
    const mid = await mk('Mid Holdings');

    const nest = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${mid}`,
      headers: authHeader(owner.token),
      payload: { parent_org_id: top },
    });
    expect(nest.statusCode).toBe(200);

    const loop = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${top}`,
      headers: authHeader(owner.token),
      payload: { parent_org_id: mid },
    });
    expect(loop.statusCode).toBe(422);
    expect(loop.json().detail).toMatch(/loop/i);
  });
});
