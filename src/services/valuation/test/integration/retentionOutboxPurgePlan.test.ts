import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { purgeExpiredOutbox } from '../../src/repos/retention.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Messages seeded, all of them old enough and settled enough to be eligible.
 *
 * Enough that a scan of the backlog is unmistakable in the loop counts, and
 * that the discriminator below reads a number no index could produce by luck.
 */
const MESSAGES = 8_000;
/** The policy age the statements are explained under. */
const RETENTION_DAYS = 90;

/**
 * The outbox purge must not read the backlog to count what a hold is holding,
 * when there is no hold (R290).
 *
 * `purgeExpiredOutbox` issues two statements. The DELETE is bounded — it takes
 * `OUTBOX_PURGE_BATCH` ids and stops. The count beside it is not: it asks how
 * many *eligible* messages a legal hold is freezing, over the whole eligible
 * set rather than over the batch, because that number is the operator's answer
 * to "how much is your hold holding" and not a progress bar.
 *
 * Every conjunct of the hold predicate is correlated to the candidate row —
 * `h.reference_id = e.to_user_id`, `lower(hu.email) = lower(e.to_email)`,
 * `h.reference_id = e.valuation_id` — so the planner has nothing it can lift
 * out and evaluate once. It walks every eligible row and asks `legal_holds`
 * about each one in turn. On an empty hold table that is a full pass over the
 * backlog to reach the number zero, and it is the dominant cost of the sweep:
 * measured on 300k messages with 270k eligible, 170ms and 270,327 blocks
 * against 15.7ms and 4,358 for the DELETE that does the actual work. It grows
 * with the backlog and nothing bounds it, and since R289 it is time a *write*
 * transaction is held open rather than a slow read on the pool.
 *
 * The fix is a conjunct that correlates to nothing: `EXISTS (SELECT 1 FROM
 * legal_holds WHERE active)`. Postgres plans that as an InitPlan evaluated once
 * and a One-Time Filter above the scan, so with no active hold the scan is
 * never executed at all. It changes no answer — it is implied by the predicate
 * beside it, since a row frozen by a hold is a row for which an active hold
 * exists — so it can only short-circuit a count that was going to be zero.
 *
 * WHAT IS ASSERTED, and why not milliseconds. The claim is structural: the
 * backlog is not read. `Actual Loops` on the `email_outbox` node states exactly
 * that — EXPLAIN ANALYZE reports zero for a node the executor never entered —
 * and it is the same number on a fast machine and a loaded one.
 *
 * The ungated spelling is explained alongside as the discriminator, because
 * every assertion here is trivially true of an empty table and the file has to
 * be shown to tell the two statements apart rather than merely to pass.
 */

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/** Every node that reads `email_outbox`, however the planner reached it. */
const outboxScans = (plan: PlanNode): PlanNode[] =>
  flatten(plan).filter((n) => (n['Relation Name'] ?? '') === 'email_outbox');

/** Rows the executor actually pulled out of `email_outbox`, across every scan. */
const outboxRowsRead = (plan: PlanNode): number =>
  outboxScans(plan).reduce((n, s) => n + (s['Actual Rows'] ?? 0) * (s['Actual Loops'] ?? 0), 0);

/**
 * The count statement the repo issues, captured rather than restated.
 *
 * `retentionConsolePlan` gives the reason: the failure being guarded against is
 * a change to this query, so the query has to come from the thing that would
 * change. Restating it here would let the copy stay green while the repo's own
 * statement regressed.
 */
async function captureCountStatement(pool: pg.Pool): Promise<{ text: string; values: unknown[] }> {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    seen.push({ text, values: (args[1] as unknown[]) ?? [] });
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  try {
    await purgeExpiredOutbox(pool, RETENTION_DAYS, 1);
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
  const hit = seen.find((s) => /count\(\*\)/.test(s.text) && /email_outbox/.test(s.text));
  if (!hit) throw new Error(`purgeExpiredOutbox issued no held-count statement; saw ${seen.length}`);
  return hit;
}

describe.skipIf(!dbUp)('the outbox purge does not scan the backlog to count no holds (R290)', () => {
  let db: TestDb;
  let statement: { text: string; values: unknown[] };
  /** The same statement without the one-time hold check: what R289 shipped. */
  let ungated: string;

  const explain = async (sql: string, values: unknown[]): Promise<PlanNode> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
    return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    await db.pool.query(
      `INSERT INTO email_outbox (id, to_email, template_key, subject, body, status, attempts, created_at, sent_at)
       SELECT 'X' || upper(lpad(to_hex(g), 25, '0')), 'r' || g || '@x.y', 'test_template',
              'S', 'B', 'sent', 1,
              now() - ((${RETENTION_DAYS} + 1 + (g % 400)) || ' days')::interval,
              now() - ((${RETENTION_DAYS} + 1 + (g % 400)) || ' days')::interval
         FROM generate_series(1, ${MESSAGES}) g`,
    );
    await db.pool.query('ANALYZE email_outbox, legal_holds');

    statement = await captureCountStatement(db.pool);
    ungated = statement.text.replace(/EXISTS \(SELECT 1 FROM legal_holds lh WHERE lh\.active\)\s*AND\s+/, '');
    if (ungated === statement.text)
      throw new Error(
        'cannot rebuild the R289 spelling: the count no longer carries the one-time hold check',
      );
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a backlog big enough for a scan of it to be unmistakable', async () => {
    // Vacuity guard. "Reads no rows" is true of an empty table, and the
    // discriminator below is the only thing that can tell that apart from the
    // fix — but it can only do so if there is something to read.
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_outbox
        WHERE created_at < now() - '${RETENTION_DAYS} days'::interval AND status <> 'queued'`,
    );
    // One short of the seed: capturing the statement ran a real purge with a
    // batch of one, which is the cheapest way to get the repo's own SQL out.
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(MESSAGES - 1);
    // And no hold, which is the condition the whole file is about.
    const { rows: holds } = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM legal_holds WHERE active',
    );
    expect(Number(holds[0]!.n)).toBe(0);
  });

  it('never enters the outbox scan when no hold is active', async () => {
    const plan = await explain(statement.text, statement.values);
    expect(outboxScans(plan).length, 'the count no longer reads email_outbox at all').toBeGreaterThan(0);
    for (const scan of outboxScans(plan)) expect(scan['Actual Loops'] ?? -1).toBe(0);
    expect(outboxRowsRead(plan)).toBe(0);
  });

  it('the ungated spelling reads the whole eligible backlog', async () => {
    // The discriminator. R289's statement is correct and slow; if this stops
    // failing, the assertion above has stopped meaning anything.
    const plan = await explain(ungated, statement.values);
    expect(outboxRowsRead(plan)).toBeGreaterThanOrEqual(MESSAGES - 1);
  });

  it('still counts what a hold holds, once one exists', async () => {
    // The gate is a short circuit and not a different question. With a global
    // hold in place the InitPlan is true, the scan runs, and the answer is the
    // one the ungated spelling gives — which is what makes the skip safe.
    await db.pool.query(
      `INSERT INTO legal_holds (id, scope, reference_id, reason, active, placed_by)
       VALUES ('H' || upper(lpad(to_hex(1), 25, '0')), 'global', NULL, 'IRS audit', true, NULL)`,
    );
    try {
      const { skippedHold } = await purgeExpiredOutbox(db.pool, RETENTION_DAYS, 1);
      expect(skippedHold).toBeGreaterThanOrEqual(MESSAGES - 1);
      const plan = await explain(statement.text, statement.values);
      expect(outboxRowsRead(plan)).toBeGreaterThanOrEqual(MESSAGES - 1);
    } finally {
      await db.pool.query('UPDATE legal_holds SET active = false');
    }
  });
});
