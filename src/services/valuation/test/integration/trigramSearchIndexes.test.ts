import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { likeContains, userFullNameSql, userSearchSql } from '../../src/db/like.js';
import { listUsers, listUserOptions } from '../../src/repos/adminUsers.js';
import { searchUsers, searchValuations } from '../../src/repos/search.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Enough rows that a sequential scan is measurably the wrong plan. */
const USERS = 20_000;
const VALUATIONS = 20_000;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

const blocks = (n: PlanNode) => (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0);

interface Explainer {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function explain(client: Explainer, sql: string, params: unknown[] = []): Promise<PlanNode[]> {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
}

/**
 * Runs `body` with `indexNames` dropped, inside a transaction that is rolled
 * back — same device as the 0148 test: the comparison is against this exact
 * table rather than a re-seeded approximation, and the indexes survive for the
 * tests that follow.
 *
 * Every index goes in one transaction on one connection, and that is not a
 * convenience. DROP INDEX takes ACCESS EXCLUSIVE on the *table*, so a second
 * connection dropping a second index on the same table waits on the first
 * one's lock — and since the first is held open for the duration of `body`,
 * the two block until the test times out rather than failing.
 */
async function without<T>(
  pool: pg.Pool,
  indexNames: string | string[],
  body: (c: Explainer) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of Array.isArray(indexNames) ? indexNames : [indexNames]) {
      await client.query(`DROP INDEX ${name}`);
    }
    return await body(client as unknown as Explainer);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * The company-name arm of every engagement search, written out rather than
 * driven through a repo — the plan under test should be the literal SQL, so a
 * rewrite that quietly stops matching the index fails here instead of turning
 * into a slow search box. The behavioural tests below tie the two together.
 */
const COMPANY_SQL = `SELECT id FROM valuations WHERE company_name ILIKE $1`;
/** Both arms of the user search, from the one helper the index is built on. */
const USER_SQL = `SELECT id FROM users WHERE ${userSearchSql('$1')}`;
const FULL_NAME_SQL = `SELECT id FROM users WHERE ${userFullNameSql()} ILIKE $1`;

/** A needle that appears in exactly one row, so the index is worth choosing. */
const NEEDLE_COMPANY = 'Zylophone Quarry Holdings';
const NEEDLE_FIRST = 'Ada';
const NEEDLE_LAST = 'Lovelace';
const NEEDLE_EMAIL = 'ada.lovelace@analyticalengine.test';

describe.skipIf(!dbUp)('trigram search indexes (migration 0149)', () => {
  let db: TestDb;
  let ownerId: string;
  let needleUserId: string;

  beforeAll(async () => {
    db = await setupTestDb();

    // Uppercase hex is a subset of Crockford base32, so a zero-padded hex
    // counter satisfies the `ulid` domain without a generator in the database.
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest, first_name, last_name, created_at)
       SELECT upper(lpad(to_hex(g), 26, '0')), 'u' || g || '@test.example.com', 'x',
              'First' || g, 'Last' || g, now() - (g || ' minutes')::interval
         FROM generate_series(1, ${USERS}) AS g`,
    );

    needleUserId = newUlid();
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest, first_name, last_name)
       VALUES ($1, $2, 'x', $3, $4)`,
      [needleUserId, NEEDLE_EMAIL, NEEDLE_FIRST, NEEDLE_LAST],
    );

    // A role, so the picker below (which joins user_roles) has a row to find —
    // an empty option list would make that assertion vacuously true.
    await db.pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE key = 'reviewer'`,
      [needleUserId],
    );

    ownerId = newUlid();
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest) VALUES ($1, 'owner@test.example.com', 'x')`,
      [ownerId],
    );
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id)
       SELECT upper(lpad(to_hex(g + 1000000), 26, '0')), '409a', 'Company ' || g, $1
         FROM generate_series(1, ${VALUATIONS}) AS g`,
      [ownerId],
    );
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id) VALUES ($1, '409a', $2, $3)`,
      [newUlid(), NEEDLE_COMPANY, ownerId],
    );
    /*
     * VACUUM, not just ANALYZE — and the difference is the whole reason this
     * comment is here.
     *
     * A GIN index does not write each new row straight into the tree. With
     * `fastupdate` on (the default) insertions land in an unordered pending
     * list that a scan has to read end to end on top of the tree itself, and
     * the planner costs that accordingly. Here the migration builds the index
     * on an empty table and the seeding below inserts 20k rows behind it, so
     * every row is in the pending list: the index measures 4.6 MB against the
     * 680 kB the same rows produce when CREATE INDEX builds them in bulk, a
     * scan of it is costed at 902 against the sequential scan's 668, and the
     * planner correctly refuses it.
     *
     * VACUUM flushes the pending list into the tree. That is what autovacuum
     * does in production, and it is why the index in production is the compact
     * one: 0149 runs CREATE INDEX over tables that already hold their rows.
     *
     * Worth knowing outside this test — after a bulk import, trigram search
     * stays on a sequential scan until the table is vacuumed.
     */
    await db.pool.query('VACUUM ANALYZE users');
    await db.pool.query('VACUUM ANALYZE valuations');
  }, 180_000);
  afterAll(async () => db?.teardown());

  describe('the extension', () => {
    it('is installed by the migration, as the database owner', async () => {
      const { rows } = await db.pool.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
      );
      // Trusted since PostgreSQL 13, so this needs no superuser — the whole
      // reason 0148 could defer it and 0149 could stop deferring it.
      expect(rows).toHaveLength(1);
    });
  });

  describe('index definitions', () => {
    it.each([
      ['valuations', 'valuations_company_name_trgm_idx', 'company_name'],
      ['users', 'users_email_trgm_idx', 'email'],
    ])('%s.%s is a GIN trigram index over %s', async (table, index, column) => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
        [table, index],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/USING gin/);
      expect(rows[0]!.indexdef).toContain(`${column} gin_trgm_ops`);
    });

    it('users_full_name_trgm_idx is built on exactly the expression the queries send', async () => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = $1`,
        ['users_full_name_trgm_idx'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/USING gin/);
      // An expression index is only used when the query's expression matches
      // it. Postgres normalises the stored definition, so compare on the parts
      // that carry the meaning rather than on the punctuation.
      const def = rows[0]!.indexdef.replace(/::text/g, '').replace(/\s+/g, ' ');
      expect(def).toContain("COALESCE(first_name, '')");
      expect(def).toContain("COALESCE(last_name, '')");
      expect(def).toContain('gin_trgm_ops');
    });

    it('is not built on concat_ws, which Postgres would refuse', async () => {
      // The reason `userFullNameSql` exists. concat_ws is STABLE, so this is
      // not a preference — it is the only form that can be indexed at all.
      await expect(
        db.pool.query(
          `CREATE INDEX users_concat_ws_trgm_idx ON users
             USING gin (concat_ws(' ', first_name, last_name) gin_trgm_ops)`,
        ),
      ).rejects.toThrow(/must be marked IMMUTABLE/i);
    });
  });

  describe('company_name', () => {
    it('serves a substring match from the trigram index, not a scan', async () => {
      const plan = await explain(db.pool, COMPANY_SQL, [likeContains('Zylophone')]);
      const scan = plan.find((n) => n['Relation Name'] === 'valuations');
      expect(scan?.['Node Type']).not.toBe('Seq Scan');
      expect(plan.some((n) => n['Index Name'] === 'valuations_company_name_trgm_idx')).toBe(true);
    });

    it('reads an order of magnitude fewer blocks than the scan it replaced', async () => {
      const withIndex = await explain(db.pool, COMPANY_SQL, [likeContains('Zylophone')]);
      const withoutIndex = await without(db.pool, 'valuations_company_name_trgm_idx', (c) =>
        explain(c, COMPANY_SQL, [likeContains('Zylophone')]),
      );

      const seq = withoutIndex.find((n) => n['Relation Name'] === 'valuations');
      expect(seq?.['Node Type']).toBe('Seq Scan');
      // Without it, a leading-wildcard ILIKE reads every row in the table to
      // return one. There is no prefix for a b-tree to descend on.
      expect(seq?.['Rows Removed by Filter'] ?? 0).toBeGreaterThan(VALUATIONS / 2);

      expect(Math.max(...withIndex.map(blocks))).toBeLessThan(Math.max(...withoutIndex.map(blocks)) / 10);
    });

    it('still finds the engagement it was asked for', async () => {
      const hits = await searchValuations(db.pool, { kind: 'all' }, 'Zylophone Quarry');
      expect(hits.map((h) => h.company_name)).toEqual([NEEDLE_COMPANY]);
    });

    it('keeps a literal % literal rather than matching every row', async () => {
      const id = newUlid();
      await db.pool.query(
        `INSERT INTO valuations (id, kind, company_name, user_id) VALUES ($1, '409a', $2, $3)`,
        [id, '100% Renewable', ownerId],
      );
      try {
        // escapeLike still applies: the trigram index changes the plan, not the
        // pattern language.
        const hits = await searchValuations(db.pool, { kind: 'all' }, '100%');
        expect(hits.map((h) => h.id)).toEqual([id]);
      } finally {
        await db.pool.query('DELETE FROM valuations WHERE id = $1', [id]);
      }
    });
  });

  describe('users', () => {
    it('serves both arms of the search from indexes under a bitmap OR', async () => {
      const plan = await explain(db.pool, USER_SQL, [likeContains(NEEDLE_LAST)]);
      const scan = plan.find((n) => n['Relation Name'] === 'users');
      expect(scan?.['Node Type']).not.toBe('Seq Scan');

      const used = plan.map((n) => n['Index Name']).filter(Boolean);
      expect(used).toContain('users_email_trgm_idx');
      expect(used).toContain('users_full_name_trgm_idx');
    });

    it('serves the full-name expression from its expression index', async () => {
      const plan = await explain(db.pool, FULL_NAME_SQL, [likeContains('Ada Lovelace')]);
      expect(plan.some((n) => n['Index Name'] === 'users_full_name_trgm_idx')).toBe(true);
      expect(plan.find((n) => n['Relation Name'] === 'users')?.['Node Type']).not.toBe('Seq Scan');
    });

    it('reads far fewer blocks than the scan it replaced', async () => {
      const withIndex = await explain(db.pool, USER_SQL, [likeContains(NEEDLE_LAST)]);
      const withoutIndex = await without(db.pool, ['users_email_trgm_idx', 'users_full_name_trgm_idx'], (c) =>
        explain(c, USER_SQL, [likeContains(NEEDLE_LAST)]),
      );
      expect(Math.max(...withIndex.map(blocks))).toBeLessThan(Math.max(...withoutIndex.map(blocks)) / 5);
    });

    it('matches across the first/last boundary, which is what people type', async () => {
      const hits = await searchUsers(db.pool, 'Ada Lovelace');
      expect(hits.map((h) => h.id)).toEqual([needleUserId]);
    });

    it.each([
      ['the email local part', 'ada.lovelace'],
      ['the email domain', 'analyticalengine'],
      ['the first name alone', NEEDLE_FIRST],
      ['the last name alone', NEEDLE_LAST],
    ])('finds the account by %s', async (_label, q) => {
      const hits = await searchUsers(db.pool, q);
      expect(hits.map((h) => h.id)).toContain(needleUserId);
    });
  });

  describe('the admin console, moved off concat_ws', () => {
    it('finds an account by email substring', async () => {
      const { items, total } = await listUsers(db.pool, { page: 1, perPage: 10, q: 'ada.lovelace' });
      expect(total).toBe(1);
      expect(items[0]!.id).toBe(needleUserId);
    });

    it('finds an account by first and last name together', async () => {
      const { items, total } = await listUsers(db.pool, { page: 1, perPage: 10, q: 'Ada Lovelace' });
      expect(total).toBe(1);
      expect(items[0]!.id).toBe(needleUserId);
    });

    it('no longer matches a query spanning the address and the name', async () => {
      // The one thing splitting concat_ws into two arms gives up, pinned here
      // deliberately rather than discovered later: the old single concatenation
      // could be matched across the join between email and first name. Nobody
      // types this, and it is what makes the predicate indexable.
      const { total } = await listUsers(db.pool, {
        page: 1,
        perPage: 10,
        q: `${NEEDLE_EMAIL} ${NEEDLE_FIRST}`,
      });
      expect(total).toBe(0);
    });

    it('keeps the search combined with the other filters', async () => {
      const { total } = await listUsers(db.pool, {
        page: 1,
        perPage: 10,
        q: 'Ada',
        role: 'admin',
      });
      expect(total).toBe(0);
    });

    it('applies the same predicate to the user picker', async () => {
      // listUserOptions had its own copy of the concat_ws match; it now shares
      // `userSearchSql` with the list, so the two cannot disagree about what a
      // query matches.
      const { options } = await listUserOptions(db.pool, 'ops', { q: 'Lovelace' });
      expect(options.map((o) => o.id)).toEqual([needleUserId]);
    });
  });

  describe('what the index cannot do', () => {
    it('falls back to a scan below three characters, and still answers', async () => {
      // A trigram index is keyed on three-character grams, so a one- or
      // two-character pattern produces no keys to look up. Postgres knows this
      // and plans a scan; the answer is the same, the cost is not. Worth
      // pinning so a future "the index isn't being used" is not a bug report.
      const plan = await explain(db.pool, COMPANY_SQL, [likeContains('Zy')]);
      expect(plan.find((n) => n['Relation Name'] === 'valuations')?.['Node Type']).toBe('Seq Scan');

      const hits = await searchValuations(db.pool, { kind: 'all' }, 'Zy');
      expect(hits.map((h) => h.company_name)).toContain(NEEDLE_COMPANY);
    });
  });
});

if (!dbUp) {
  console.warn('[trigramSearchIndexes.test] Postgres not reachable — skipped. Run: npm run dev:db');
}
