import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Enough rows that a sequential scan is what Postgres picks when no index
 * serves the ordering. Same bar as `listSortPlans`: below a few thousand the
 * whole table is a handful of pages and a scan is genuinely cheapest, so a
 * smaller seed passes whether the index exists or not.
 */
const ROWS = 20_000;
/** Most credentials are live and most alerts are settled — see the shares below. */
const REVOKED_EVERY = 10;
const OPEN_EVERY = 20;

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
 * R202. Two lists whose leading sort key is an expression, not a column.
 *
 * `listSortPlans` (R166) and migration 0178 (R193) both found their subjects by
 * asking which *columns* an `ORDER BY` names. Neither could see these, because
 * `ORDER BY (revoked_at IS NULL) DESC` names no column the planner can seek on:
 * a btree on `revoked_at` orders NULLs against timestamps, not the boolean the
 * query sorts by. The fix is an index on the expression itself, and the thing
 * that can silently undo it is someone "tidying" the spelling — rewriting the
 * predicate, flipping a direction, or reordering the terms — any of which takes
 * the statement off the index while leaving the results identical.
 *
 * So each case below asserts the plan *and* runs the pre-fix spelling beside it
 * as a discriminator, the way `listSortPlans` does. Without that second half
 * these would pass for any index that happens to exist on the table.
 */
describe.skipIf(!dbUp)('expression-ordered lists are index scans (R202)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
    // The token listing left-joins `users`, and the join is half of what this
    // measures — with a handful of rows on that side a hash join is genuinely
    // cheapest and the plan proves nothing.
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest)
       SELECT ('02' || lpad(upper(to_hex(g)), 24, '0'))::ulid, 'tok' || g || '@x.y', 'x'
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    await db.pool.query(
      `INSERT INTO api_tokens (id, created_by, name, token_prefix, token_hash, created_at, last_used_at, revoked_at)
       SELECT ('01' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              ('02' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              'token ' || g, 'n409_' || g, 'hash-' || g,
              now() - (g || ' minutes')::interval,
              CASE WHEN g % 3 <> 0 THEN now() - (g || ' hours')::interval END,
              CASE WHEN g % ${REVOKED_EVERY} = 0 THEN now() - (g || ' minutes')::interval END
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    await db.pool.query(
      `INSERT INTO job_alerts (id, source, kind, detail, observed, threshold, opened_at, resolved_at)
       SELECT ('03' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              'source-' || g, (ARRAY['stalled','failing'])[1 + g % 2],
              'detail ' || g, g % 100, 50,
              now() - (g || ' minutes')::interval,
              CASE WHEN g % ${OPEN_EVERY} <> 0 THEN now() - (g || ' seconds')::interval END
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    // `listScimTokens` is `listAllApiTokens`' spelling on a second ledger, and
    // 0192 gives it the same index. Seeded to the same shape — most tokens live,
    // the revoked ones left behind for the audit trail.
    await db.pool.query(
      `INSERT INTO scim_tokens (id, token_hash, label, created_at, last_used_at, revoked_at)
       SELECT ('04' || lpad(upper(to_hex(g)), 24, '0'))::ulid, 'scim-hash-' || g, 'scim ' || g,
              now() - (g || ' minutes')::interval,
              CASE WHEN g % 3 <> 0 THEN now() - (g || ' hours')::interval END,
              CASE WHEN g % ${REVOKED_EVERY} = 0 THEN now() - (g || ' minutes')::interval END
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    // The ops task console's default page. Most tasks are settled and stay on
    // file — that is what the leading sort term is for — so the live end the
    // console reads is a minority of the table, the same shape as the ledgers
    // above.
    // Real parents: `review_tasks.valuation_id` is a foreign key, and the
    // narrow-filter assertion below needs an id that exists.
    await db.pool.query(
      `INSERT INTO valuations (id, user_id, kind, company_name)
       SELECT ('06' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              ('02' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              '409a', 'Co ' || g
         FROM generate_series(1, 900) g`,
    );
    await db.pool.query(
      `INSERT INTO review_tasks (id, valuation_id, kind, status, title, due_at, created_at)
       SELECT ('05' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              ('06' || lpad(upper(to_hex(1 + g % 900)), 24, '0'))::ulid,
              (enum_range(NULL::review_task_kind))[1 + g % array_length(enum_range(NULL::review_task_kind), 1)],
              (CASE WHEN g % 8 = 0 THEN 'open' ELSE 'done' END)::review_task_status,
              'task ' || g,
              CASE WHEN g % 4 <> 0 THEN now() - (g || ' minutes')::interval END,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    // Without statistics the planner is costing tables it believes are empty.
    // VACUUM as well as ANALYZE: `api_tokens_stats_idx` is only reachable as an
    // index-only scan, and index-only scans need the visibility map, which
    // VACUUM sets and ANALYZE does not.
    await db.pool.query('VACUUM ANALYZE api_tokens, job_alerts, scim_tokens, review_tasks');
  }, 120_000);

  afterAll(async () => db?.teardown());

  async function plan(sql: string): Promise<PlanNode[]> {
    const { rows } = await db.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
  }

  const seqScans = (nodes: PlanNode[], table: string): boolean =>
    nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table);
  /**
   * Any sort node, `Incremental Sort` included.
   *
   * Matching only `Sort` reads as strict and is the weaker test. Where the
   * leading key *is* indexed and only a later term is spelled wrong, Postgres
   * scans the index and finishes each presorted group with an `Incremental
   * Sort` — still a sort of the whole relation, just handed out in batches. On
   * a bare table that is the plan the mixed-direction discriminator produces,
   * so a `=== 'Sort'` predicate calls it "no sort" and the discriminator that
   * exists to prove the assertion above can fail, cannot.
   */
  const sorts = (nodes: PlanNode[]): boolean => nodes.some((n) => /Sort$/.test(n['Node Type']));

  /** The statement `listAllApiTokens` issues, joins and all. */
  const TOKEN_LIST = `
    SELECT t.id, t.created_at, p.name AS partner_name, u.email AS created_by_email
      FROM api_tokens t
      LEFT JOIN partners p ON p.id = t.partner_id
      LEFT JOIN users u ON u.id = t.created_by
     WHERE (false OR t.revoked_at IS NULL)`;

  it('listAllApiTokens seeks the expression index instead of sorting the table', async () => {
    const nodes = await plan(
      `${TOKEN_LIST} ORDER BY (t.revoked_at IS NULL) DESC, t.created_at DESC LIMIT 501`,
    );
    expect(seqScans(nodes, 'api_tokens')).toBe(false);
    expect(sorts(nodes)).toBe(false);
    expect(nodes.map((n) => n['Index Name'])).toContain('api_tokens_live_recent_idx');
  });

  it('the two whole-table hash joins the token listing used to build are gone', async () => {
    // The point of the index is not only the scan on `api_tokens`. Without an
    // ordering to seek on, the planner had to materialise `users` and
    // `partners` whole to hash-join them, then throw away all but one page.
    const nodes = await plan(
      `${TOKEN_LIST} ORDER BY (t.revoked_at IS NULL) DESC, t.created_at DESC LIMIT 501`,
    );
    expect(seqScans(nodes, 'users')).toBe(false);
    expect(seqScans(nodes, 'partners')).toBe(false);
  });

  /**
   * The counter beside the listing, asserted as *not* fixed.
   *
   * `apiTokenStats` reads the whole table and always will — `total` is
   * `count(*)`. A covering index on the three columns it reads was built and
   * measured, and Postgres declined it: `api_tokens` rows are narrow enough
   * that an index over three of their columns is half the heap's size, and one
   * sequential pass beats a random walk of that. This test pins the reasoning
   * rather than the index, so that if the row width or the table size ever
   * moves far enough for a covering index to win, the failure says so.
   */
  it('the stats counter is a full pass, and the covering index does not beat it', async () => {
    const STATS = `SELECT count(*) AS total,
              count(*) FILTER (WHERE revoked_at IS NULL) AS live,
              count(*) FILTER (
                WHERE revoked_at IS NULL
                  AND coalesce(last_used_at, created_at) < now() - interval '90 days'
              ) AS dormant
         FROM api_tokens`;
    expect(seqScans(await plan(STATS), 'api_tokens')).toBe(true);

    // Offered the index it would need, the planner still says no. Built inside
    // a transaction and rolled back, so the schema this asserts about is the
    // one the migrations produce.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE INDEX api_tokens_stats_probe ON api_tokens (revoked_at, last_used_at, created_at)',
      );
      await client.query('ANALYZE api_tokens');
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${STATS}`);
      const nodes = flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
      expect(nodes.map((n) => n['Index Name'])).not.toContain('api_tokens_stats_probe');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('listJobAlerts seeks the expression index on both of its two shapes', async () => {
    // `openOnly` false is the shape that scanned: the parameter makes the OR
    // true for every row, so there is no predicate left, only the ordering.
    const all = await plan(
      `SELECT * FROM job_alerts WHERE (false IS NOT TRUE OR resolved_at IS NULL)
        ORDER BY resolved_at IS NOT NULL ASC, opened_at DESC LIMIT 100`,
    );
    expect(seqScans(all, 'job_alerts')).toBe(false);
    expect(sorts(all)).toBe(false);

    const open = await plan(
      `SELECT * FROM job_alerts WHERE (true IS NOT TRUE OR resolved_at IS NULL)
        ORDER BY resolved_at IS NOT NULL ASC, opened_at DESC LIMIT 100`,
    );
    expect(seqScans(open, 'job_alerts')).toBe(false);
  });

  /**
   * The discriminator. Each pair is the same answer written two ways: the term
   * order or direction the expression index cannot serve, then the one it can.
   * If a future Postgres learns to serve the left-hand spellings, these are the
   * assertions to delete — not the indexes.
   */
  it('the orderings the expression indexes cannot serve still sort the table', async () => {
    // Terms swapped: `created_at` first puts the index's second key in the lead.
    expect(
      sorts(await plan(`${TOKEN_LIST} ORDER BY t.created_at DESC, (t.revoked_at IS NULL) DESC LIMIT 501`)),
    ).toBe(true);
    // Direction flipped on the tiebreaker: a mixed ordering costs a sort node
    // however well the leading key is indexed (0170's rule).
    expect(
      sorts(await plan(`${TOKEN_LIST} ORDER BY (t.revoked_at IS NULL) DESC, t.created_at ASC LIMIT 501`)),
    ).toBe(true);
    // And the bare column, which is what an index on `revoked_at` alone would
    // have served — a different ordering, not a cheaper spelling of this one.
    expect(
      sorts(await plan(`SELECT * FROM job_alerts ORDER BY resolved_at DESC, opened_at DESC LIMIT 100`)),
    ).toBe(true);
  });

  /**
   * The third instance of the shape, found in R251 and fixed by 0192.
   *
   * `listScimTokens` is `listAllApiTokens` written on a second ledger, and
   * neither of the two searches that found the first two could see it: 0178's
   * asked which *columns* a sort key names, and this one names none, while the
   * roster above was typed by hand. `expressionSortCoverage` is the answer to
   * the second half of that — it reads the source and requires every
   * expression-led sort to be measured here or exempted.
   *
   * `scim_tokens` only grows: `revokeScimToken` stamps `revoked_at` rather than
   * deleting, so the sort was over every token ever issued to produce a page of
   * 200. 3.81 ms / 223 blocks -> 0.03 ms / 5 blocks at 20k rows.
   */
  it('listScimTokens seeks the expression index instead of sorting the ledger', async () => {
    const SQL = `SELECT * FROM scim_tokens ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 201`;
    const nodes = await plan(SQL);
    expect(seqScans(nodes, 'scim_tokens')).toBe(false);
    expect(sorts(nodes)).toBe(false);
    expect(nodes.map((n) => n['Index Name'])).toContain('scim_tokens_live_recent_idx');

    // The discriminator, same as the pair above: the spellings the index cannot
    // serve still sort, so this cannot pass on some other index existing.
    expect(
      sorts(
        await plan(`SELECT * FROM scim_tokens ORDER BY created_at DESC, (revoked_at IS NULL) DESC LIMIT 201`),
      ),
    ).toBe(true);
    expect(
      sorts(
        await plan(`SELECT * FROM scim_tokens ORDER BY (revoked_at IS NULL) DESC, created_at ASC LIMIT 201`),
      ),
    ).toBe(true);
  });

  /**
   * The ops task console, fixed by 0193 — both defects at once.
   *
   * `listTasks` builds its WHERE from four optional filters and `GET
   * /api/v1/tasks` supplies none of them, so the page an operator lands on is
   * an unfiltered read ordered by an expression (this file's shape) whose
   * remaining three terms run in mixed directions (0170's shape). Neither index
   * trick alone reaches it; a per-column direction on the expression index does.
   *
   * 4.69 ms / 339 blocks -> 0.01 ms / 9 blocks at 20k tasks.
   */
  const TASK_ORDER = `ORDER BY (t.status IN ('done','cancelled')), t.due_at ASC NULLS LAST,
                               t.created_at DESC, t.id DESC`;

  it('the unfiltered task console seeks its index instead of sorting the queue', async () => {
    const nodes = await plan(`SELECT * FROM review_tasks t ${TASK_ORDER} LIMIT 50 OFFSET 0`);
    expect(seqScans(nodes, 'review_tasks')).toBe(false);
    expect(sorts(nodes)).toBe(false);
    expect(nodes.map((n) => n['Index Name'])).toContain('review_tasks_console_idx');
  });

  it('the task console index is the whole ordering, not just its first term', async () => {
    // The discriminator, and the one that matters here: an expression index on
    // the leading term alone leaves the three mixed-direction terms to a sort,
    // so this assertion is what distinguishes 0193 from 0181's spelling applied
    // to a fourth table. Each spelling below moves one term off the index.
    for (const order of [
      // `due_at` descending: the index holds it ascending.
      `ORDER BY (t.status IN ('done','cancelled')), t.due_at DESC, t.created_at DESC, t.id DESC`,
      // `created_at` ascending against the index's DESC.
      `ORDER BY (t.status IN ('done','cancelled')), t.due_at ASC NULLS LAST, t.created_at ASC, t.id DESC`,
      // NULLS FIRST on `due_at`, which is a different order of the same rows.
      `ORDER BY (t.status IN ('done','cancelled')), t.due_at ASC NULLS FIRST, t.created_at DESC, t.id DESC`,
    ]) {
      expect(sorts(await plan(`SELECT * FROM review_tasks t ${order} LIMIT 50`)), order).toBe(true);
    }
  });

  it('a task list filtered to one valuation still reaches its own index', async () => {
    // The console index must not talk the planner out of the narrow one. A
    // valuation's tasks are a couple of dozen rows and sorting them is free;
    // walking the console ordering to find them would not be.
    const nodes = await plan(
      `SELECT * FROM review_tasks t WHERE t.valuation_id = '06000000000000000000000001' ${TASK_ORDER} LIMIT 50`,
    );
    expect(seqScans(nodes, 'review_tasks')).toBe(false);
    expect(nodes.map((n) => n['Index Name'])).toContain('review_tasks_valuation_idx');
  });

  /**
   * 0120's `job_alerts (opened_at DESC)` served exactly one reader, which could
   * never use it, and 0181 drops it. Asserted so that a later migration adding
   * an index on the bare column has to say why.
   */
  it('the superseded recency index is gone', async () => {
    const { rows } = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'job_alerts'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('job_alerts_open_first_idx');
    expect(names).not.toContain('job_alerts_recent_idx');
  });
});
