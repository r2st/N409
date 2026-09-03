import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { createValuation } from '../../src/repos/valuations.js';
import { findCapTable, findCapTablesByValuationIds } from '../../src/repos/capTables.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * The stored `validation` column is never the answer, so it is never read.
 *
 * `withFreshValidation` re-derives it from `entries` on every read — the column
 * is a cache of a pure function and it goes stale whenever a rule changes, which
 * is the argument written out at its definition. Both readers were `SELECT *`,
 * so the stored blob crossed the wire and went through the driver's
 * `JSON.parse` on every read, to be overwritten by the next expression.
 *
 * It is not a small blob: one issue object with a prose message per finding, and
 * `default_liq_pref` fires for every preferred row that states no explicit
 * multiple, which is the ordinary shape of an imported sheet.
 *
 * TWO ASSERTIONS, AND THE SECOND IS THE DISCRIMINATOR. The first pins the
 * behaviour — a deliberately wrong stored blob must not reach a caller — and it
 * passed before this change as well, which is exactly why it cannot be the whole
 * guard. The second is the bytes the statement returns, stated as a difference:
 * poison the stored column with a megabyte and what the reader parses must not
 * move. Against the pre-fix `SELECT *` it does.
 */
const HOLDERS = 40;

function entries(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    security_class: `Series ${i}`,
    class_type: i % 2 === 0 ? 'common' : 'preferred',
    shares: 100_000 + i,
    price_per_share: 1.25,
    invested_amount: null,
    liquidation_multiple: null,
    participating: false,
    participation_cap: null,
    conversion_ratio: 1,
    seniority: (i % 5) + 1,
    holder: `Holder ${i}`,
    source_row: i + 2,
  }));
}

/** A stored `validation` that is both wrong and large. */
function poison(issues: number): Record<string, unknown> {
  return {
    valid: true,
    summary: {
      total_shares: -1,
      common_shares: -1,
      preferred_shares: -1,
      option_shares: -1,
      warrant_shares: -1,
      fully_diluted_shares: -1,
      total_preference_stack: -1,
      class_count: -1,
    },
    issues: Array.from({ length: issues }, (_, i) => ({
      severity: 'warning',
      code: 'stale_cache',
      message: `stale issue ${i} `.padEnd(200, 'x'),
    })),
  };
}

/** Bytes the next `cap_tables` read hands back, whatever shape it has. */
function tap(pool: pg.Pool): { bytes: () => number; restore: () => void } {
  let total = 0;
  const original = pool.query.bind(pool);
  (pool as unknown as { query: (...a: unknown[]) => unknown }).query = async (...args: unknown[]) => {
    const first = args[0];
    const sql = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const result = (await (original as (...a: unknown[]) => unknown)(...args)) as { rows?: unknown[] };
    if (/FROM cap_tables/i.test(sql)) total += Buffer.byteLength(JSON.stringify(result?.rows ?? []));
    return result;
  };
  return { bytes: () => total, restore: () => ((pool as unknown as { query: unknown }).query = original) };
}

describe.skipIf(!dbUp)('cap-table reads skip the column they overwrite (R393, M8)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedTable(issues: number): Promise<string> {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'CapTableCo', userId: ops.id, partnerId: null },
      { ...actor, actorId: ops.id },
    );
    await ctx.pool.query(
      `INSERT INTO cap_tables (id, valuation_id, source_format, entries, validation, column_mapping, created_by)
       VALUES ($1, $2, 'generic', $3, $4, $5, $6)`,
      [
        newUlid(),
        v.id,
        JSON.stringify(entries(HOLDERS)),
        JSON.stringify(poison(issues)),
        JSON.stringify({ shares: 'Shares' }),
        ops.id,
      ],
    );
    return v.id;
  }

  it('re-derives the validation rather than returning the stored one', async () => {
    const id = await seedTable(5);
    const row = await findCapTable(ctx.pool, id);
    expect(row).not.toBeNull();
    expect(row!.validation.summary.class_count).toBe(HOLDERS);
    expect(row!.validation.summary.fully_diluted_shares).toBeGreaterThan(0);
    expect(row!.validation.issues.some((i) => i.code === 'stale_cache')).toBe(false);
    // The batch reader is the same rule.
    const batch = await findCapTablesByValuationIds(ctx.pool, [id]);
    expect(batch.get(id)!.validation.summary.class_count).toBe(HOLDERS);
  });

  it('does not read what it overwrites', async () => {
    const small = await seedTable(1);
    const large = await seedTable(2_000);

    const measure = async (ids: string[]) => {
      const t = tap(ctx.pool);
      try {
        await findCapTablesByValuationIds(ctx.pool, ids);
        await findCapTable(ctx.pool, ids[0]!);
        return t.bytes();
      } finally {
        t.restore();
      }
    };

    const withSmall = await measure([small]);
    const withLarge = await measure([large]);
    // The stored blobs differ by three orders of magnitude in issue count; what
    // the reader parses is the same table either way.
    expect(withLarge).toBe(withSmall);
  });
});
