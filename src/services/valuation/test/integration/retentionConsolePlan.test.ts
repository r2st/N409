import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listRetiredValuations } from '../../src/repos/retention.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Valuations seeded. Enough that reading the table per row is unmistakable. */
const TOTAL = 6_000;
/** How many of them are retired — the console's whole matched set. */
const ARCHIVED = 2_000;
/** Archival actions — the ones the console's LATERAL is looking for. */
const ARCHIVALS = 4_000;
/**
 * Ledger rows of every other kind, written *after* the archivals.
 *
 * This is what makes the missing index cost something rather than merely look
 * wrong. `retention_actions_created_idx` exists, and a LATERAL ordered by
 * `created_at DESC LIMIT 1` can walk it backwards — so on a ledger where every
 * row is an archival, the wrong plan finds its match in the first entry or two
 * and is fast by accident. A real ledger is not that: 0083 declares five data
 * types and 0174 five actions, the sweep writes all of them, and the archival
 * for a given engagement is buried under everything written since. Seeding the
 * non-matching rows newest puts the walk where production puts it.
 */
const OTHER_ACTIONS = 16_000;
/** The console's own page size. */
const PAGE = 50;

/**
 * The retired-engagements console, and the N+1 that was written in SQL.
 *
 * `listRetiredValuations` pairs each archived valuation with the archival that
 * explains it, through a `LEFT JOIN LATERAL`. A LATERAL is evaluated once per
 * row on its left, so the shape of the query decides how many times the lookup
 * runs, and the shape of `retention_actions`' indexes decides what one run
 * costs. Both were wrong: the LATERAL sat on the unpaged side of a `count(*)
 * OVER ()` — which is a window over the matched set, so the `LIMIT` cannot stop
 * the scan early — and nothing indexed `reference_id`, so each of those
 * evaluations read the retention ledger end to end. One sequential scan per
 * retired engagement, to fill in fifty cells.
 *
 * Neither `listQueryScaling` nor `listEndpointQueryCounts` could see it. The
 * endpoint issues exactly one statement whatever the size of the answer, which
 * is what both of those measure. The cost is inside the statement.
 *
 * So this asserts the two halves separately, because they fail separately and
 * a reader looking at one failure should not have to guess which:
 *
 *   - `loops` on the `retention_actions` node is how many times the lookup ran.
 *     It must be the size of the *page*, not the size of the matched set. That
 *     is the query shape (repos/retention.ts).
 *   - the node itself must be an index scan. That is migration 0177.
 *
 * And a third, which is the reason the first two are allowed to be about plans
 * at all: the rewritten query returns the same rows, in the same order, with
 * the same `total`, as the flat form it replaced. A faster query that answers a
 * different question is not an optimisation.
 */

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/**
 * The shape this replaced: one flat select, the LATERAL on the unpaged side of
 * the window. Kept so the assertions below can be shown to distinguish the two
 * rather than merely to pass.
 */
const FLAT_SQL = `
  SELECT v.id, v.number, v.company_name, v.kind, v.state, v.archived_at,
         a.detail ->> 'reason' AS retired_reason,
         COALESCE((a.detail ->> 'manual')::boolean, false) AS retired_manually,
         count(*) OVER () AS total
    FROM valuations v
    LEFT JOIN LATERAL (
      SELECT ra.detail FROM retention_actions ra
       WHERE ra.data_type = 'valuation' AND ra.reference_id = v.id AND ra.action = 'archived'
       ORDER BY ra.created_at DESC LIMIT 1
    ) a ON true
   WHERE v.archived_at IS NOT NULL
   ORDER BY v.archived_at DESC
   LIMIT $1`;

/**
 * The statement the repo issues, captured rather than restated.
 *
 * `retentionSweepIndex` writes its SQL out in the test file and says why: the
 * plan under test should be the literal SQL. That is right when the query is
 * short. This one is a nested select with a correlated LATERAL, and a copy of
 * it here would be a copy that can drift into passing while the repo's own
 * statement regresses — the failure mode being guarded against is *a change to
 * this query*, so the query has to come from the thing that would change.
 */
async function captureStatement(
  pool: pg.Pool,
  run: () => Promise<unknown>,
  match: RegExp,
): Promise<{ text: string; values: unknown[] }> {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    seen.push({ text, values: (args[1] as unknown[]) ?? [] });
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  try {
    await run();
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
  const hit = seen.find((s) => match.test(s.text));
  if (!hit) throw new Error(`no statement matched ${match}; saw ${seen.length}`);
  return hit;
}

describe.skipIf(!dbUp)('the retired-engagements console reads its ledger once per row (R193)', () => {
  let db: TestDb;
  let plan: PlanNode[];
  let statement: { text: string; values: unknown[] };

  beforeAll(async () => {
    db = await setupTestDb();
    const userId = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'retention@x.y', 'x')`, [
      userId,
    ]);

    // Uppercase hex is a subset of Crockford base32, so a zero-padded hex
    // counter satisfies the `ulid` domain without a generator in the database
    // — the same idiom `retentionSweepIndex` uses.
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, created_at, archived_at)
       SELECT upper(lpad(to_hex(g), 26, '0')), '409a', 'Co ' || g, $1,
              now() - (g || ' minutes')::interval,
              CASE WHEN g <= $2 THEN now() - (g || ' minutes')::interval ELSE NULL END
         FROM generate_series(1, ${TOTAL}) g`,
      [userId, ARCHIVED],
    );

    // Two archivals per retired engagement on average, which is the ledger's
    // real shape — a row is archived, restored, archived again — and the reason
    // the repo uses a LATERAL rather than a join on max(created_at). Dated an
    // hour back and older, so every one of them sorts behind the noise below.
    await db.pool.query(
      `INSERT INTO retention_actions (id, data_type, action, reference_id, detail, created_at)
       SELECT upper(lpad(to_hex(g + 1000000), 26, '0')), 'valuation', 'archived',
              upper(lpad(to_hex(1 + (g % ${ARCHIVED})), 26, '0')),
              jsonb_build_object('reason', 'policy elapsed', 'manual', false),
              now() - '1 hour'::interval - (g || ' seconds')::interval
         FROM generate_series(1, ${ARCHIVALS}) g`,
    );
    await db.pool.query(
      `INSERT INTO retention_actions (id, data_type, action, reference_id, detail, created_at)
       SELECT upper(lpad(to_hex(g + 2000000), 26, '0')),
              (ARRAY['email_outbox','support_message','contact_submission','notification'])[1 + (g % 4)],
              (ARRAY['purged','skipped_hold','purge_eligible','restored'])[1 + (g % 4)],
              upper(lpad(to_hex(1 + (g % ${ARCHIVED})), 26, '0')),
              '{}'::jsonb,
              now() - (g || ' milliseconds')::interval
         FROM generate_series(1, ${OTHER_ACTIONS}) g`,
    );
    await db.pool.query('ANALYZE');

    statement = await captureStatement(
      db.pool,
      () => listRetiredValuations(db.pool, { limit: PAGE }),
      /retention_actions/,
    );
    const { rows } = await db.pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
      statement.values,
    );
    plan = flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
  }, 120_000);
  afterAll(async () => db?.teardown());

  /** The node that reads `retention_actions`, however the planner reached it. */
  const ledgerScan = (): PlanNode => {
    const node = plan.find(
      (n) => n['Relation Name'] === 'retention_actions' || n['Index Name']?.startsWith('retention_actions'),
    );
    if (!node) throw new Error(`no retention_actions node in plan: ${JSON.stringify(plan)}`);
    return node;
  };

  it('seeds a book large enough for the wrong plan to be wrong', async () => {
    // Vacuity guard. Both assertions below pass trivially against an empty
    // table — a LATERAL that never runs has loops=1 and no sequential scan.
    const { rows } = await db.pool.query<{ archived: string; actions: string }>(
      `SELECT (SELECT count(*) FROM valuations WHERE archived_at IS NOT NULL) AS archived,
              (SELECT count(*) FROM retention_actions) AS actions`,
    );
    expect(Number(rows[0]!.archived)).toBe(ARCHIVED);
    expect(Number(rows[0]!.actions)).toBe(ARCHIVALS + OTHER_ACTIONS);
    expect(ARCHIVED).toBeGreaterThan(PAGE * 10);
  });

  it('evaluates the reason lookup once per row on the page, not once per retired row', () => {
    // The number this test exists for. Before the rewrite it was ARCHIVED.
    expect(ledgerScan()['Actual Loops']).toBeLessThanOrEqual(PAGE);
  });

  it('would count ARCHIVED loops in the shape it replaced', async () => {
    // The discriminator, in the style `listSortPlans` uses: run the old
    // spelling and show that the assertion above distinguishes them. Without
    // this, an EXPLAIN that stopped reporting `Actual Loops` — or a `ledgerScan`
    // that started finding the wrong node — would read as a passing test.
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${FLAT_SQL}`, [PAGE]);
    const old = flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan).find(
      (n) => n['Relation Name'] === 'retention_actions' || n['Index Name']?.startsWith('retention_actions'),
    );
    expect(old?.['Actual Loops']).toBe(ARCHIVED);
  });

  it('answers each of those lookups from an index rather than a scan', () => {
    const node = ledgerScan();
    expect(node['Node Type']).not.toBe('Seq Scan');
    expect(node['Index Name']).toBe('retention_actions_reference_idx');
  });

  it('reads a page worth of the ledger rather than a table worth', () => {
    // Loops and node type are both about shape; this is the consequence, and it
    // is what would actually be noticed in production. A page of fifty should
    // cost a few blocks per row of ledger access, not thousands.
    const node = ledgerScan();
    const blocks = (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0);
    expect(blocks).toBeLessThan(PAGE * 20);
  });

  it('returns what the flat form returned — same rows, same order, same total', async () => {
    // The rewrite moved a window function inside a subquery and a LATERAL
    // outside it. Both are places where "faster" and "different" are one edit
    // apart, so the old shape is run alongside and the answers compared.
    const flat = await db.pool.query(FLAT_SQL, [PAGE]);
    const nested = await listRetiredValuations(db.pool, { limit: PAGE });

    expect(nested.rows).toHaveLength(PAGE);
    expect(nested.total).toBe(ARCHIVED);
    expect(Number(flat.rows[0]!.total)).toBe(nested.total);
    expect(nested.rows.map((r) => r.id)).toEqual(flat.rows.map((r) => r.id));
    expect(nested.rows.map((r) => r.retired_reason)).toEqual(flat.rows.map((r) => r.retired_reason));
    // Not all null, or the comparison above is a comparison of two blanks.
    expect(nested.rows.every((r) => r.retired_reason === 'policy elapsed')).toBe(true);
  });

  it('still filters and still counts the filtered set', async () => {
    // The `q` branch moved inside the subquery with the rest of the WHERE. If
    // it had been left on the outside it would filter *after* the LIMIT, so a
    // search would return a short page of an unfiltered one.
    const one = await listRetiredValuations(db.pool, { q: 'Co 1234', limit: PAGE });
    expect(one.rows.map((r) => r.company_name)).toEqual(['Co 1234']);
    expect(one.total).toBe(1);
  });
});
