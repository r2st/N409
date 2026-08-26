import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  NULLABLE_SORT_COLUMNS,
  SORTABLE_COLUMNS,
  listValuations,
  orderBySql,
  type SortableColumn,
} from '../../src/repos/valuations.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Enough rows that a sequential scan is the plan Postgres actually picks when
 * no index serves the ordering — the same bar `searchAndListIndexes.test.ts`
 * sets. Below a few thousand the whole table is one handful of pages and a scan
 * is genuinely cheapest, so a smaller seed would pass whether the indexes exist
 * or not.
 */
const VALUATIONS = 20_000;
/** Archived share, so the partial `WHERE archived_at IS NULL` excludes something. */
const ARCHIVED_EVERY = 10;
/** Engagements with no deadline, so `due_date` really holds nulls to place. */
const NO_DUE_DATE_EVERY = 3;
const PER_PAGE = 25;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/**
 * Every (column, direction) the sort parameter accepts, as the pair the UI
 * sends. `ValuationsPage` renders seven of these eight as clickable headers and
 * `GET /api/v1/valuations?sort=` takes all eight, so each one is a plan a user
 * can ask for, not a hypothetical.
 */
const EVERY_SORT: Array<{ column: SortableColumn; dir: 'asc' | 'desc' }> = SORTABLE_COLUMNS.flatMap(
  (column) => [
    { column, dir: 'asc' as const },
    { column, dir: 'desc' as const },
  ],
);

describe.skipIf(!dbUp)('sorted valuation lists are index scans (R166)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
    const userId = newUlid();
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'sorts@x.y', 'x')`, [
      userId,
    ]);

    // Seeded set-at-a-time: 20k single-row inserts through the repo would spend
    // the test's whole budget on round trips, and this needs volume, not the
    // repo's write path.
    await db.pool.query(
      `INSERT INTO valuations
         (id, kind, company_name, user_id, state, archived_at, created_at, due_date, published_at)
       SELECT ('01' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              (ARRAY['409a','409a','409a','718','fund'])[1 + g % 5]::valuation_kind,
              'Company ' || lpad(g::text, 6, '0'),
              $2,
              (ARRAY['pending','review','published','completed'])[1 + g % 4]::valuation_state,
              CASE WHEN g % ${ARCHIVED_EVERY} = 0 THEN now() - (g || ' minutes')::interval END,
              now() - (g || ' minutes')::interval,
              CASE WHEN g % ${NO_DUE_DATE_EVERY} <> 0 THEN now() + (g || ' hours')::interval END,
              CASE WHEN g % 4 = 2 THEN now() - (g || ' hours')::interval END
         FROM generate_series(1, $1) g`,
      [VALUATIONS, userId],
    );
    // Without statistics the planner is costing a table it believes is empty.
    await db.pool.query('ANALYZE valuations');
  }, 120_000);

  afterAll(async () => db?.teardown());

  async function planFor(order: string): Promise<PlanNode[]> {
    const { rows } = await db.pool.query(
      `EXPLAIN (FORMAT JSON) SELECT * FROM valuations WHERE archived_at IS NULL ${order} LIMIT ${PER_PAGE}`,
    );
    return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
  }

  const seqScansValuations = (plan: PlanNode[]): boolean =>
    plan.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'valuations');

  it.each(EVERY_SORT)('$column $dir is served by an index', async ({ column, dir }) => {
    const plan = await planFor(orderBySql([{ column, dir }]));
    expect(seqScansValuations(plan)).toBe(false);
    expect(plan.some((n) => n['Node Type']?.startsWith('Index'))).toBe(true);
  });

  it('the unsorted default is served by an index too', async () => {
    const plan = await planFor(orderBySql(undefined));
    expect(seqScansValuations(plan)).toBe(false);
  });

  /**
   * The two spellings this round is about, side by side on one table.
   *
   * This is the discriminator: without it the test above passes for any
   * `orderBySql` that happens to name an indexed column, and the specific thing
   * that was wrong — a `NULLS LAST` that cannot move a row on a NOT NULL column
   * but takes the statement off every index in the schema — could come back
   * without a failure. If the day comes that Postgres learns to serve
   * `DESC NULLS LAST` from an ASC btree, this is the test to delete.
   */
  it('the old spelling is the sequential scan the new one avoids', async () => {
    expect(seqScansValuations(await planFor('ORDER BY created_at DESC NULLS LAST, id ASC'))).toBe(true);
    expect(seqScansValuations(await planFor('ORDER BY created_at DESC, id DESC'))).toBe(false);

    // And the mixed ordering, which is the other half — an indexed leading
    // column still costs a sort when the tiebreaker runs the other way.
    expect(seqScansValuations(await planFor('ORDER BY company_name DESC NULLS LAST, id ASC'))).toBe(true);
    expect(seqScansValuations(await planFor('ORDER BY company_name DESC, id DESC'))).toBe(false);
  });

  /**
   * `NULLABLE_SORT_COLUMNS` is a hand-written set standing in for a schema fact,
   * which is exactly the kind of constant that is right when written and wrong
   * two migrations later. Asked of the catalog instead of trusted: a sortable
   * column that gains NOT NULL should lose its `NULLS LAST` (and its second
   * index), and one that loses NOT NULL must gain both, or it silently goes
   * back to scanning.
   */
  it('NULLABLE_SORT_COLUMNS matches what the schema actually allows', async () => {
    const { rows } = await db.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'valuations' AND column_name = ANY($1)`,
      [[...SORTABLE_COLUMNS]],
    );
    expect(rows).toHaveLength(SORTABLE_COLUMNS.length);
    const actuallyNullable = rows
      .filter((r) => r.is_nullable === 'YES')
      .map((r) => r.column_name)
      .sort();
    expect(actuallyNullable).toEqual([...NULLABLE_SORT_COLUMNS].sort());
  });

  it('emits NULLS LAST only where a NULL can actually turn up', () => {
    for (const column of SORTABLE_COLUMNS) {
      const sql = orderBySql([{ column, dir: 'desc' }]);
      expect(sql.includes('NULLS LAST')).toBe(NULLABLE_SORT_COLUMNS.has(column));
    }
  });

  /**
   * The plan change moved the tiebreaker's direction, so the ordering it exists
   * to guarantee has to be re-proved rather than assumed. A whole book walked
   * page by page under a low-cardinality sort — 20k rows over four states — is
   * where a non-deterministic tiebreaker shows up: rows tie by the thousand, and
   * any wobble between two OFFSETs serves one twice and drops another.
   */
  it('pages a low-cardinality sort without repeating or dropping a row', async () => {
    const scope = { kind: 'all' } as const;
    const seen = new Set<string>();
    let total = 0;
    for (let page = 1; page <= 8; page++) {
      const result = await listValuations(db.pool, scope, {
        sort: [{ column: 'state', dir: 'desc' }],
        page,
        perPage: PER_PAGE,
      });
      total = result.total;
      for (const row of result.items) seen.add(row.id);
    }
    expect(seen.size).toBe(8 * PER_PAGE);
    expect(total).toBe(VALUATIONS - VALUATIONS / ARCHIVED_EVERY);
  });

  /**
   * The nullable columns keep `NULLS LAST` because it means something there, and
   * the second index exists to serve it. Both halves are asserted at once: an
   * engagement with no deadline sorts *after* every engagement that has one,
   * descending — which is the reading an operator wants and the opposite of what
   * a bare `DESC` on a btree would give them.
   */
  it('sorts engagements with no due date last, descending', async () => {
    const { rows } = await db.pool.query<{ due_date: Date | null }>(
      `SELECT due_date FROM valuations WHERE archived_at IS NULL
        ${orderBySql([{ column: 'due_date', dir: 'desc' }])} LIMIT 5`,
    );
    expect(rows.every((r) => r.due_date !== null)).toBe(true);

    const { rows: tail } = await db.pool.query<{ due_date: Date | null }>(
      `SELECT due_date FROM valuations WHERE archived_at IS NULL
        ORDER BY due_date DESC NULLS FIRST, id DESC LIMIT 5`,
    );
    expect(tail.every((r) => r.due_date === null)).toBe(true);
  });
});
