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

  async function seedValuation(user: { id: string }, company: string, equity: number | null, kind = '409a') {
    const v = await createValuation(
      ctx.pool,
      { kind, companyName: company, userId: user.id },
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

  it('ships each entity’s own caption for the two 409A-named columns', async () => {
    /*
     * Both columns are 409A columns by name and every specialty engine writes
     * into them, so the portfolio table headed "Equity value" / "FMV/share" was
     * printing an IFRS 2 total share-based-payment *expense* under the first and
     * an EMI restricted AMV under the second — the latter being exactly the
     * figure a board must not adopt as a §409A price. A heading cannot vary per
     * row, so the caption has to arrive on the row.
     */
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Mixed Vocabulary Group', entity_type: 'holding_company' },
    });
    const orgId = created.json().organization.id;
    const parent = await seedValuation(owner, 'Vocab Parent', 10_000_000);
    const memo = await seedValuation(owner, 'Vocab IFRS2 Ltd', 420_000, 'ifrs2');
    const emi = await seedValuation(owner, 'Vocab EMI Ltd', 3_000_000, 'emi');
    for (const [v, type] of [
      [parent, 'parent'],
      [memo, 'subsidiary'],
      [emi, 'subsidiary'],
    ] as const) {
      const assign = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: v.id, entity_type: type },
      });
      expect(assign.statusCode).toBe(204);
    }

    for (const url of [`/api/v1/organizations/${orgId}`, `/api/v1/organizations/${orgId}/consolidated`]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(owner.token) });
      expect(res.statusCode, url).toBe(200);
      const byId = new Map<string, Record<string, unknown>>(
        res.json().entities.map((e: { valuation_id: string }) => [e.valuation_id, e]),
      );

      // The 409A row: both headings already say what its figures are.
      expect(byId.get(parent.id)!.equity_figure, url).toEqual({
        caption: 'Concluded equity value',
        is_default: true,
      });

      // The expense, still carried and no longer captioned as equity.
      expect(byId.get(memo.id)!.equity_value, url).toBe(420_000);
      expect(byId.get(memo.id)!.equity_figure, url).toEqual({
        caption: 'Total expense',
        is_default: false,
      });

      // The restricted AMV, named as the one of two per-share figures it is.
      expect(byId.get(emi.id)!.per_share_figure, url).toEqual({
        caption: 'Actual market value (AMV) per share',
        is_default: false,
      });
    }
  });

  it('counts a subsidiary whose parent never arrived, and names it', async () => {
    // The two-step flow: `POST /entities` takes the type, the parent link is a
    // separate PATCH. Stopping after the first step is not an error anywhere,
    // and until this was fixed it removed the subsidiary's whole equity from
    // the consolidated figure — the one the page labels as the group's.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Half-linked Group', entity_type: 'holding_company' },
    });
    const orgId = created.json().organization.id;
    const parent = await seedValuation(owner, 'Linked Parent', 10_000_000);
    const sub = await seedValuation(owner, 'Orphan Sub', 3_000_000);
    for (const [v, type] of [
      [parent, 'parent'],
      [sub, 'subsidiary'],
    ] as const) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: v.id, entity_type: type },
      });
    }
    // No PATCH linking sub to parent — that is the whole scenario.
    const body = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      })
    ).json();
    expect(body.consolidated.total_equity_value).toBe(13_000_000);
    expect(body.consolidated.consolidated_equity_value).toBe(13_000_000);
    expect(body.consolidated.unanchored_subsidiaries).toEqual([
      { valuation_id: sub.id, company_name: 'Orphan Sub' },
    ]);
  });

  it('re-counts a subsidiary once its parent leaves the organization', async () => {
    // Detaching the parent is one request and says nothing about the child.
    // Before the fix the roll-up kept eliminating the subsidiary against a
    // parent that had gone, so removing a 10M entity moved the consolidated
    // figure by 13M.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name: 'Departing Parent Group', entity_type: 'holding_company' },
    });
    const orgId = created.json().organization.id;
    const parent = await seedValuation(owner, 'Leaving Parent', 10_000_000);
    const sub = await seedValuation(owner, 'Staying Sub', 3_000_000);
    for (const [v, type] of [
      [parent, 'parent'],
      [sub, 'subsidiary'],
    ] as const) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: v.id, entity_type: type },
      });
    }
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${sub.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'subsidiary', parent_valuation_id: parent.id },
    });

    const before = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      })
    ).json();
    expect(before.consolidated.consolidated_equity_value).toBe(10_000_000);
    expect(before.consolidated.unanchored_subsidiaries).toEqual([]);

    const detached = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${orgId}/entities/${parent.id}`,
      headers: authHeader(owner.token),
    });
    expect(detached.statusCode).toBe(204);

    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      })
    ).json();
    expect(after.consolidated.total_equity_value).toBe(3_000_000);
    expect(after.consolidated.consolidated_equity_value).toBe(3_000_000);
    expect(after.consolidated.unanchored_subsidiaries).toEqual([
      { valuation_id: sub.id, company_name: 'Staying Sub' },
    ]);
  });

  it('refuses a standalone entity with a parent', async () => {
    const parent = await seedValuation(owner, 'Contradiction Parent', 1_000_000);
    const child = await seedValuation(owner, 'Contradiction Child', 1_000_000);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${child.id}/entity`,
      headers: authHeader(owner.token),
      payload: { entity_type: 'standalone', parent_valuation_id: parent.id },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/standalone entity has no parent/);
  });

  describe('deleting an organization accounts for what it was holding', () => {
    async function group(name: string) {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authHeader(owner.token),
        payload: { name, entity_type: 'holding_company' },
      });
      return created.json().organization.id as string;
    }

    it('refuses while the organization still holds engagements', async () => {
      const orgId = await group('Populated Group');
      const sub = await seedValuation(owner, 'Held Sub', 1_000_000);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: sub.id, entity_type: 'portfolio_company' },
      });

      const refused = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().detail).toMatch(/1 engagement/);
      // And it really did not delete it.
      const still = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      });
      expect(still.statusCode).toBe(200);
    });

    it('deletes an empty organization without an acknowledgement', async () => {
      const orgId = await group('Empty Group');
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        deleted: true,
        detached_entities: [],
        reparented_organizations: [],
      });
    });

    it('returns detached engagements to standalone rather than leaving the type behind', async () => {
      // `ON DELETE SET NULL` cleared organization_id and left entity_type, so a
      // valuation came out of this typed `portfolio_company` and belonging to
      // no portfolio — and, until the roll-up learned to check, a `subsidiary`
      // in that state was worth its whole equity in somebody's total.
      const orgId = await group('Dissolving Group');
      const parent = await seedValuation(owner, 'Dissolving Parent', 4_000_000);
      const sub = await seedValuation(owner, 'Dissolving Sub', 1_000_000);
      for (const [v, type] of [
        [parent, 'parent'],
        [sub, 'subsidiary'],
      ] as const) {
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/organizations/${orgId}/entities`,
          headers: authHeader(owner.token),
          payload: { valuation_id: v.id, entity_type: type },
        });
      }
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${sub.id}/entity`,
        headers: authHeader(owner.token),
        payload: { entity_type: 'subsidiary', parent_valuation_id: parent.id },
      });

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${orgId}?detach=true`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().detached_entities.sort()).toEqual([parent.id, sub.id].sort());

      const { rows } = await ctx.pool.query(
        'SELECT id, organization_id, entity_type, parent_valuation_id FROM valuations WHERE id = ANY($1)',
        [[parent.id, sub.id]],
      );
      for (const row of rows) {
        expect(row.organization_id).toBeNull();
        expect(row.entity_type).toBe('standalone');
        expect(row.parent_valuation_id).toBeNull();
      }
    });

    it('closes the holdco tree up instead of re-rooting the children', async () => {
      // SET NULL was the database's default answer, not a decision: deleting a
      // middle node scattered its children to the top of the tree.
      const grandparent = await group('Top Group');
      const middle = await group('Middle Group');
      const child = await group('Child Group');
      for (const [id, parentId] of [
        [middle, grandparent],
        [child, middle],
      ] as const) {
        const res = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/organizations/${id}`,
          headers: authHeader(owner.token),
          payload: { parent_org_id: parentId },
        });
        expect(res.statusCode).toBe(200);
      }

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${middle}?detach=true`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reparented_organizations).toEqual([child]);

      const after = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${child}`,
        headers: authHeader(owner.token),
      });
      expect(after.json().organization.parent_org_id).toBe(grandparent);
    });

    it('is still a 404 to somebody else, before it is a 409', async () => {
      // Order matters: the conflict names how many engagements the
      // organization holds, which is not something a stranger may learn.
      const orgId = await group('Not Yours');
      const sub = await seedValuation(owner, 'Not Yours Sub', 1_000_000);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: sub.id },
      });
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${orgId}`,
        headers: authHeader(other.token),
      });
      expect(res.statusCode).toBe(404);
    });
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

  /**
   * The ops read of this list is every organization on the platform, and it
   * fills a `<select>` on the engagement page. Capped, and honest about it —
   * an organization missing from an assignment picker reads as one that cannot
   * be assigned.
   */
  describe('bounded reads', () => {
    it('caps the list and says so', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: authHeader(owner.token),
          payload: { name: `Capped Holdings ${i}`, entity_type: 'holding_company' },
        });
        expect(res.statusCode, res.body).toBe(201);
      }

      const capped = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/organizations?limit=2',
        headers: authHeader(owner.token),
      });
      expect(capped.statusCode).toBe(200);
      const body = capped.json() as { organizations: unknown[]; truncated: boolean };
      expect(body.organizations).toHaveLength(2);
      expect(body.truncated).toBe(true);
    });

    it('does not claim truncation when everything fits', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: authHeader(owner.token),
      });
      expect((res.json() as { truncated: boolean }).truncated).toBe(false);
    });

    it('refuses a limit past the ceiling rather than honouring it', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/organizations?limit=100000',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it('still scopes a non-ops caller to their own organizations when capped', async () => {
      // The cap must not become a way to see somebody else's rows.
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/organizations?limit=200',
        headers: authHeader(other.token),
      });
      expect((res.json() as { organizations: unknown[] }).organizations).toEqual([]);
    });
  });

  /**
   * The two ids in `DELETE /organizations/:id/entities/:valuationId` describe
   * one relationship, and each used to be checked only against the caller.
   *
   * The handler authorized the organization, authorized the engagement, and
   * then cleared `organization_id` unconditionally — so it removed the
   * engagement from whichever roll-up it was really in, not from the one the
   * URL named, and answered 204 as though it had done what was asked. Every id
   * passes its own check, which is why three authorization sweeps walked past
   * it: the fault is in the relationship between them, and nothing was looking
   * there.
   */
  describe('detaching an entity names the organization it is in', () => {
    it('refuses when the engagement belongs to a different organization', async () => {
      const home = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: authHeader(owner.token),
          payload: { name: 'Home Group' },
        })
      ).json().organization.id as string;
      const elsewhere = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: authHeader(owner.token),
          payload: { name: 'Unrelated Group' },
        })
      ).json().organization.id as string;

      const member = await seedValuation(owner, 'Member Co', 1_000_000);
      expect(
        (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/organizations/${home}/entities`,
            headers: authHeader(owner.token),
            payload: { valuation_id: member.id, entity_type: 'standalone' },
          })
        ).statusCode,
      ).toBe(204);

      // Same caller, same rights over both rows — the only thing wrong is that
      // this engagement is not in this organization.
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${elsewhere}/entities/${member.id}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(404);

      // And the membership it was not asked about is still there. Without this
      // the case above would pass on a handler that detached the engagement and
      // then 404ed.
      const home_after = (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/organizations/${home}`,
          headers: authHeader(owner.token),
        })
      ).json();
      expect(home_after.entities.map((e: { valuation_id: string }) => e.valuation_id)).toEqual([member.id]);
    });

    it('still detaches when the organization named is the one it is in', async () => {
      const org = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: authHeader(owner.token),
          payload: { name: 'Correct Group' },
        })
      ).json().organization.id as string;
      const member = await seedValuation(owner, 'Correct Member Co', 2_000_000);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${org}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: member.id, entity_type: 'standalone' },
      });

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${org}/entities/${member.id}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(204);

      const after = (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/organizations/${org}`,
          headers: authHeader(owner.token),
        })
      ).json();
      expect(after.entities).toEqual([]);
    });
  });
});
