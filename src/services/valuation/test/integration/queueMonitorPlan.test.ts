import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { emailWithheldSql, suppressionExemptSql } from '../../src/repos/emailOutbox.js';
import { oldestActiveJobs } from '../../src/repos/jobs.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Outbox rows. Enough that scanning it serially is measurably the wrong plan. */
const ROWS = 40_000;

/**
 * `oldestActiveJobs` must not pay for its withheld test with the whole union.
 *
 * R228 gave the queue monitor the other half of the outbox's claim predicate,
 * so a message nobody is waiting on stops reading as a stalled queue. The set
 * it needs is right; the spelling it arrived in was `j.id IN (SELECT …)`, an
 * *uncorrelated* subquery, and the planner attaches one of those to the email
 * branch's scan filter as a hashed SubPlan.
 *
 * A branch carrying a SubPlan cannot go under a Parallel Append. So the clause
 * did not only cost its own work — it took the other four branches serial with
 * it, and all five are scanned in full whatever it says (every branch's status
 * filter is a `CASE`, which no index answers). Measured on 300k outbox rows:
 * 27ms before R228, 83ms in the IN spelling, 34ms correlated.
 *
 * The assertion is structural rather than timed, and it is not "no sequential
 * scan": the union genuinely reads five tables end to end and that is the
 * shape, not the bug. What must hold is that the withheld test sits beside the
 * union rather than inside a branch of it. The old spelling is explained
 * alongside as the discriminator — it has to fail the same check the current
 * one passes, or the check is not reading anything.
 *
 * What is deliberately *not* asserted is the join strategy. Postgres builds
 * the withheld set as a hash on a real outbox and as a per-candidate lookup on
 * a small one, and both are right at their own size; pinning either would make
 * this file a costing test. The one correlated spelling that was measurably
 * wrong — `e.id = j.id` with no status filter, so the subquery is a lookup
 * rather than a set, at 106ms against 83ms and 34ms — is wrong for a reason
 * the seed size decides, so it is recorded in `oldestActiveJobs` and not
 * guarded here.
 */

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/** `upper(to_hex(n))` zero-padded is a ULID: uppercase hex ⊂ Crockford base32. */
const ULID = (expr: string, prefix: string) =>
  `'${prefix}' || upper(lpad(to_hex(${expr}), ${26 - prefix.length}, '0'))`;

function tap(pool: pg.Pool): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    seen.push(typeof first === 'string' ? first : ((first as { text?: string })?.text ?? ''));
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return { seen, restore: () => ((pool as unknown as { query: unknown }).query = original) };
}

/**
 * True when the union itself carries the withheld test.
 *
 * Located by the `Append` rather than by relation name, because the fixed plan
 * reads `email_outbox` twice — once as a branch of the union and once to build
 * the withheld set beside it — and only the first of those may not carry a
 * SubPlan. A SubPlan anywhere under the Append is exactly what makes the node
 * an `Append` instead of a `Parallel Append`, which is the whole cost.
 */
function unionCarriesSubPlan(plan: PlanNode): boolean {
  const append = flatten(plan).find((n) => /Append$/.test(n['Node Type']));
  if (!append) throw new Error('no Append in the plan: the union is not being read as one');
  return flatten(append).some((n) =>
    (n.Plans ?? []).some((child) => (child['Parent Relationship'] ?? '') === 'SubPlan'),
  );
}

describe.skipIf(!dbUp)('the queue monitor builds its withheld set beside the union (R231)', () => {
  let db: TestDb;
  let current = '';
  /** The R228 spelling, reconstructed from the same shared predicate. */
  let previous = '';
  let currentPlan: PlanNode;
  let previousPlan: PlanNode;

  const explain = async (sql: string): Promise<PlanNode> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

    await q(
      `INSERT INTO users (id, email, password_digest, deleted_at)
       SELECT ${ULID('g', 'X')}, 'u' || g || '@x.y', 'x',
              CASE WHEN g % 33 = 0 THEN now() END
         FROM generate_series(1, 4000) g`,
    );
    await q(
      `INSERT INTO valuations (id, kind, company_name, user_id, archived_at)
       SELECT ${ULID('g', 'V')}, '409a', 'Co ' || g, ${ULID('1 + (g % 4000)', 'X')},
              CASE WHEN g % 8 = 0 THEN now() END
         FROM generate_series(1, 4000) g`,
    );
    // A history of delivered mail with a few live rows in it — the share that
    // makes scanning the table to answer for a handful of rows the wrong plan.
    await q(
      `INSERT INTO email_outbox (id, valuation_id, to_user_id, to_email, template_key,
                                 subject, body, status, created_at, sent_at, promotional)
       SELECT ${ULID('g', 'E')}, ${ULID('1 + (g % 4000)', 'V')}, ${ULID('1 + (g % 4000)', 'X')},
              'u' || (1 + (g % 4000)) || '@x.y',
              (ARRAY['valuation_published','comment_added','password_reset'])[1 + g % 3],
              's', 'b',
              (CASE WHEN g % 100 = 0 THEN 'queued' ELSE 'sent' END)::email_status,
              now() - (g || ' seconds')::interval,
              CASE WHEN g % 100 <> 0 THEN now() END,
              (g % 5 = 3)
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q(
      `INSERT INTO email_suppressions (to_email, reason)
       SELECT 'u' || (g * 9) || '@x.y', 'hard' FROM generate_series(1, 400) g`,
    );
    await q(
      `INSERT INTO notification_preferences (user_id, event_type, email)
       SELECT ${ULID('1 + (g % 4000)', 'X')},
              (ARRAY['valuation_published','comment_added','marketing'])[1 + g % 3],
              (g % 6 <> 0)
         FROM generate_series(1, 3000) g
       ON CONFLICT DO NOTHING`,
    );
    await q('ANALYZE');

    const t = tap(db.pool);
    try {
      await oldestActiveJobs(db.pool);
    } finally {
      t.restore();
    }
    current = t.seen.find((s) => /min\(j\.due_at\)/.test(s)) ?? '';
    if (!current) throw new Error('oldestActiveJobs issued no statement this recognises');

    // The R228 spelling: same predicate, uncorrelated. Built by swapping the
    // correlated EXISTS back out, so the two differ in nothing else.
    const from = current.indexOf('       AND NOT EXISTS (');
    const to = current.indexOf('     GROUP BY j.source');
    if (from < 0 || to < 0) throw new Error('cannot locate the withheld clause to swap');
    previous = `${current.slice(0, from)}       AND NOT (
         j.source = 'email'
         AND j.id IN (
           SELECT e.id FROM email_outbox e
            WHERE e.status = 'queued' AND ${emailWithheldSql('e', suppressionExemptSql())}
         )
       )
${current.slice(to)}`;

    currentPlan = await explain(current);
    previousPlan = await explain(previous);
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a queue small enough to be a rounding error on the outbox', async () => {
    // Vacuity guard. Every assertion below is true of an empty table, and the
    // plan the fix is about only appears when the branch is worth scanning.
    const { rows } = await db.pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM email_outbox) AS total,
              (SELECT count(*) FROM email_outbox WHERE status = 'queued') AS queued,
              (SELECT count(*) FROM email_suppressions WHERE released_at IS NULL) AS held,
              (SELECT count(*) FROM notification_preferences WHERE NOT email) AS off`,
    );
    const c = rows[0]!;
    expect(Number(c.total)).toBe(ROWS);
    expect(Number(c.queued)).toBe(ROWS / 100);
    expect(Number(c.held)).toBe(400);
    expect(Number(c.off)).toBeGreaterThan(100);
  });

  it('withholds the same rows in both spellings', async () => {
    // The fix is a plan, not a rule: if the two disagree about which rows are
    // withheld, the faster one is simply wrong and every check below is moot.
    const [a, b] = await Promise.all([db.pool.query(current), db.pool.query(previous)]);
    expect(a.rows).toEqual(b.rows);
    // …and the predicate is doing something, or "same answer" means nothing.
    const withheld = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_outbox e
        WHERE e.status = 'queued' AND ${emailWithheldSql('e', suppressionExemptSql())}`,
    );
    expect(Number(withheld.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('keeps the withheld test out of the union', () => {
    expect(unionCarriesSubPlan(currentPlan)).toBe(false);
  });

  it('is discriminating: the R228 spelling puts it inside a branch', () => {
    // Without this the check above passes against a plan it cannot read — a
    // renamed EXPLAIN field, an Append that has moved out from under the node
    // this walks.
    expect(unionCarriesSubPlan(previousPlan)).toBe(true);
  });
});
