import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

/**
 * What the portfolio doors cost per engagement they move (round 385,
 * methodology M8).
 *
 * Round 384 put `organization_id`, `entity_type` and `parent_valuation_id` on
 * `valuation_events`, and paid for it with a `SELECT … FOR UPDATE` ahead of
 * every write: the event has to say what the membership *was*, and
 * `UPDATE … RETURNING` hands back the row as it now is. That is a deliberate
 * round trip on a single-row door and it is the right trade.
 *
 * The one place it could have become something else is `deleteOrganization`,
 * which detaches a whole book at once — a holding company being wound up. Its
 * read is over `organization_id`, which 0079 indexes, and its write is
 * `recordEvents`, which batches through `unnest`. Neither is per member, and
 * this asserts that as a *difference*: deepen the organization fourfold and the
 * number of statements must not move. A count taken at one size would pass over
 * the loop it exists to refuse.
 *
 * `assignValuationToOrg` is pinned the same way — one door, one shape,
 * whichever of its four branches the payload picks — because the read it added
 * is per call and a second one would be invisible in a response.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/** Statements a request issues, ignoring the transaction verbs around them. */
function statementCounter(ctx: TestApp): { count: () => number; reset: () => void; stop: () => void } {
  let seen = 0;
  const stop = interceptPoolQueries(ctx.pool, (sql, phase) => {
    if (phase !== 'before') return undefined;
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return undefined;
    seen += 1;
    return undefined;
  });
  return { count: () => seen, reset: () => (seen = 0), stop };
}

describe.skipIf(!dbUp)('portfolio write doors cost the same per call at any size', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation(company: string) {
    return createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: owner.id },
      { ...actor, actorId: owner.id },
    );
  }

  async function orgWithMembers(name: string, members: number): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(owner.token),
      payload: { name, entity_type: 'holding_company' },
    });
    expect(created.statusCode).toBe(201);
    const orgId = created.json().organization.id;
    for (let i = 0; i < members; i += 1) {
      const v = await seedValuation(`${name} member ${i}`);
      const assign = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/entities`,
        headers: authHeader(owner.token),
        payload: { valuation_id: v.id, entity_type: 'subsidiary' },
      });
      expect(assign.statusCode).toBe(204);
    }
    return orgId;
  }

  it('detaches a whole book in a fixed number of statements', async () => {
    const small = await orgWithMembers('Winding Up Small', 3);
    const large = await orgWithMembers('Winding Up Large', 12);

    const meter = statementCounter(ctx);
    try {
      meter.reset();
      const first = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${small}?detach=true`,
        headers: authHeader(owner.token),
      });
      expect(first.statusCode).toBe(200);
      const atThree = meter.count();

      meter.reset();
      const second = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/organizations/${large}?detach=true`,
        headers: authHeader(owner.token),
      });
      expect(second.statusCode).toBe(200);
      const atTwelve = meter.count();

      expect(atThree).toBeGreaterThan(0);
      expect(atTwelve).toBe(atThree);
    } finally {
      meter.stop();
    }
  });

  it('writes one membership event per detached engagement all the same', async () => {
    /*
     * The discriminator for the count above: a batch that dropped rows rather
     * than batching them would also hold the statement count flat. Every member
     * has to end up on its own engagement's spine, which is what
     * `portfolio_membership_changed` is keyed on.
     */
    const orgId = await orgWithMembers('Winding Up Counted', 5);
    const { rows: before } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM valuation_events WHERE type = 'portfolio_membership_changed'`,
    );
    const gone = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${orgId}?detach=true`,
      headers: authHeader(owner.token),
    });
    expect(gone.statusCode).toBe(200);
    const { rows: after } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM valuation_events WHERE type = 'portfolio_membership_changed'`,
    );
    expect(Number(after[0].n) - Number(before[0].n)).toBe(5);
  });

  it('assigns one engagement in a fixed number of statements, whichever branch it takes', async () => {
    const orgId = await orgWithMembers('Branch Shapes', 0);
    const v = await seedValuation('Branch Shapes member');

    const meter = statementCounter(ctx);
    const counts: number[] = [];
    try {
      for (const payload of [
        { valuation_id: v.id, entity_type: 'subsidiary' },
        { valuation_id: v.id, entity_type: 'parent' },
        { valuation_id: v.id, entity_type: 'standalone' },
      ]) {
        meter.reset();
        const assigned = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/organizations/${orgId}/entities`,
          headers: authHeader(owner.token),
          payload,
        });
        expect(assigned.statusCode).toBe(204);
        counts.push(meter.count());
      }
    } finally {
      meter.stop();
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(new Set(counts).size).toBe(1);
  });
});
