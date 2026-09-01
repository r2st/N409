import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimRetryableEmails } from '../../src/repos/emailOutbox.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Messages in the outbox, and the share of them the sweep is eligible to claim. */
const TOTAL = 40000;
const CLAIMABLE = 2000;
/** What one tick asks for. `EMAIL_CLAIM_BATCH`-shaped; the point is that it is small. */
const BATCH = 50;

/**
 * The outbox sweep must cost the batch, not the backlog.
 *
 * `claimRetryableEmails` runs on a timer on every instance. Its LIMIT bounded
 * the answer and not the work: `status IN ('failed','queued')` reached
 * `email_outbox_claim_idx` as an index *condition*, but two status values are
 * two index ranges and neither is in `created_at` order, so `ORDER BY created_at
 * ASC` was a sort above the scan — and a sort cannot stop. Every eligible row in
 * the queue was read and sorted to choose fifty.
 *
 * 0201's `email_outbox_claimable_idx (created_at) WHERE status IN
 * ('failed','queued')` holds them in the order the claim wants, so the scan
 * walks oldest-first and stops. What is asserted is rows of `email_outbox`
 * touched, as a difference: grow the backlog and the number must not move. The
 * discriminator is 0201's index dropped inside a rolled-back transaction, which
 * is the only form of the question that fails if the migration is reverted.
 */
interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
  [k: string]: unknown;
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/** Rows of `email_outbox` the plan touched, filtered-away ones included. */
const outboxRows = (plan: PlanNode): number =>
  flatten(plan)
    .filter((n) => (n['Relation Name'] ?? '') === 'email_outbox')
    // The final `UPDATE ... FROM claimable` re-reads the chosen rows by primary
    // key, which is the batch and not the backlog; only the CTE's scan is the
    // subject here, and it is the one that is not a pkey lookup.
    .filter((n) => !/pkey/.test(String(n['Index Name'] ?? '')))
    .reduce((n, s) => n + Number(s['Actual Rows'] ?? 0) + Number(s['Rows Removed by Filter'] ?? 0), 0);

const ULID = (expr: string, prefix: string) =>
  `'${prefix}' || upper(lpad(to_hex(${expr}), ${26 - prefix.length}, '0'))`;

describe('the claim predicate and 0201 are the same sentence', () => {
  // A partial index is reachable only when the planner can prove the query
  // implies its predicate, so these two spellings are load-bearing in a way no
  // type or test of behaviour can see: respell either and the index silently
  // stops being used, with every answer still correct.
  const PREDICATE = "status IN ('failed', 'queued')";
  it('is spelled the same way in the repo and in the migration', () => {
    const repo = readFileSync(path.join(HERE, '../../src/repos/emailOutbox.ts'), 'utf8');
    const migration = readFileSync(
      path.join(HERE, '../../migrations/0201_email_claim_stops_at_the_batch.sql'),
      'utf8',
    );
    expect(repo).toContain(PREDICATE);
    expect(migration).toContain(PREDICATE);
  });
});

describe.skipIf(!dbUp)('the outbox claim stops at the batch (R306)', () => {
  let db: TestDb;
  let statement = '';
  let values: unknown[] = [];

  const explain = async (sql: string, params: unknown[], without?: string): Promise<PlanNode> => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (without) await client.query(`DROP INDEX ${without}`);
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
    } finally {
      // Rolled back either way — the statement under test is an UPDATE, and it
      // must not consume the fixture it is measured against.
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  };

  const seed = async (from: number, to: number) => {
    await db.pool.query(
      `INSERT INTO email_outbox (id, to_email, channel, template_key, subject, body, status, attempts, created_at)
       SELECT ${ULID('g', 'F')}, 'to' || g || '@example.test', 'email', 'notification',
              'Subject ' || g, 'Body',
              -- A backlog is mostly settled mail with a live tail through it.
              -- 5% eligible, scattered through the history: a backlog is a
              -- live tail through mostly-settled mail, and the density is what
              -- decides whether the planner can find a stopping scan without
              -- 0201's index. Make it a third and it finds one anyway.
              CASE WHEN g % 20 = 0 THEN 'failed' ELSE 'sent' END::email_status, 1,
              now() - (g || ' minutes')::interval
         FROM generate_series(${from}, ${to}) g`,
    );
  };

  beforeAll(async () => {
    db = await setupTestDb();
    await seed(1, TOTAL);
    await db.pool.query('ANALYZE email_outbox');

    // The statement comes off the repo rather than being retyped, so a rewrite
    // is measured rather than silently unmeasured.
    const orig = db.pool.query.bind(db.pool);
    (db.pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      if (/email_outbox/.test(text) && !statement) {
        statement = text;
        values = (args[1] as unknown[]) ?? [];
      }
      return (orig as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await claimRetryableEmails(db.pool, { channels: ['email'], maxAttempts: 5, limit: BATCH });
    } finally {
      (db.pool as unknown as { query: unknown }).query = orig;
    }
    if (!statement) throw new Error('the claim issued no statement this recognises');
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a backlog larger than the batch, or nothing below is a claim', async () => {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_outbox WHERE status IN ('failed', 'queued')`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(CLAIMABLE - 1);
  });

  it('reads the batch, not the queue, and goes on doing so as the queue grows', async () => {
    const now = await explain(statement, values);
    // A little slack over the batch for the rows the per-row filters discard.
    expect(outboxRows(now)).toBeLessThan(BATCH * 4);
    // The discriminator: without 0201 the same statement reads the eligible
    // backlog and sorts it, which is more than a batch by an order of magnitude.
    const before = await explain(statement, values, 'email_outbox_claimable_idx');
    expect(before['Node Type']).toBeTypeOf('string');
    expect(outboxRows(before)).toBeGreaterThan(CLAIMABLE);

    /*
     * And the claim of the file, stated as a difference rather than a level:
     * triple the backlog and the work must not move. The old plan's must.
     *
     * The difference is what is asserted because the *level* depends on the
     * fixture in a way the defect does not. At a third of the table eligible,
     * the planner finds a stopping walk of `email_outbox_delivery_stats_idx`
     * — created_at DESC over the whole table, read backwards — without 0201's
     * index at all, and the discriminator passes vacuously. Five percent is a
     * backlog's density, and at five percent it takes the bitmap.
     */
    await seed(TOTAL + 1, TOTAL * 3);
    await db.pool.query('ANALYZE email_outbox');
    const deeper = await explain(statement, values);
    const deeperBefore = await explain(statement, values, 'email_outbox_claimable_idx');
    expect(outboxRows(deeper)).toBeLessThan(BATCH * 4);
    expect(outboxRows(deeperBefore)).toBeGreaterThan(outboxRows(before) * 2);
  });

  it('claims the same oldest rows either way', async () => {
    // Answers-match. A faster plan that claims a different fifty is not a
    // performance fix — the ordering is the fairness rule that keeps the
    // earliest failures from sitting behind the newest ones forever.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: after } = await client.query<{ id: string }>(statement, values);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('DROP INDEX email_outbox_claimable_idx');
      const { rows: before } = await client.query<{ id: string }>(statement, values);
      await client.query('ROLLBACK');
      expect(after.length).toBe(BATCH);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    } finally {
      client.release();
    }
  });
});
