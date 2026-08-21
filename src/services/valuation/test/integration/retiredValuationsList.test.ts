import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

/**
 * Finding a withdrawn engagement in order to put it back.
 *
 * R90 gave retirement a reversal and hung the control off the retention audit
 * log, beside the `archived` entry it undoes. That is a history: newest first,
 * capped at two hundred by the API and fifty by the page. One Sunday sweep
 * archiving forty engagements pushes last week's withdrawal past the end of
 * it, and the only route back goes with it — invisibly, because a truncated
 * list is indistinguishable from a complete one.
 *
 * So state gets its own read, and the properties worth pinning are the ones
 * that make it a *state* rather than another history: it is derived from
 * `archived_at` and not from what the sweep recorded, so a row the log has
 * forgotten is still on it; a restored engagement leaves it immediately; and
 * it says how many matched, because "50 of 214" and "50" look the same to
 * whoever is scrolling.
 */
describe.skipIf(!dbUp)('the list of withdrawn engagements', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let plainUser: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    plainUser = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const make = async (company: string): Promise<string> =>
    (
      await createValuation(
        ctx.pool,
        { kind: '409a', companyName: company, userId: admin.id },
        { ...actor, actorId: admin.id },
      )
    ).id;

  const list = (query = '', token = admin.token) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/retention/valuations/retired${query}`,
      headers: authHeader(token),
    });

  const retireVia = (id: string, reason?: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/retire`,
      headers: authHeader(admin.token),
      payload: reason === undefined ? {} : { reason },
    });

  it('lists a withdrawn engagement by name, with the reason it was withdrawn', async () => {
    const id = await make('Halcyon Retired Co');
    expect((await retireVia(id, 'client withdrew the engagement')).statusCode).toBe(200);

    const body = (await list('?q=Halcyon')).json();
    const row = body.valuations.find((v: { id: string }) => v.id === id);
    expect(row).toBeTruthy();
    // The name carries the suffix `retireValuations` appends, which is what an
    // admin will actually see on the row.
    expect(row.company_name).toContain('Halcyon Retired Co');
    expect(row.retired_reason).toBe('client withdrew the engagement');
    expect(row.retired_manually).toBe(true);
    expect(row.archived_at).toBeTruthy();
  });

  it('is derived from the engagement, not from what the sweep recorded', async () => {
    // The whole point of the endpoint. `retireValuations` archives without
    // writing a retention_actions row — that is what the seeder and the older
    // sweeps did — so a row the log never knew about must still be here, with
    // a null reason rather than an absence.
    const id = await make('Unlogged Withdrawal Co');
    await retireValuations(ctx.pool, [id]);

    const row = (await list('?q=Unlogged')).json().valuations.find((v: { id: string }) => v.id === id);
    expect(row).toBeTruthy();
    expect(row.retired_reason).toBeNull();
    expect(row.retired_manually).toBe(false);
  });

  it('leaves it the moment the engagement is restored', async () => {
    const id = await make('Boomerang Co');
    await retireVia(id);
    expect((await list('?q=Boomerang')).json().valuations.map((v: { id: string }) => v.id)).toContain(id);

    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(admin.token),
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect((await list('?q=Boomerang')).json().valuations.map((v: { id: string }) => v.id)).not.toContain(id);
  });

  it('never lists a live engagement — the vacuity guard', async () => {
    // Everything above asserts a row is present. All of it would pass against
    // an endpoint that listed every valuation there is.
    const live = await make('Still Working Co');
    const body = (await list('?q=Still Working')).json();
    expect(body.valuations.map((v: { id: string }) => v.id)).not.toContain(live);
    expect(body.total).toBe(0);
  });

  it('finds one by exact id, for the case where the name has been reused', async () => {
    const id = await make('Ambiguous Co');
    await retireVia(id);
    const body = (await list(`?q=${id}`)).json();
    expect(body.valuations.map((v: { id: string }) => v.id)).toEqual([id]);
  });

  it('says how many matched, not just how many it returned', async () => {
    for (const n of [1, 2, 3]) await retireVia(await make(`Countable ${n} Co`));
    const body = (await list('?q=Countable&limit=2')).json();
    expect(body.valuations).toHaveLength(2);
    // The number that stops "showing 2" from reading as "there are 2".
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
  });

  it('treats a wildcard in the query as text, not as a wildcard', async () => {
    // `%` in a company name would otherwise widen the search silently — and
    // silently is the problem: it returns more rows and looks like it worked.
    await retireVia(await make('Percent Co'));
    expect((await list('?q=%')).json().total).toBe(0);
  });

  it('is admin-only — it names withdrawn client work', async () => {
    expect((await list('', plainUser.token)).statusCode).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/retention/valuations/retired' })).statusCode,
    ).toBe(401);
  });

  it('refuses a limit it cannot serve rather than clamping it', async () => {
    expect((await list('?limit=0')).statusCode).toBe(400);
    expect((await list('?limit=9999')).statusCode).toBe(400);
  });
});
