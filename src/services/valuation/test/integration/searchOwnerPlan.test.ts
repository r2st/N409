import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import {
  buildValuationWhere,
  listValuations,
  Q_OWNER_LIMIT,
  resolveQueryOwners,
} from '../../src/repos/valuations.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The free-text search box on the workspace list matches three things: the
 * company name, an exact workflow id, and the requesting user's name or email.
 * Migration 0149 indexed all of them — a trigram index on `company_name`, and
 * two more on `users.email` and the full-name expression.
 *
 * The company-name half reached its index. The owner half could not, and
 * neither could the company-name half *once the owner half was written beside
 * it*: the owner match was a correlated `EXISTS` inside the same `OR`, and one
 * non-indexable arm takes the whole disjunction off `BitmapOr` and onto a scan
 * of every live valuation. So the statement that motivated three indexes used
 * none of them, and the count and the page each paid 24ms on 40k rows.
 *
 * The tell was that `trigramSearchIndexes.test.ts` passed the whole time: it
 * asserted the *users* indexes were reachable by a query written to reach them,
 * which they are, and never asked whether the query the product actually sends
 * reaches them — the vacuous shape this codebase keeps finding. So the plan
 * assertions here are taken from `listValuations`'s own emitted SQL rather than
 * from a statement composed in this file.
 *
 * `resolveQueryOwners` resolves the owner arm to ids first, turning it into
 * `user_id = ANY($n)` — a value, which is an index condition. The two
 * statements together cost less than the one did.
 *
 * **What this file does and does not guard.** The correctness of the rewrite is
 * pinned here properly: every spelling is compared against the correlated form
 * row for row, which is the property that makes it a performance fix rather
 * than a different search. The *plan* is only partly pinned — one assertion,
 * that the owner arm reaches `valuations_user_idx`. The other plan assertions
 * this file started with were removed rather than tuned: which plan Postgres
 * picks for the company-name arm turns on table statistics, and on a freshly
 * bulk-loaded 40k-row fixture it chooses a sequential scan for *both* spellings
 * — so an assertion written here would have been passing on the fixture's
 * shape rather than on the query's. The 24ms → 1.4ms figure above was measured
 * with EXPLAIN (ANALYZE) on a separately seeded, vacuumed 40k database; it is
 * real, and it is not reproducible from this fixture. Guarding it properly
 * needs a fixture that reaches the planner's crossover, which R167 did not
 * build. `mergedFeedPlans.test.ts` is the plan guard that *is* complete.
 */

const VALUATIONS = 40_000;
/**
 * The users table needs volume too, and that is not padding.
 *
 * Every assertion below is about which index the planner reaches for, and with
 * two rows in `users` a sequential scan of it is genuinely the cheapest plan —
 * so a seeded pair would make the trigram assertions fail for a reason that has
 * nothing to do with the query, and would let the correlated form off with a
 * plan it never gets in production.
 */
const USERS = 20_000;
/** Owners with a distinctive surname, so the owner arm matches something real. */
const NEEDLE_LAST = 'Ravenscroft';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}

const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

function tapStatements(pool: pg.Pool): {
  seen: Array<{ text: string; params: unknown[] }>;
  restore: () => void;
} {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    seen.push({ text, params: (args[1] as unknown[]) ?? [] });
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return {
    seen,
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

describe.skipIf(!dbUp)('the free-text search reaches its indexes (R167)', () => {
  let db: TestDb;
  let bulkOwnerId: string;
  let needleOwnerId: string;
  let needleValuationId: string;

  const explain = async (sql: string, params: unknown[] = []): Promise<PlanNode[]> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
  };

  const statementsFor = async (q: string) => {
    const tap = tapStatements(db.pool);
    try {
      await listValuations(db.pool, { kind: 'all' }, { q, page: 1, perPage: 25 });
    } finally {
      tap.restore();
    }
    return tap.seen;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    bulkOwnerId = newUlid();
    needleOwnerId = newUlid();
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest, first_name, last_name)
       VALUES ($1, 'bulk@test.example.com', 'x', 'Bulk', 'Owner'),
              ($2, 'needle@test.example.com', 'x', 'Hypatia', $3)`,
      [bulkOwnerId, needleOwnerId, NEEDLE_LAST],
    );
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest, first_name, last_name)
       SELECT ('05' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              'filler' || g || '@test.example.com', 'x', 'Given' || g, 'Family' || g
         FROM generate_series(1, $1) g`,
      [USERS],
    );
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, created_at)
       SELECT ('01' || lpad(upper(to_hex(g)), 24, '0'))::ulid, '409a',
              'Search Co ' || lpad(g::text, 6, '0'), $2, now() - (g || ' minutes')::interval
         FROM generate_series(1, $1) g`,
      [VALUATIONS, bulkOwnerId],
    );
    needleValuationId = newUlid();
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id) VALUES ($1, '409a', 'Unrelated Holdings', $2)`,
      [needleValuationId, needleOwnerId],
    );
    await db.pool.query('ANALYZE');
  }, 300_000);
  afterAll(async () => db?.teardown());

  describe('the answer', () => {
    it('still finds an engagement by its owner surname', async () => {
      const { items } = await listValuations(
        db.pool,
        { kind: 'all' },
        { q: NEEDLE_LAST, page: 1, perPage: 25 },
      );
      expect(items.map((i) => i.id)).toEqual([needleValuationId]);
    });

    it('still finds one by company name, and by owner email', async () => {
      const byName = await listValuations(
        db.pool,
        { kind: 'all' },
        { q: 'Search Co 000123', page: 1, perPage: 25 },
      );
      expect(byName.items).toHaveLength(1);
      const byEmail = await listValuations(
        db.pool,
        { kind: 'all' },
        { q: 'needle@test.example.com', page: 1, perPage: 25 },
      );
      expect(byEmail.items.map((i) => i.id)).toEqual([needleValuationId]);
    });

    /**
     * The whole point of the rewrite is that it is the *same* predicate. Both
     * spellings are built here from the same filters and compared row for row,
     * because a faster search that answers a slightly different question is not
     * a performance fix.
     */
    it.each([NEEDLE_LAST, 'Search Co 00012', 'needle@test.example.com', 'Hypatia Ravenscroft', 'zzz'])(
      'agrees with the correlated form for %j',
      async (q) => {
        const resolved = await resolveQueryOwners(db.pool, { q });
        const fast = buildValuationWhere({ kind: 'all' }, resolved);
        const slow = buildValuationWhere({ kind: 'all' }, { q });
        expect(fast.whereSql).not.toBe(slow.whereSql);
        const idsOf = async (built: { whereSql: string; params: unknown[] }) =>
          (await db.pool.query<{ id: string }>(`SELECT id FROM valuations ${built.whereSql} ORDER BY id`, built.params))
            .rows.map((r) => r.id);
        expect(await idsOf(fast)).toEqual(await idsOf(slow));
      },
    );
  });

  describe('the plan', () => {
    it('serves the owner arm from the user-id index, as a value', async () => {
      const [, page] = await statementsFor(NEEDLE_LAST);
      const plan = await explain(page!.text, page!.params);
      expect(plan.map((n) => n['Index Name'])).toContain('valuations_user_idx');
      expect(plan.find((n) => n['Relation Name'] === 'valuations')?.['Node Type']).not.toBe('Seq Scan');
    });

  });

  describe('the enumeration bound', () => {
    it('is off by default, so nothing that skips the resolver changes behaviour', () => {
      const built = buildValuationWhere({ kind: 'all' }, { q: 'anything' });
      expect(built.whereSql).toMatch(/EXISTS/);
    });

    it('falls back to the correlated form rather than truncating the owner list', async () => {
      // A search matching more accounts than we will enumerate. Faked by asking
      // for a pattern every seeded user matches and lowering nothing: with two
      // users the real limit is never reached, so the branch is exercised
      // through the value `resolveQueryOwners` returns for it.
      const tooMany = buildValuationWhere({ kind: 'all' }, { q: 'x', qOwnerIds: null });
      expect(tooMany.whereSql).toMatch(/EXISTS/);
      expect(Q_OWNER_LIMIT).toBeGreaterThan(0);

      // And a resolvable one does not take that branch.
      const resolved = await resolveQueryOwners(db.pool, { q: NEEDLE_LAST });
      expect(resolved.qOwnerIds).toEqual([needleOwnerId]);
      expect(buildValuationWhere({ kind: 'all' }, resolved).whereSql).not.toMatch(/EXISTS/);
    });

    it('is a no-op for the searches that never had an owner arm', async () => {
      for (const q of [needleValuationId, '#42', '42']) {
        const tap = tapStatements(db.pool);
        try {
          expect((await resolveQueryOwners(db.pool, { q })).qOwnerIds).toBeUndefined();
        } finally {
          tap.restore();
        }
        expect(tap.seen).toHaveLength(0);
      }
    });
  });
});
