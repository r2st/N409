import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  boardResolutionHead,
  findResolutionByValuation,
  findResolutionHeadsByValuationIds,
  upsertResolution,
} from '../../src/repos/boardApprovals.js';
import { createValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * ASSERTED AS A DIFFERENCE (R398, methodology M8).
 *
 * The narrowing changes no answer — `assembleSnapshot` reads `valuation_date`
 * and the head carries it — so an assertion on what comes back cannot see it,
 * the same blindness R322's `not.toHaveProperty` and R393's params guard had.
 * What moved is what crosses the wire: grow the three text columns and the
 * bytes this statement returns must not move, where against the pre-fix
 * `SELECT *` they grow by the whole document.
 */
describe.skipIf(!dbUp)('monitoring — the board-resolution head the snapshot reads', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  const ids: string[] = [];
  let ownerId: string;

  async function writeResolution(id: string, prose: string): Promise<void> {
    await upsertResolution(
      pool,
      {
        valuationId: id,
        valuationDate: '2026-01-15',
        fmvConclusion: 1.25,
        currency: 'USD',
        methodologySummary: prose,
        appraiserQualifications: prose,
        bodyHtml: `<h1>Resolution</h1><p>${prose}</p>`,
        createdBy: ownerId,
      },
      { actorType: 'human', actorId: ownerId },
    );
  }

  /** Bytes the head statement brings back, whatever is on the rows. */
  async function bytesRead(): Promise<number> {
    let total = 0;
    const original = pool.query.bind(pool);
    (pool as unknown as { query: (...a: unknown[]) => unknown }).query = async (...args: unknown[]) => {
      const first = args[0];
      const sql = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      const result = (await (original as (...a: unknown[]) => unknown)(...args)) as { rows?: unknown[] };
      if (/FROM board_resolutions/i.test(sql)) {
        total += Buffer.byteLength(JSON.stringify(result?.rows ?? []));
      }
      return result;
    };
    try {
      await findResolutionHeadsByValuationIds(pool, ids);
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
    return total;
  }

  beforeAll(async () => {
    ctx = await setupTestApp();
    pool = ctx.pool;
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    ownerId = owner.id;
    for (let i = 0; i < 3; i += 1) {
      const v = await createValuation(
        pool,
        { kind: '409a', companyName: `Resolution Co ${i}`, userId: ownerId },
        { actorType: 'human', actorId: ownerId },
      );
      ids.push(v.id);
      await writeResolution(v.id, 'A short methodology.');
    }
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('agrees with the row it narrows, the date column included', async () => {
    const heads = await findResolutionHeadsByValuationIds(pool, ids);
    expect(heads.size).toBe(ids.length);
    for (const id of ids) {
      const full = await findResolutionByValuation(pool, id);
      expect(heads.get(id)?.valuation_date).toBe(full!.valuation_date);
      // The `date` column read locally, not `toISOString`d off midnight-local.
      expect(heads.get(id)?.valuation_date).toBe('2026-01-15');
      expect(boardResolutionHead(full!)).toEqual(heads.get(id));
    }
  });

  it('does not read the three text columns beside the date', async () => {
    const before = await bytesRead();
    // `methodology_summary` at the 4,000-character cap the route enforces, and
    // `body_html` carrying it a second time — the ordinary shape of a real row.
    const long = 'M'.repeat(4000);
    for (const id of ids) await writeResolution(id, long);
    expect(await bytesRead()).toBe(before);

    // Not vacuous: the documents really are on the rows now.
    const wide = await findResolutionByValuation(pool, ids[0]!);
    expect(wide!.methodology_summary.length).toBe(4000);
    expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThan(before * 3);
  });

  it('short-circuits on an empty id list and deduplicates repeated ones', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      expect((await findResolutionHeadsByValuationIds(pool, [])).size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const id = ids[0]!;
    expect((await findResolutionHeadsByValuationIds(pool, [id, id, id])).size).toBe(1);
  });
});
