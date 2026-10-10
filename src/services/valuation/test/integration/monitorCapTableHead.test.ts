import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type * as CapTableModule from '../../src/domain/capTable.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * THE COUNTER IS THE GUARD, and it has to be installed before the repo module
 * that calls the function is loaded (R398, methodology M8).
 *
 * The narrowing this pins changes no answer — the head's `fully_diluted_shares`
 * is by construction the number the wide reader's summary carries — so an
 * assertion on what comes back cannot see it, the same blindness R322's
 * `not.toHaveProperty` and R385's over-walk had. What moved is the *work*:
 * `validateCapTable` runs every per-entry rule and builds one issue object with
 * a prose message per finding, once per monitored valuation, for a scan that
 * pages 500 at a time. So the assertion is on how many times it is called.
 *
 * `validateCapTable` is left as the real function rather than stubbed, because
 * the parity tests below read its summary and a stub would make them vacuous.
 */
const validateCalls = { count: 0 };
vi.mock('../../src/domain/capTable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CapTableModule>();
  return {
    ...actual,
    validateCapTable: (...args: Parameters<typeof actual.validateCapTable>) => {
      validateCalls.count += 1;
      return actual.validateCapTable(...args);
    },
  };
});

const { validateCapTable } = await import('../../src/domain/capTable.js');
const { capTableHead, findCapTable, findCapTableHeadsByValuationIds, findCapTablesByValuationIds, saveCapTable } =
  await import('../../src/repos/capTables.js');
const { createValuation } = await import('../../src/repos/valuations.js');

const dbUp = await isDbAvailable();

type Entry = Parameters<typeof validateCapTable>[0][number];

/**
 * Entries chosen for the arms `asConvertedShares` actually branches on, since
 * the head computes the sum by a different route than the summary does: a
 * preferred class converting at a ratio above 1, one whose ratio is absent, one
 * whose ratio is non-positive (a broken row that counts 1:1 rather than
 * vanishing), common and options which do not convert at all, and a share count
 * that arrives from JSON as a string.
 */
function entries(seed: number): Entry[] {
  return [
    { security_class: `Common ${seed}`, class_type: 'common', shares: 4_000_000 + seed, price_per_share: null, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
    { security_class: `Series A ${seed}`, class_type: 'preferred', shares: 1_000_000, price_per_share: 1.5, invested_amount: null, liquidation_multiple: null, seniority: 1, conversion_ratio: 2 },
    { security_class: `Series B ${seed}`, class_type: 'preferred', shares: 500_000, price_per_share: 3, invested_amount: 1_500_000, liquidation_multiple: 1, seniority: 2, conversion_ratio: null },
    { security_class: `Series C ${seed}`, class_type: 'preferred', shares: 250_000, price_per_share: 4, invested_amount: null, liquidation_multiple: null, seniority: 3, conversion_ratio: 0 },
    { security_class: `Options ${seed}`, class_type: 'option', shares: 750_000, price_per_share: null, invested_amount: null, liquidation_multiple: null, seniority: null, conversion_ratio: null },
  ] as Entry[];
}

describe.skipIf(!dbUp)('monitoring — the cap-table head the snapshot reads', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  const ids: string[] = [];

  beforeAll(async () => {
    ctx = await setupTestApp();
    pool = ctx.pool;
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    for (let i = 0; i < 3; i += 1) {
      const v = await createValuation(
        pool,
        { kind: '409a', companyName: `Head Co ${i}`, userId: owner.id },
        { actorType: 'human', actorId: owner.id },
      );
      ids.push(v.id);
      await saveCapTable(
        pool,
        {
          valuationId: v.id,
          sourceFormat: 'manual',
          entries: entries(i),
          validation: validateCapTable(entries(i)),
          columnMapping: {},
          createdBy: owner.id,
        },
        { actorType: 'human', actorId: owner.id },
      );
    }
    validateCalls.count = 0;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('does not re-derive the validation it does not read', async () => {
    validateCalls.count = 0;
    const heads = await findCapTableHeadsByValuationIds(pool, ids);
    expect(heads.size).toBe(ids.length);
    expect(validateCalls.count).toBe(0);

    // Not vacuous: the reader this replaced re-derives it once per row, so the
    // zero above is the difference and not an absence of cap tables.
    validateCalls.count = 0;
    const wide = await findCapTablesByValuationIds(pool, ids);
    expect(wide.size).toBe(ids.length);
    expect(validateCalls.count).toBe(ids.length);
  });

  it('agrees with the summary of the row it narrows', async () => {
    const heads = await findCapTableHeadsByValuationIds(pool, ids);
    for (const id of ids) {
      const full = await findCapTable(pool, id);
      expect(heads.get(id)?.fully_diluted_shares).toBe(full!.validation.summary.fully_diluted_shares);
      expect(heads.get(id)?.updated_at).toEqual(full!.updated_at);
      expect(heads.get(id)?.valuation_id).toBe(id);
      // And the one-valuation path narrows to the same thing.
      expect(capTableHead(full!)).toEqual(heads.get(id));
    }
  });

  it('does not read the columns the two facts do not come from', async () => {
    const seen: string[] = [];
    const original = pool.query.bind(pool);
    (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      const sql = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      if (/FROM cap_tables/i.test(sql)) seen.push(sql);
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await findCapTableHeadsByValuationIds(pool, ids);
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
    expect(seen).toHaveLength(1);
    // The stored `validation` blob above all — it holds one prose message per
    // finding and every read of it was overwritten by the re-derivation.
    expect(seen[0]).not.toMatch(/\bvalidation\b/);
    expect(seen[0]).not.toMatch(/column_mapping/);
    expect(seen[0]).toMatch(/\bentries\b/);
  });

  it('short-circuits on an empty id list and deduplicates repeated ones', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      expect((await findCapTableHeadsByValuationIds(pool, [])).size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const id = ids[0]!;
    expect((await findCapTableHeadsByValuationIds(pool, [id, id, id])).size).toBe(1);
  });
});
