import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiProblem } from '@n409/shared';
import { findParams, patchParams, type ValuationParamsRow } from '../../src/repos/params.js';
import { checkParamInvariants } from '../../src/routes/params.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Two analysts editing one engagement's methodology at the same time.
 *
 * `PATCH /valuations/:id/params` read the row, merged the patch over it,
 * checked the merged result against the invariants the table also enforces —
 * the four approach weights sum to 1, and a row carries `dlom_method` or
 * `dlom_methods` but never both — and then wrote the fields that differed.
 * Every step happened outside the write transaction, and the UPDATE carried no
 * condition beyond the primary key.
 *
 * That is safe for one editor and wrong for two, because each validates
 * against the row *as they read it*. Two patches that are individually legal
 * compose into a row that is not, and the check constraint is the only thing
 * left standing between that and a stored valuation — a constraint firing
 * inside a repo nothing catches, which is a 500 telling the analyst who lost
 * the race nothing at all.
 *
 * The race is expressed here by handing two writers the same snapshot rather
 * than by racing two requests, because the interleaving that matters is "both
 * read before either wrote" and a `Promise.all` of two injects reproduces it
 * only sometimes. Two `patchParams` calls sharing one `current` reproduce it
 * every time, and are exactly what those two requests amount to.
 */
describe.skipIf(!dbUp)('valuation params under concurrent edits', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newValuation(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  const patchRoute = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/params`,
      headers: authHeader(ops.token),
      payload,
    });

  const actor = () => ({ actorType: 'human' as const, actorId: ops.id, source: 'api' });

  /** What the route does: patch the row, re-checking the rules under the lock. */
  const save = (current: ValuationParamsRow, fields: Record<string, unknown>) =>
    patchParams(ctx.pool, current, fields, actor(), {
      revalidate: (fresh) => checkParamInvariants(fresh, fields),
    });

  /** The status of a rejected save, or 500 for anything that is not a problem. */
  function rejectedStatus(outcome: PromiseSettledResult<unknown>): number | null {
    if (outcome.status === 'fulfilled') return null;
    return outcome.reason instanceof ApiProblem ? outcome.reason.status : 500;
  }

  it('never leaves the four approach weights summing to anything but 1', async () => {
    const id = await newValuation();
    expect(
      (await patchRoute(id, { weight_asset: 0.25, weight_opm: 0.25, weight_income: 0.25, weight_market: 0.25 }))
        .statusCode,
    ).toBe(200);

    // One row, read once, handed to both writers — two analysts who opened the
    // methodology form at the same moment.
    const snapshot = (await findParams(ctx.pool, id))!;

    // Each patch moves 0.25 from one approach to another and so is legal on the
    // row both of them read. They overlap on `weight_opm`, which is what makes
    // the pair unsafe: applied one after the other, the second takes opm up
    // while keeping the first's move, and the row lands at 1.25.
    const settled = await Promise.allSettled([
      save(snapshot, { weight_asset: 0.5, weight_opm: 0 }),
      save(snapshot, { weight_opm: 0.5, weight_market: 0 }),
    ]);

    const row = (await findParams(ctx.pool, id))!;
    const bps = [row.weight_asset, row.weight_opm, row.weight_income, row.weight_market].reduce(
      (acc, w) => acc + Math.round(Number(w) * 10000),
      0,
    );
    expect(bps).toBe(10000);

    // One save landed; the loser was told which rule it broke, as a 422 — not
    // as a check-constraint 500 with nothing in it for the analyst.
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((s) => s.status === 'rejected')!;
    expect(rejectedStatus(loser)).toBe(422);
    expect((loser as PromiseRejectedResult).reason.detail).toMatch(/weights must sum to 1/i);
  });

  it('never leaves a row carrying both a DLOM method and a DLOM blend', async () => {
    const id = await newValuation();
    const snapshot = (await findParams(ctx.pool, id))!;

    const settled = await Promise.allSettled([
      save(snapshot, { dlom_method: 'qualitative', dlom_qualitative: 0.2 }),
      save(snapshot, {
        dlom_methods: [
          { method: 'finnerty', weight: 0.5 },
          { method: 'chaffee', weight: 0.5 },
        ],
      }),
    ]);

    // The table's `valuation_params_one_dlom_form` says one or the other: a row
    // with both has two answers to "which discount was concluded", and
    // whichever the engine read would be the one nobody meant.
    const row = (await findParams(ctx.pool, id))!;
    expect(row.dlom_method === null || row.dlom_methods === null).toBe(true);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(rejectedStatus(settled.find((s) => s.status === 'rejected')!)).toBe(422);
  });

  it('applies a patch to the row as it stands, not as the caller last saw it', async () => {
    const id = await newValuation();
    const snapshot = (await findParams(ctx.pool, id))!;

    // Somebody else saves 18 while this editor still holds a snapshot of null.
    await save(snapshot, { runway_months: 18 });
    // This editor now saves 12. Diffed against their stale snapshot the change
    // is real either way; diffed against a snapshot that happened to already
    // hold 12 it would have been dropped as a no-op, and the analyst would be
    // looking at a saved form holding a figure nobody stored.
    const after = await save({ ...snapshot, runway_months: 12 }, { runway_months: 12 });
    expect(after.runway_months).toBe(12);
    expect((await findParams(ctx.pool, id))!.runway_months).toBe(12);
  });

  it('records one params_updated event per write, each reporting a prior value that was real', async () => {
    const id = await newValuation();
    const snapshot = (await findParams(ctx.pool, id))!;

    const settled = await Promise.allSettled(
      [12, 18, 24].map((runway_months) => save(snapshot, { runway_months })),
    );
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);

    const { rows } = await ctx.pool.query<{
      payload: { changes: Record<string, { from: unknown; to: unknown }> };
    }>(
      `SELECT payload FROM valuation_events
       WHERE valuation_id = $1 AND type = 'params_updated'
       ORDER BY seq`,
      [id],
    );
    expect(rows).toHaveLength(3);

    // Every `from` is a value some earlier write actually left behind...
    const written = new Set<unknown>([null, 12, 18, 24]);
    for (const r of rows) expect(written).toContain(r.payload.changes.runway_months!.from);
    expect(rows.map((r) => r.payload.changes.runway_months!.to).sort()).toEqual([12, 18, 24]);
    // ...and only the first write found the column empty. Read off the caller's
    // snapshot all three claimed to be the one that set it, which is a trail
    // that cannot be reconciled with a column holding a single value.
    expect(rows.filter((r) => r.payload.changes.runway_months!.from === null)).toHaveLength(1);
  });

  it('answers concurrent PATCHes of one engagement without a 500', async () => {
    const id = await newValuation();
    const responses = await Promise.all([
      patchRoute(id, { weight_asset: 1, weight_opm: 0, weight_income: 0, weight_market: 0 }),
      patchRoute(id, { weight_asset: 0, weight_opm: 1, weight_income: 0, weight_market: 0 }),
      patchRoute(id, { dlom_method: 'chaffee' }),
      patchRoute(id, { business_overview: 'A robotics company.' }),
    ]);
    for (const res of responses) {
      expect(res.statusCode).not.toBe(500);
      expect([200, 422]).toContain(res.statusCode);
    }
  });

  it('leaves a single editor exactly where they were', async () => {
    const id = await newValuation();
    // No concurrency at all: the locked-row re-check must be invisible.
    expect((await patchRoute(id, { runway_months: 9 })).statusCode).toBe(200);
    expect((await patchRoute(id, { weight_asset: 1, weight_opm: 0, weight_income: 0, weight_market: 0 })).statusCode).toBe(200);
    // Still refused on its own merits, with the message it always had.
    const bad = await patchRoute(id, { weight_asset: 0.5 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toMatch(/weights must sum to 1/i);

    const row = (await findParams(ctx.pool, id))!;
    expect(row.runway_months).toBe(9);
    expect(Number(row.weight_asset)).toBe(1);
  });
});
