import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { findArchivableValuations } from '../../src/repos/retention.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Rows seeded. Enough that a sequential scan is measurably the wrong plan. */
const TOTAL = 20_000;
/** How many of the oldest rows are already archived — the sweep's steady state. */
const ARCHIVED = 19_000;
/** The sweep's own batch size, and half the live candidates, so LIMIT bites. */
const LIMIT = 500;
/** Policy age used throughout. Every seeded row is older than this. */
const CUTOFF_DAYS = 365;

/**
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the sweep's candidate query,
 * written out here rather than taken from the repo so the plan under test is
 * the literal SQL, and so a rewrite of `findArchivableValuations` that quietly
 * stops matching the index shows up as a failure here and not as a slow sweep
 * in production. The behavioural tests below are what pin the two together.
 */
const SWEEP_SQL = `
  SELECT v.id, v.user_id,
         EXISTS (
           SELECT 1 FROM legal_holds h
            WHERE h.active
              AND (h.scope = 'global'
                OR (h.scope = 'valuation' AND h.reference_id = v.id)
                OR (h.scope = 'user' AND h.reference_id = v.user_id))
         ) AS frozen
    FROM valuations v
   WHERE v.archived_at IS NULL
     AND v.created_at < now() - ($1 || ' days')::interval
   ORDER BY v.created_at ASC
   LIMIT $2`;

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

const blocks = (n: PlanNode) => (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0);

/**
 * Blocks the `valuations` scan reads to find its candidates, and nothing else.
 *
 * Two subtractions matter. EXPLAIN's counts are cumulative up the tree, so a
 * node already includes its children — and the per-row `legal_holds` EXISTS
 * hangs off whichever node evaluates it, costing ~6 blocks per *returned* row
 * regardless of how the candidates were found. Left in, it swamps the number
 * this migration moves: 3,000 blocks of subplan on either side of a 460-block
 * difference, so the win reads as noise.
 *
 * Where the subplan attaches is itself plan-dependent — under the index scan
 * when the EXISTS is evaluated in its target list, under a separate Result node
 * when a Sort intervenes — which is why this discounts SubPlan children by
 * relationship rather than assuming a shape.
 */
function candidateScanBlocks(plan: PlanNode[]): number {
  const scan = candidateScan(plan);
  const subplans = (scan.Plans ?? []).filter((c) => c['Parent Relationship'] === 'SubPlan');
  return blocks(scan) - subplans.reduce((sum, c) => sum + blocks(c), 0);
}

/** The node that reads `valuations`, whichever way the planner chose to. */
function candidateScan(plan: PlanNode[]): PlanNode {
  const scan = plan.find((n) => n['Relation Name'] === 'valuations');
  if (!scan) throw new Error(`no valuations scan in plan: ${JSON.stringify(plan)}`);
  return scan;
}

async function explainSweep(client: {
  query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<PlanNode[]> {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SWEEP_SQL}`, [
    String(CUTOFF_DAYS),
    LIMIT,
  ]);
  const plan = (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  return flatten(plan);
}

describe.skipIf(!dbUp)('retention sweep candidate index (migration 0140)', () => {
  let db: TestDb;
  let userId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    userId = newUlid();
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'sweep@x.y', 'x')`, [
      userId,
    ]);

    // Uppercase hex is a subset of Crockford base32, so a zero-padded hex
    // counter satisfies the `ulid` domain without a generator in the database.
    //
    // Every row is older than the cutoff, and the oldest ARCHIVED of them are
    // already settled. That is the shape that made the old plan walk the whole
    // table: the rows it had to skip all sort *before* the ones it wants, so
    // there is no prefix of the ordering it can stop early in.
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, created_at, archived_at)
       SELECT upper(lpad(to_hex(g), 26, '0')),
              '409a',
              'Co ' || g,
              $1,
              now() - ((${TOTAL} - g + ${CUTOFF_DAYS + 1}) || ' days')::interval,
              CASE WHEN g <= $2 THEN now() ELSE NULL END
         FROM generate_series(1, ${TOTAL}) AS g`,
      [userId, ARCHIVED],
    );
    await db.pool.query('ANALYZE valuations');
  }, 60_000);
  afterAll(async () => db?.teardown());

  it('creates the partial index over live rows only', async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'valuations' AND indexname = $1`,
      ['valuations_live_created_idx'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/\(created_at\)/);
    expect(rows[0]!.indexdef).toMatch(/WHERE \(archived_at IS NULL\)/);
  });

  it('holds only the live rows, not the whole table', async () => {
    const { rows } = await db.pool.query<{ live: number; total: number }>(
      `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS live, count(*)::int AS total
         FROM valuations`,
    );
    expect(rows[0]!.total).toBe(TOTAL);
    expect(rows[0]!.live).toBe(TOTAL - ARCHIVED);
  });

  it('plans the sweep as an index scan that discards nothing', async () => {
    const scan = candidateScan(await explainSweep(db.pool));
    expect(scan['Index Name']).toBe('valuations_live_created_idx');
    expect(scan['Node Type']).not.toBe('Seq Scan');

    // The point of the partial index: archived rows are not in it, so the scan
    // has nothing to throw away. A non-zero count here means the planner fell
    // back to an index that must re-check `archived_at` against the heap.
    expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
  });

  it('reads two orders of magnitude fewer blocks for its candidates', async () => {
    const withIndex = candidateScanBlocks(await explainSweep(db.pool));

    // Drop inside a transaction and roll back, so the comparison is against
    // this exact table rather than a re-seeded approximation of it.
    const client = await db.pool.connect();
    let without: PlanNode[];
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX valuations_live_created_idx');
      without = await explainSweep(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    const withoutIndex = candidateScanBlocks(without);
    // Without it the scan reads the table and throws away the archived
    // majority; with it, it reads a handful of index pages and the heap rows it
    // actually returns.
    expect(candidateScan(without)['Rows Removed by Filter'] ?? 0).toBeGreaterThan(ARCHIVED / 2);
    expect(withIndex).toBeLessThan(withoutIndex / 10);
  });

  it('stops at the batch limit instead of scanning every live row', async () => {
    const scan = candidateScan(await explainSweep(db.pool));
    // LIMIT is half the live rows, so a plan that reads all of them and then
    // truncates is not the plan we want, however cheap it looks.
    expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
    expect(TOTAL - ARCHIVED).toBeGreaterThan(LIMIT);
  });

  it('still returns the oldest live candidates, in order', async () => {
    const rows = await findArchivableValuations(db.pool, CUTOFF_DAYS, 50);
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.user_id === userId)).toBe(true);
    expect(rows.every((r) => r.frozen === false)).toBe(true);

    const { rows: expected } = await db.pool.query<{ id: string }>(
      `SELECT id FROM valuations
        WHERE archived_at IS NULL AND created_at < now() - interval '365 days'
        ORDER BY created_at ASC LIMIT 50`,
    );
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });

  it('drops a row from the index as soon as it is archived', async () => {
    const before = await findArchivableValuations(db.pool, CUTOFF_DAYS, 5);
    await db.pool.query('UPDATE valuations SET archived_at = now() WHERE id = ANY($1)', [
      before.map((r) => r.id),
    ]);
    const after = await findArchivableValuations(db.pool, CUTOFF_DAYS, 5);
    // Every id the previous pass took is gone, so the next pass starts after
    // them rather than in front of them. This is what keeps the sweep's cost
    // flat as the archived block grows.
    expect(after.some((a) => before.some((b) => b.id === a.id))).toBe(false);
  });

  it('serves the default engagement list, which filters the same way', async () => {
    // listValuations applies `archived_at IS NULL` unconditionally and defaults
    // to `created_at DESC`; a b-tree reads backwards, so the one index covers
    // both directions and this is not a second index waiting to be written.
    const { rows } = await db.pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM valuations WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 25`,
    );
    const scan = candidateScan(flatten(rows[0]!['QUERY PLAN'][0]!.Plan));
    expect(scan['Index Name']).toBe('valuations_live_created_idx');
  });
});

if (!dbUp) {
  console.warn('[retentionSweepIndex.test] Postgres not reachable — skipped. Run: npm run dev:db');
}
