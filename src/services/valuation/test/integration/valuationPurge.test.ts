import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  findValuationIdsByCompanyName,
  retireValuations,
} from '../../src/repos/valuationPurge.js';
import {
  createValuation,
  findValuationById,
  listValuations,
  clearValuationCache,
} from '../../src/repos/valuations.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Retiring a valuation.
 *
 * The module this covers is the one place in the service that takes engagements
 * out of the product, and it had no test at all: a permanent-looking operation
 * driven by an id list from the command line, whose only safety rails are that
 * it archives rather than deletes and that it matches names exactly. Both of
 * those are properties worth pinning down, because both were arrived at after a
 * production run went wrong.
 */
describe.skipIf(!dbUp)('retireValuations', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    const user = await createUser(pool, {
      email: `purge-${newUlid().toLowerCase()}@test.example.com`,
      passwordDigest: await hashPassword('test-password-123'),
      roles: ['valuation_user'],
      partnerId: null,
    });
    userId = user.id;
  });
  afterAll(async () => {
    clearValuationCache();
    await db?.teardown();
  });

  const actor = () => ({ actorType: 'human' as const, actorId: userId, source: 'test' });

  async function newValuation(companyName: string): Promise<string> {
    const row = await createValuation(pool, { kind: '409a', companyName, userId }, actor());
    return row.id;
  }

  const rowOf = async (id: string) => {
    const { rows } = await pool.query<{ company_name: string; archived_at: Date | null }>(
      'SELECT company_name, archived_at FROM valuations WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  };

  it('archives and renames a live valuation', async () => {
    const id = await newValuation('Helios Dynamics, Inc.');

    const result = await retireValuations(pool, [id]);

    expect(result).toEqual({ retired: [id], missing: [], alreadyArchived: [] });
    const row = await rowOf(id);
    expect(row!.archived_at).toBeInstanceOf(Date);
    expect(row!.company_name).toBe('Helios Dynamics, Inc. [retired]');
  });

  it('does not delete the row or its append-only events', async () => {
    // The whole point of archiving: `valuation_events` carries a BEFORE DELETE
    // trigger that raises, so a hard delete cannot happen without disabling a
    // compliance control. The birth event must still be there afterwards.
    const id = await newValuation('Meridian Analytics Ltd');
    await retireValuations(pool, [id]);

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM valuation_events WHERE valuation_id = $1 AND type = 'valuation_created'",
      [id],
    );
    expect(rows[0]!.n).toBe(1);
    expect(await rowOf(id)).not.toBeNull();
  });

  it('is idempotent — a second run reports alreadyArchived and changes nothing', async () => {
    const id = await newValuation('Northwind Optics');
    await retireValuations(pool, [id]);
    const first = await rowOf(id);

    const again = await retireValuations(pool, [id]);

    expect(again).toEqual({ retired: [], missing: [], alreadyArchived: [id] });
    const second = await rowOf(id);
    // No "Name [retired] [retired]", and the original archive timestamp stands.
    expect(second!.company_name).toBe('Northwind Optics [retired]');
    expect(second!.archived_at!.getTime()).toBe(first!.archived_at!.getTime());
  });

  it('never double-suffixes even a name that already ends in the suffix', async () => {
    // Belt and braces for the CASE in the UPDATE: a company that genuinely
    // named itself this way is still only suffixed once.
    const id = await newValuation('Odd Choice [retired]');
    await retireValuations(pool, [id]);
    expect((await rowOf(id))!.company_name).toBe('Odd Choice [retired]');
  });

  it('reports ids that do not exist instead of failing the batch', async () => {
    const live = await newValuation('Pinnacle Foods Co.');
    const ghost = newUlid();

    const result = await retireValuations(pool, [live, ghost]);

    expect(result.retired).toEqual([live]);
    expect(result.missing).toEqual([ghost]);
    expect(result.alreadyArchived).toEqual([]);
  });

  it('classifies a mixed batch of live, archived and missing ids', async () => {
    const live = await newValuation('Quanta Systems');
    const archived = await newValuation('Rowan Biotech');
    await retireValuations(pool, [archived]);
    const ghost = newUlid();

    const result = await retireValuations(pool, [live, archived, ghost]);

    expect(result.retired).toEqual([live]);
    expect(result.alreadyArchived).toEqual([archived]);
    expect(result.missing).toEqual([ghost]);
  });

  it('deduplicates the requested ids', async () => {
    const id = await newValuation('Solstice Materials');
    const result = await retireValuations(pool, [id, id, id]);
    expect(result.retired).toEqual([id]);
  });

  it('short-circuits an empty request without touching the database', async () => {
    const result = await retireValuations(pool, []);
    expect(result).toEqual({ retired: [], missing: [], alreadyArchived: [] });
  });

  it('rolls back and archives nothing when an id is not a ULID', async () => {
    // `ANY($1::ulid[])` rejects the cast, inside the transaction, before the
    // UPDATE. The valid id in the same batch must survive untouched.
    const live = await newValuation('Tessellate Corp');

    await expect(retireValuations(pool, [live, 'not-a-ulid'])).rejects.toThrow();

    expect((await rowOf(live))!.archived_at).toBeNull();
    expect((await rowOf(live))!.company_name).toBe('Tessellate Corp');
  });

  it('takes the engagement out of every default list read', async () => {
    const id = await newValuation('Umbra Logistics');
    const scope = { kind: 'all' } as const;
    const filters = { page: 1, perPage: 50 } as const;

    const before = await listValuations(pool, scope, { ...filters });
    expect(before.items.map((v) => v.id)).toContain(id);

    await retireValuations(pool, [id]);

    const after = await listValuations(pool, scope, { ...filters });
    expect(after.items.map((v) => v.id)).not.toContain(id);
    // ...but it is still there for a caller that asks for archived work.
    const archived = await listValuations(pool, scope, { ...filters, includeArchived: true });
    expect(archived.items.map((v) => v.id)).toContain(id);
  });

  it('drops the cached row, so the archive is visible to the next read', async () => {
    // `repos/valuations.ts` caches `WHERE id = $1` reads, and is only correct
    // because every writer invalidates afterwards. This module is a writer.
    const id = await newValuation('Vertex Instruments');
    const cached = await findValuationById(pool, id);
    expect(cached!.archived_at).toBeNull();

    await retireValuations(pool, [id]);

    const fresh = await findValuationById(pool, id);
    expect(fresh!.archived_at).toBeInstanceOf(Date);
    expect(fresh!.company_name).toBe('Vertex Instruments [retired]');
  });

  it('frees the company name for a rebuild', async () => {
    // This is what makes the seeder's `--replace` work: archiving alone leaves
    // the name taken, so the next run would skip the very sample it was told to
    // rebuild.
    const original = await newValuation('Wavelength Robotics');
    await retireValuations(pool, [original]);

    const rebuilt = await newValuation('Wavelength Robotics');
    const found = await findValuationIdsByCompanyName(pool, ['Wavelength Robotics']);
    expect(found.map((r) => r.id)).toEqual([rebuilt]);
  });
});

describe.skipIf(!dbUp)('findValuationIdsByCompanyName', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    const user = await createUser(pool, {
      email: `find-${newUlid().toLowerCase()}@test.example.com`,
      passwordDigest: await hashPassword('test-password-123'),
      roles: ['valuation_user'],
      partnerId: null,
    });
    userId = user.id;
  });
  afterAll(async () => {
    clearValuationCache();
    await db?.teardown();
  });

  const make = async (companyName: string): Promise<string> =>
    (
      await createValuation(
        pool,
        { kind: '409a', companyName, userId },
        { actorType: 'human', actorId: userId, source: 'test' },
      )
    ).id;

  it('returns an empty list for no names without querying', async () => {
    expect(await findValuationIdsByCompanyName(pool, [])).toEqual([]);
  });

  it('matches names exactly and never as a pattern', async () => {
    // The comment on this function is emphatic that a LIKE here is one careless
    // generalisation away from retiring a client's engagement. These are the
    // three ways a pattern would leak: a prefix, a `%` wildcard, and a `_`.
    const smoke = await make('Smoke Test');
    await make('Smoke Test Holdings');

    expect((await findValuationIdsByCompanyName(pool, ['Smoke Test'])).map((r) => r.id)).toEqual([smoke]);
    expect(await findValuationIdsByCompanyName(pool, ['Smoke%'])).toEqual([]);
    expect(await findValuationIdsByCompanyName(pool, ['Smoke_Test'])).toEqual([]);
  });

  it('is case- and whitespace-sensitive', async () => {
    await make('Case Sensitive Inc');
    expect(await findValuationIdsByCompanyName(pool, ['case sensitive inc'])).toEqual([]);
    expect(await findValuationIdsByCompanyName(pool, [' Case Sensitive Inc'])).toEqual([]);
  });

  it('looks up several names at once and reports state', async () => {
    const a = await make('Alpha Metals');
    const b = await make('Beta Ceramics');

    const found = await findValuationIdsByCompanyName(pool, ['Alpha Metals', 'Beta Ceramics', 'Nobody Ltd']);

    expect(found.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(found.every((r) => r.state === 'pending')).toBe(true);
    expect(found.every((r) => r.archived === false)).toBe(true);
  });

  it('reports archived rows too, flagged — a name an archived row holds is still held', async () => {
    const id = await make('Gamma Optics');
    await retireValuations(pool, [id]);

    // The original name is now free...
    expect(await findValuationIdsByCompanyName(pool, ['Gamma Optics'])).toEqual([]);
    // ...and the renamed row is findable, and says it is archived.
    const found = await findValuationIdsByCompanyName(pool, ['Gamma Optics [retired]']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id, archived: true });
  });

  it('orders by creation time so a caller sees the oldest holder first', async () => {
    const first = await make('Duplicate Name Ltd');
    const second = await make('Duplicate Name Ltd');

    const found = await findValuationIdsByCompanyName(pool, ['Duplicate Name Ltd']);
    expect(found.map((r) => r.id)).toEqual([first, second]);
  });
});
