import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Retirement and restore, against the optimistic-lock counter.
 *
 * `lockCounterDiscipline.test.ts` states the rule and pins both of its
 * directions for the writers it knew about: every writer of a column a guarded
 * form posts advances `valuations.version`, including the ones that never send
 * `If-Match` themselves, and the two writers of columns no form posts
 * (`markValuationRead`, the comment stamp) deliberately do not.
 *
 * Retirement and restore are the only other writers of `valuations` that touch
 * such a column. Both rewrite `company_name` — retirement appends ` [retired]`
 * so the name can be reused, restore takes it back off — and `company_name` is
 * in `OPS_PATCH_FIELDS` and `OWNER_PATCH_FIELDS` both. Neither moved the
 * counter, so an ETag read before either was still accepted after it.
 *
 * Restore is the half where that is reachable rather than merely untrue.
 * `refuseIfRetired` refuses every write to a retired engagement, so nobody gets
 * to spend a stale ETag against one — but *reads* stay open on purpose, so an
 * analyst can be sitting on the detail page of a retired engagement when an
 * admin restores it. Their form still says "Acme [retired]"; their next save
 * matched on version and went through, and the field they had not touched was
 * the one that had changed.
 *
 * The other three writers of this table — `organization_id` / `entity_type` /
 * `parent_valuation_id` in `repos/organizations.ts` and `auto_pipeline` in
 * `repos/pipelineRuns.ts` — write no field either form posts, and are exempt by
 * the same rule that exempts the read marker.
 */
describe.skipIf(!dbUp)('the lock counter across retirement and restore', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const row = async (id: string) =>
    (
      await ctx.pool.query<{ version: number; company_name: string; archived_at: Date | null }>(
        'SELECT version, company_name, archived_at FROM valuations WHERE id = $1',
        [id],
      )
    ).rows[0]!;

  async function newValuation(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().valuation.id as string;
  }

  const retire = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/retire`,
      headers: authHeader(admin.token),
      payload: {},
    });

  const restore = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(admin.token),
      payload: {},
    });

  it('moves the version when retirement renames the engagement', async () => {
    const id = await newValuation('Counter Retire Co');
    const before = await row(id);

    const res = await retire(id);
    expect(res.statusCode, res.body).toBe(200);

    const after = await row(id);
    expect(after.company_name).not.toBe(before.company_name);
    expect(after.version).toBe(before.version + 1);
  });

  it('moves the version when restore takes the suffix back off', async () => {
    const id = await newValuation('Counter Restore Co');
    expect((await retire(id)).statusCode).toBe(200);
    const retired = await row(id);

    const res = await restore(id);
    expect(res.statusCode, res.body).toBe(200);

    const after = await row(id);
    expect(after.company_name).toBe('Counter Restore Co');
    expect(after.version).toBe(retired.version + 1);
  });

  /**
   * The property the counter exists for, end to end: an editor who read the row
   * while it was retired must not be able to save against it once it is live
   * again — their copy of the name is the one this restore just replaced.
   */
  it('refuses a save made from a copy read before the restore', async () => {
    const id = await newValuation('Counter Stale Co');
    expect((await retire(id)).statusCode).toBe(200);

    // Reads stay open on a retired engagement, which is how the analyst comes
    // to be holding this version at all.
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(admin.token),
    });
    expect(read.statusCode, read.body).toBe(200);
    const held = read.headers.etag as string;
    expect(read.json().valuation.company_name).toMatch(/\[retired\]$/);

    expect((await restore(id)).statusCode).toBe(200);

    const save = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: { ...authHeader(admin.token), 'if-match': held },
      payload: { delivery_days: 10 },
    });
    expect(save.statusCode, save.body).toBe(409);
    expect(save.json().detail).toMatch(/changed by someone else/i);

    // …and the same save from a fresh read still goes through, so the refusal
    // above is the stale copy and not the restore having broken writes.
    const fresh = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(admin.token),
    });
    const retry = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: { ...authHeader(admin.token), 'if-match': fresh.headers.etag as string },
      payload: { delivery_days: 10 },
    });
    expect(retry.statusCode, retry.body).toBe(200);
  });
});
