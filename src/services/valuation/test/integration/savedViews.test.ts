import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { findVisibleViewByQuery } from '../../src/repos/savedViews.js';

/** Saved worklist views (feature-improvements §2 "Saved views"). */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('saved views', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let otherOps: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    otherOps = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const create = (token: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/saved-views',
      headers: authHeader(token),
      payload,
    });

  const list = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/saved-views', headers: authHeader(token) });

  it('requires authentication', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/saved-views' })).statusCode).toBe(401);
  });

  it('creates a private view and returns it to its owner only', async () => {
    const res = await create(ops.token, {
      name: 'My reviews due this week',
      query: '?reviewer_id=me&due_to=2026-08-06&sort=due_date:asc',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().view.visibility).toBe('private');

    const mine = await list(ops.token);
    expect(mine.json().views.map((v: { name: string }) => v.name)).toContain('My reviews due this week');

    const theirs = await list(otherOps.token);
    expect(theirs.json().views).toHaveLength(0);
  });

  it('strips unknown keys and pagination from the stored query', async () => {
    const res = await create(ops.token, {
      name: 'Sanitised',
      // page/per_page are a scroll position, not a filter; `evil` is not a
      // filter the list understands at all.
      query: 'state=in_review&page=4&per_page=100&evil=1&q=&kind=409a',
    });
    expect(res.statusCode).toBe(201);
    const stored = res.json().view.query as string;
    expect(stored).not.toContain('page');
    expect(stored).not.toContain('evil');
    // Empty values are dropped, and the rest is key-sorted so equivalent
    // views built by different click paths compare equal.
    expect(stored).toBe('kind=409a&state=in_review');
  });

  it('rejects a duplicate name for the same owner, case-insensitively', async () => {
    expect((await create(ops.token, { name: 'Overdue' })).statusCode).toBe(201);
    const dup = await create(ops.token, { name: 'overdue' });
    expect(dup.statusCode).toBe(409);
    // A different owner may reuse the name.
    expect((await create(otherOps.token, { name: 'Overdue' })).statusCode).toBe(201);
  });

  it('publishes a shared view to the ops team but not to clients', async () => {
    const res = await create(ops.token, {
      name: 'Unpaid over 7 days',
      query: 'paid_status=unpaid',
      visibility: 'shared',
    });
    expect(res.statusCode).toBe(201);

    const other = await list(otherOps.token);
    const shared = other.json().views.find((v: { name: string }) => v.name === 'Unpaid over 7 days');
    expect(shared).toBeTruthy();
    // Not theirs to rename or delete, and labelled with whose it is.
    expect(shared.is_owner).toBe(false);
    expect(shared.owner_name).toBe(ops.email);

    const asClient = await list(client.token);
    expect(asClient.json().views).toHaveLength(0);
  });

  it('does not let a client share a view', async () => {
    const res = await create(client.token, { name: 'Mine', visibility: 'shared' });
    expect(res.statusCode).toBe(403);
    // …but a private one is fine.
    expect((await create(client.token, { name: 'Mine' })).statusCode).toBe(201);
  });

  it('keeps at most one default per owner', async () => {
    const first = await create(ops.token, { name: 'Default A', is_default: true });
    const second = await create(ops.token, { name: 'Default B', is_default: true });
    expect(second.statusCode).toBe(201);

    const views = (await list(ops.token)).json().views as { id: string; is_default: boolean }[];
    const defaults = views.filter((v) => v.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(second.json().view.id);
    expect(views.find((v) => v.id === first.json().view.id)!.is_default).toBe(false);
  });

  it('lets the owner rename and re-query a view', async () => {
    const created = await create(ops.token, { name: 'Draft name', query: 'state=started' });
    const id = created.json().view.id as string;

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/saved-views/${id}`,
      headers: authHeader(ops.token),
      payload: { name: 'Final name', query: 'state=in_review&sort=created_at:desc' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().view.name).toBe('Final name');
    expect(patched.json().view.query).toBe('sort=created_at%3Adesc&state=in_review');
  });

  it('hides someone else’s view behind a 404 on write', async () => {
    const created = await create(ops.token, { name: 'Private to ops' });
    const id = created.json().view.id as string;

    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/api/v1/saved-views/${id}`,
        headers: authHeader(otherOps.token),
        payload: method === 'PATCH' ? { name: 'Hijacked' } : undefined,
      });
      // 404, not 403 — a 403 would confirm the id exists.
      expect(res.statusCode).toBe(404);
    }
  });

  it('deletes a view', async () => {
    const created = await create(ops.token, { name: 'Temporary' });
    const id = created.json().view.id as string;

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/saved-views/${id}`,
      headers: authHeader(ops.token),
    });
    expect(del.statusCode).toBe(204);
    expect((await list(ops.token)).json().views.some((v: { id: string }) => v.id === id)).toBe(false);
  });

  it('rejects a malformed id without touching the database', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/saved-views/not-a-ulid',
      headers: authHeader(ops.token),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty name and an empty patch', async () => {
    expect((await create(ops.token, { name: '   ' })).statusCode).toBe(422);
    const created = await create(ops.token, { name: 'Patch target' });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/saved-views/${created.json().view.id}`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  describe('findVisibleViewByQuery', () => {
    /*
     * The lookup behind the partner pin's idempotency check, tested at the repo
     * because the invariant is about the SQL and not about the route.
     *
     * The visibility predicate is `owner_id = $1 OR (ops AND shared)`, and this
     * function appends `AND v.query = $3` to it. `AND` binds tighter than `OR`,
     * so without parentheses around the pair the filter reaches only the shared
     * branch and every view the principal *owns* matches regardless of its
     * query — the lookup answers "yes, already pinned" for a firm that has
     * never been pinned, and the operator opens somebody else's queue.
     */
    let owner: Awaited<ReturnType<typeof seedUser>>;

    beforeAll(async () => {
      owner = await seedUser(ctx, { roles: ['admin'] });
      for (const q of ['partner_id=01JQ0000000000000000000001', 'partner_id=01JQ0000000000000000000002']) {
        const res = await create(owner.token, {
          name: `Owned ${q.slice(-2)}`,
          query: q,
          visibility: 'shared',
        });
        expect(res.statusCode).toBe(201);
      }
    });

    it('matches a view the principal owns only when the query is the one asked for', async () => {
      const hit = await findVisibleViewByQuery(ctx.pool, {
        userId: owner.id,
        includeShared: true,
        query: 'partner_id=01JQ0000000000000000000002',
      });
      expect(hit?.query).toBe('partner_id=01JQ0000000000000000000002');
    });

    it('finds nothing for a query nobody saved, rather than the principal’s first view', async () => {
      const miss = await findVisibleViewByQuery(ctx.pool, {
        userId: owner.id,
        includeShared: true,
        query: 'partner_id=01JQ0000000000000000000009',
      });
      expect(miss).toBeNull();
    });

    it('still filters correctly for a principal who owns nothing', async () => {
      // The shared branch on its own — the half that was accidentally the only
      // one the filter reached.
      const stranger = await seedUser(ctx, { roles: ['admin'] });
      const hit = await findVisibleViewByQuery(ctx.pool, {
        userId: stranger.id,
        includeShared: true,
        query: 'partner_id=01JQ0000000000000000000001',
      });
      expect(hit?.query).toBe('partner_id=01JQ0000000000000000000001');

      const miss = await findVisibleViewByQuery(ctx.pool, {
        userId: stranger.id,
        includeShared: false,
        query: 'partner_id=01JQ0000000000000000000001',
      });
      expect(miss).toBeNull();
    });
  });
});
