import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { findValuationById, PATCHABLE_COLUMNS, patchValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * R274. `patchValuation` interpolates each key of its `fields` argument into
 * the UPDATE's SET clause, and the set of keys it accepted was
 * `Object.keys(fields)` — whatever the caller passed. Nothing reachable put an
 * unvetted key there: the routes build the object by hand or hand over a
 * `.strict()` Zod result. But `repos/communications.ts` had already written
 * down why that is not the same thing as being safe — it is a property of the
 * call sites, not of the function, and the type annotation is erased — and
 * every sibling repo that builds an UPDATE this way names its columns in the
 * repo. This one, with a public API PATCH in front of it, did not.
 *
 * Two halves, and the second is the one that keeps the first honest: an
 * allow-list is only as good as its agreement with the table, and a column
 * missing from it is a write that stops working rather than a write that is
 * refused.
 */
describe.skipIf(!dbUp)('patchValuation names its columns', () => {
  let ctx: TestApp;
  let owner: { id: string; token: string };
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Patch Columns Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  it('lists only columns the table actually has', async () => {
    const { rows } = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'valuations'`,
    );
    const actual = new Set(rows.map((r) => r.column_name));
    expect([...PATCHABLE_COLUMNS].filter((c) => !actual.has(c))).toEqual([]);
  });

  it('refuses a key that is not one of them, before any statement runs', async () => {
    const before = (await findValuationById(ctx.pool, valuationId))!;
    await expect(
      patchValuation(
        ctx.pool,
        before,
        // The shape the guard exists for: a column name arriving as data. A
        // key carrying its own SQL is the same input one step further on.
        { company_name: 'Renamed', 'version = 0, company_name': 'x' },
        { actorType: 'system', source: 'test' },
      ),
    ).rejects.toThrow(/not a patchable column/);

    // And nothing was written: the refusal is before the transaction, so the
    // legitimate half of the patch did not land either.
    const after = (await findValuationById(ctx.pool, valuationId))!;
    expect(after.company_name).toBe(before.company_name);
    expect(after.version).toBe(before.version);
  });

  it('still writes the columns it does name', async () => {
    const before = (await findValuationById(ctx.pool, valuationId))!;
    const updated = await patchValuation(
      ctx.pool,
      before,
      { company_name: 'Patch Columns Co (renamed)', waiting_on_client: true },
      { actorType: 'system', source: 'test' },
    );
    expect(updated.company_name).toBe('Patch Columns Co (renamed)');
    expect(updated.waiting_on_client).toBe(true);
    expect(updated.version).toBe(before.version + 1);
  });
});
