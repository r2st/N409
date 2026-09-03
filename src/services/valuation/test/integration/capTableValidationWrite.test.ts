import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { validateCapTable, type CapTableEntry } from '../../src/domain/capTable.js';
import { saveCapTable } from '../../src/repos/capTables.js';
import { createValuation } from '../../src/repos/valuations.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * The write half of the column nobody reads (R402, methodology M8).
 *
 * R393 established that no reader selects `cap_tables.validation` —
 * `withFreshValidation` replaces it on every read — and narrowed both readers.
 * `capTableValidationColumn.test.ts` is that guard. This is the other half: the
 * blob was still *produced* on every save, serialised here, parsed into `jsonb`
 * by the server, written to the row and its TOAST table, journalled, and handed
 * straight back by `RETURNING *` to be discarded.
 *
 * THE ANSWER DOES NOT MOVE, so nothing about the response can see this — the
 * same blindness R322's `not.toHaveProperty` and R385's over-walk had. Both
 * assertions below are therefore on the *work*, stated as a difference: make the
 * validation document two thousand times larger and neither the bytes the
 * statement sends nor the bytes it brings back may move. Against the pre-fix
 * statement both move by hundreds of kilobytes.
 *
 * The third assertion is the discriminator in the other direction. A save that
 * simply stopped answering with a validation would pass both byte assertions and
 * be a different defect, so the returned row must still carry the derivation a
 * subsequent `findCapTable` would give.
 */
function entries(n: number, price: 1.25 | null): CapTableEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    security_class: `Series ${i}`,
    class_type: i === 0 ? 'common' : 'preferred',
    shares: 100_000 + i,
    // `1.25` and `null` are the same four characters of JSON, so the two shapes
    // below serialise to byte-identical `entries` and the validation document is
    // the only thing that can move the count.
    price_per_share: price,
    invested_amount: null,
    liquidation_multiple: 1,
    participating: false,
    participation_cap: null,
    conversion_ratio: 1,
    seniority: (i % 5) + 1,
    holder: `Holder ${i}`,
    source_row: i + 2,
  })) as unknown as CapTableEntry[];
}

/**
 * Bytes one `cap_tables` write sends as parameters, and brings back as rows.
 *
 * Patched on `pool.connect`, not on `pool.query`: `saveCapTable` runs inside
 * `withTransaction`, so the statement is issued on a checked-out client and a
 * tap on the pool never sees it — it reports zero for both shapes and passes
 * over the defect. Verified against the pre-fix source.
 */
function tap(pool: pg.Pool): { sent: () => number; back: () => number; restore: () => void } {
  let sent = 0;
  let back = 0;
  const connect = pool.connect.bind(pool);
  (pool as unknown as { connect: unknown }).connect = async (...a: unknown[]) => {
    const client = (await (connect as (...x: unknown[]) => unknown)(...a)) as {
      query: (...x: unknown[]) => unknown;
    };
    const original = client.query.bind(client);
    client.query = async (...args: unknown[]) => {
      const first = args[0];
      const sql = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      const params = (Array.isArray(args[1]) ? args[1] : (first as { values?: unknown[] })?.values) ?? [];
      const result = (await original(...args)) as { rows?: unknown[] };
      if (/INSERT INTO cap_tables/i.test(sql)) {
        sent += Buffer.byteLength(JSON.stringify(params));
        back += Buffer.byteLength(JSON.stringify(result?.rows ?? []));
      }
      return result;
    };
    return client;
  };
  return {
    sent: () => sent,
    back: () => back,
    restore: () => ((pool as unknown as { connect: unknown }).connect = connect),
  };
}

describe.skipIf(!dbUp)('cap-table writes do not store the column nobody reads (R402, M8)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newValuation(): Promise<string> {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'CapTableCo', userId: ops.id, partnerId: null },
      { ...actor, actorId: ops.id },
    );
    return v.id;
  }

  async function save(valuationId: string, rows: CapTableEntry[]) {
    return saveCapTable(
      ctx.pool,
      {
        valuationId,
        sourceFormat: 'generic',
        entries: rows,
        validation: validateCapTable(rows),
        columnMapping: { shares: 'Shares' },
        createdBy: ops.id,
      },
      { ...actor, actorId: ops.id },
    );
  }

  it('leaves the stored column at the empty document its DDL defaults to', async () => {
    const id = await newValuation();
    // Every preferred row with no price raises `no_investment`, which is the
    // ordinary shape of an imported share register and is a *warning* — so this
    // table is valid, saveable, and carries one issue per row.
    const rows = entries(400, null);
    const saved = await save(id, rows);
    expect(saved.validation.issues.length).toBeGreaterThan(300);

    const { rows: stored } = await ctx.pool.query<{ validation: unknown }>(
      'SELECT validation FROM cap_tables WHERE valuation_id = $1',
      [id],
    );
    expect(stored[0]!.validation).toEqual({});

    // And a re-save reclaims a blob a previous release left behind.
    await ctx.pool.query(
      `UPDATE cap_tables SET validation = $2::jsonb WHERE valuation_id = $1`,
      [id, JSON.stringify({ valid: true, issues: [{ code: 'stale_cache', message: 'x'.repeat(1000) }] })],
    );
    await save(id, rows);
    const { rows: again } = await ctx.pool.query<{ validation: unknown }>(
      'SELECT validation FROM cap_tables WHERE valuation_id = $1',
      [id],
    );
    expect(again[0]!.validation).toEqual({});
  });

  it('neither sends nor returns the validation document, however large it is', async () => {
    // Same row count either way, so `entries` is byte-for-byte comparable and
    // the validation document is the only thing that differs.
    const shallow = entries(400, 1.25); // priced: nothing per row to say
    const deep = entries(400, null); // unpriced: `no_investment` on every row

    expect(validateCapTable(deep).issues.length).toBeGreaterThan(
      validateCapTable(shallow).issues.length * 100,
    );

    const measure = async (rows: CapTableEntry[]) => {
      const id = await newValuation();
      const t = tap(ctx.pool);
      try {
        await save(id, rows);
        return { sent: t.sent(), back: t.back() };
      } finally {
        t.restore();
      }
    };

    const a = await measure(shallow);
    const b = await measure(deep);
    // Identical entry counts, so the only thing that differs is the validation
    // document. Nothing about the statement may notice.
    expect(b.sent).toBe(a.sent);
    expect(b.back).toBe(a.back);
  });

  it('still answers with the validation a later read would derive', async () => {
    const id = await newValuation();
    const rows = entries(12, null);
    const saved = await save(id, rows);
    const fresh = validateCapTable(rows);
    expect(saved.validation).toEqual(fresh);
    expect(saved.validation.summary.class_count).toBe(12);
    expect(saved.validation.valid).toBe(true);
  });
});
