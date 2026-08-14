import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { listUsers } from '../../src/repos/adminUsers.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Enough rows that a sequential scan is measurably the wrong plan. */
const USERS = 20_000;
/** Soft-deleted share, so the partial predicate excludes something real. */
const DELETED_EVERY = 10;
const VALUATIONS = 20_000;
/** Only migrated engagements carry a workflow id — the partial predicate. */
const WORKFLOW_EVERY = 50;
/** The console's page size. */
const PER_PAGE = 25;

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
 * Runs `body` with `indexName` dropped, inside a transaction that is rolled
 * back — so the comparison is against this exact table rather than a re-seeded
 * approximation of it, and the index survives for the tests that follow.
 */
async function without<T>(pool: pg.Pool, indexName: string, body: (c: Explainer) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DROP INDEX ${indexName}`);
    return await body(client as unknown as Explainer);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * The engagement search's ULID branch, from `buildValuationWhere`.
 *
 * Written out rather than driven through the repo for the reason the retention
 * index test gives: the plan under test should be the literal SQL, and a
 * rewrite that quietly stops matching the index should fail here rather than
 * turn into a slow search box. The behavioural test below pins the two
 * together.
 */
const SEARCH_SQL = `
  SELECT * FROM valuations
   WHERE archived_at IS NULL AND (id = $1 OR workflow_id = $1)
   ORDER BY created_at DESC LIMIT 25`;

/** `listUsers`' page query, likewise. */
const LIST_SQL = `
  WITH page AS (
    SELECT u.id, u.created_at FROM users u
     WHERE u.deleted_at IS NULL
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ${PER_PAGE} OFFSET 0
  )
  SELECT u.*, p.name AS partner_name,
         coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
    FROM page
    JOIN users u ON u.id = page.id
    LEFT JOIN partners p ON p.id = u.partner_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
   GROUP BY u.id, p.name
   ORDER BY u.created_at DESC, u.id DESC`;

/** What `listUsers` was before: join and aggregate everything, then page. */
const LIST_SQL_UNPAGED = `
  SELECT u.*, p.name AS partner_name,
         coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN partners p ON p.id = u.partner_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
   WHERE u.deleted_at IS NULL
   GROUP BY u.id, p.name
   ORDER BY u.created_at DESC
   LIMIT ${PER_PAGE} OFFSET 0`;

/** The node that aggregates the role arrays, whichever form the planner chose. */
function aggregateNode(plan: PlanNode[]): PlanNode {
  const agg = plan.find((n) => /Aggregate/.test(n['Node Type']));
  if (!agg) throw new Error(`no aggregate in plan: ${JSON.stringify(plan)}`);
  return agg;
}

describe.skipIf(!dbUp)('search and admin-list indexes (migration 0148)', () => {
  let db: TestDb;
  let ownerId: string;

  beforeAll(async () => {
    db = await setupTestDb();

    // Uppercase hex is a subset of Crockford base32, so a zero-padded hex
    // counter satisfies the `ulid` domain without a generator in the database.
    // Distinct `created_at` per row, descending with the counter, so the page
    // the ordering asks for is knowable without reading the plan.
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest, created_at, deleted_at)
       SELECT upper(lpad(to_hex(g), 26, '0')), 'u' || g || '@test.example.com', 'x',
              now() - (g || ' minutes')::interval,
              CASE WHEN g % ${DELETED_EVERY} = 0 THEN now() ELSE NULL END
         FROM generate_series(1, ${USERS}) AS g`,
    );

    ownerId = newUlid();
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest) VALUES ($1, 'owner@test.example.com', 'x')`,
      [ownerId],
    );
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, workflow_id)
       SELECT upper(lpad(to_hex(g + 1000000), 26, '0')), '409a', 'Co ' || g, $1,
              CASE WHEN g % ${WORKFLOW_EVERY} = 0 THEN 'WF-' || g ELSE NULL END
         FROM generate_series(1, ${VALUATIONS}) AS g`,
      [ownerId],
    );
    await db.pool.query('ANALYZE users');
    await db.pool.query('ANALYZE valuations');
  }, 120_000);
  afterAll(async () => db?.teardown());

  describe('valuations_workflow_id_idx', () => {
    it('is partial over the migrated engagements only', async () => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'valuations' AND indexname = $1`,
        ['valuations_workflow_id_idx'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/\(workflow_id\)/);
      expect(rows[0]!.indexdef).toMatch(/WHERE \(workflow_id IS NOT NULL\)/);
    });

    it('costs a fraction of the table it indexes', async () => {
      const { rows } = await db.pool.query<{ idx: string; tbl: string }>(
        `SELECT pg_relation_size('valuations_workflow_id_idx')::text AS idx,
                pg_relation_size('valuations')::text AS tbl`,
      );
      // Partial: it holds one row in fifty, so the storage it costs is not a
      // reason to weigh it against the scan it removes.
      expect(Number(rows[0]!.idx)).toBeLessThan(Number(rows[0]!.tbl) / 10);
    });

    it('keeps the ULID branch off a sequential scan', async () => {
      const plan = await explain(db.pool, SEARCH_SQL, [ownerId]);
      const scan = plan.find((n) => n['Relation Name'] === 'valuations');

      // The point: `id = $1` alone is a primary-key lookup, and OR-ing an
      // unindexed column to it used to take the whole disjunction off the
      // index. Both arms are now index-served under a BitmapOr.
      expect(scan?.['Node Type']).not.toBe('Seq Scan');
      expect(plan.some((n) => n['Index Name'] === 'valuations_workflow_id_idx')).toBe(true);
      expect(plan.some((n) => n['Index Name'] === 'valuations_pkey')).toBe(true);
    });

    it('reads two orders of magnitude fewer blocks than the scan it replaced', async () => {
      const withIndex = await explain(db.pool, SEARCH_SQL, [ownerId]);
      const withoutIndex = await without(db.pool, 'valuations_workflow_id_idx', (c) =>
        explain(c, SEARCH_SQL, [ownerId]),
      );

      const seq = withoutIndex.find((n) => n['Relation Name'] === 'valuations');
      expect(seq?.['Node Type']).toBe('Seq Scan');
      // Without it, every row in the table is read and discarded to answer a
      // lookup for one.
      expect(seq?.['Rows Removed by Filter'] ?? 0).toBeGreaterThan(VALUATIONS / 2);

      const readWith = Math.max(...withIndex.map(blocks));
      const readWithout = Math.max(...withoutIndex.map(blocks));
      expect(readWith).toBeLessThan(readWithout / 10);
    });

    it('finds the engagement the search box was given a workflow id for', async () => {
      const { rows } = await db.pool.query<{ id: string; workflow_id: string }>(
        `SELECT id, workflow_id FROM valuations WHERE workflow_id IS NOT NULL LIMIT 1`,
      );
      const target = rows[0]!;
      const { rows: hits } = await db.pool.query<{ id: string }>(
        `SELECT id FROM valuations WHERE archived_at IS NULL AND (id = $1 OR workflow_id = $1)`,
        [target.workflow_id],
      );
      expect(hits.map((h) => h.id)).toEqual([target.id]);
    });
  });

  describe('users_live_created_idx and the paged list', () => {
    it('is partial over the accounts the console lists', async () => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = $1`,
        ['users_live_created_idx'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/created_at DESC/);
      expect(rows[0]!.indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);
    });

    it('aggregates one page of role arrays, not the whole table', async () => {
      const paged = aggregateNode(await explain(db.pool, LIST_SQL));
      const unpaged = aggregateNode(await explain(db.pool, LIST_SQL_UNPAGED));

      // This is the whole reason the query was restructured: LIMIT cannot be
      // pushed under a GROUP BY, so the old form built a role array for every
      // account on the platform in order to print twenty-five of them.
      expect(paged['Actual Rows']).toBe(PER_PAGE);
      expect(unpaged['Actual Rows']).toBeGreaterThan(USERS / 2);
    });

    it('drives the page from the partial index', async () => {
      const plan = await explain(db.pool, LIST_SQL);
      const scans = plan.filter((n) => n['Relation Name'] === 'users');
      expect(scans.some((n) => n['Index Name'] === 'users_live_created_idx')).toBe(true);
      expect(scans.every((n) => n['Node Type'] !== 'Seq Scan')).toBe(true);
    });

    it('reads far fewer blocks than the form that paged last', async () => {
      const paged = Math.max(...(await explain(db.pool, LIST_SQL)).map(blocks));
      const unpaged = Math.max(...(await explain(db.pool, LIST_SQL_UNPAGED)).map(blocks));
      expect(paged).toBeLessThan(unpaged / 2);
    });

    it('returns the newest live accounts, in order, with their roles', async () => {
      const { items, total } = await listUsers(db.pool, { page: 1, perPage: PER_PAGE });

      const { rows: expected } = await db.pool.query<{ id: string }>(
        `SELECT id FROM users WHERE deleted_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT ${PER_PAGE}`,
      );
      expect(items.map((i) => i.id)).toEqual(expected.map((r) => r.id));
      expect(total).toBe(USERS - USERS / DELETED_EVERY + 1); // +1: the valuations owner
      // The aggregate still runs — an account with no roles gets an empty
      // array, not a null and not a row with one null element.
      expect(items.every((i) => Array.isArray(i.roles) && i.roles.length === 0)).toBe(true);
      expect(items.every((i) => i.partner_name === null)).toBe(true);
    });

    it('pages without repeating or skipping a row across the boundary', async () => {
      const one = await listUsers(db.pool, { page: 1, perPage: PER_PAGE });
      const two = await listUsers(db.pool, { page: 2, perPage: PER_PAGE });
      const ids = new Set([...one.items, ...two.items].map((i) => i.id));
      // The id tiebreaker is what makes this hold when timestamps collide.
      expect(ids.size).toBe(PER_PAGE * 2);
    });

    it('orders ties by id rather than by whatever the plan produced', async () => {
      const at = new Date('2020-01-01T00:00:00Z');
      // Crockford base32 has no I, L, O or U, so the ids spell nothing.
      const tied = ['01TEA0000000000000000000AA', '01TEA0000000000000000000BB', '01TEA0000000000000000000CC'];
      for (const id of tied) {
        await db.pool.query(
          `INSERT INTO users (id, email, password_digest, created_at) VALUES ($1, $2, 'x', $3)`,
          [id, `${id.toLowerCase()}@test.example.com`, at],
        );
      }
      try {
        const { rows } = await db.pool.query<{ id: string }>(
          `SELECT id FROM users WHERE deleted_at IS NULL AND created_at = $1
            ORDER BY created_at DESC, id DESC`,
          [at],
        );
        expect(rows.map((r) => r.id)).toEqual([...tied].reverse());
      } finally {
        await db.pool.query('DELETE FROM users WHERE id = ANY($1)', [tied]);
      }
    });

    it('still finds soft-deleted accounts when asked, outside the partial index', async () => {
      const live = await listUsers(db.pool, { page: 1, perPage: 5 });
      const all = await listUsers(db.pool, { page: 1, perPage: 5, includeDeleted: true });
      expect(all.total).toBeGreaterThan(live.total);
      expect(all.total - live.total).toBe(USERS / DELETED_EVERY);
    });

    it('still applies the search and role filters through the paging CTE', async () => {
      const byEmail = await listUsers(db.pool, { page: 1, perPage: 10, q: 'owner@' });
      expect(byEmail.total).toBe(1);
      expect(byEmail.items[0]!.id).toBe(ownerId);

      const byRole = await listUsers(db.pool, { page: 1, perPage: 10, role: 'admin' });
      expect(byRole.total).toBe(0);
      expect(byRole.items).toEqual([]);
    });
  });
});

if (!dbUp) {
  console.warn('[searchAndListIndexes.test] Postgres not reachable — skipped. Run: npm run dev:db');
}
