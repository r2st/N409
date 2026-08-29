import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { deliveryStats, deliveryStatsByTemplate } from '../../src/repos/emailDelivery.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Enough mail, spread over enough days, that the dashboard's default window is
 * a minority of the table. With everything inside the window the range scan is
 * the whole index and covering it proves nothing.
 */
const ROWS = 60_000;
const SPAN_DAYS = 120;
const WINDOW_DAYS = 30;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Heap Fetches'?: number;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/** Captures the statement a repo issues, so what is explained is what runs. */
function tap(pool: pg.Pool): {
  seen: Array<{ text: string; values: unknown[] }>;
  restore: () => void;
} {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    seen.push({
      text: typeof first === 'string' ? first : ((first as { text?: string })?.text ?? ''),
      values: (args[1] as unknown[]) ?? [],
    });
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return { seen, restore: () => ((pool as unknown as { query: unknown }).query = original) };
}

/**
 * R202. The email dashboard's two window aggregates must be answered by the
 * index alone.
 *
 * `email_outbox_delivery_stats_idx` exists for exactly these two readers and
 * carries their columns in its INCLUDE list. That arrangement has a failure
 * mode worth a standing test: it breaks when the *query* changes, not when the
 * index does. A count added over a column the INCLUDE list lacks — which is how
 * `bounce_kind` and `template_key` came to be missing — leaves the index still
 * named in the plan and the answers still right, and turns an Index Only Scan
 * into an Index Scan that visits the heap once per row of the window.
 *
 * So the assertion is `Heap Fetches: 0`, not the index name. The name survives
 * the regression; the heap fetches are the regression.
 */
describe.skipIf(!dbUp)('the delivery dashboard reads its index, not the heap (R202)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
    await db.pool.query(
      `INSERT INTO email_outbox
         (id, template_key, to_email, subject, body, status,
          created_at, delivered_at, bounced_at, bounce_kind, first_opened_at)
       SELECT ('04' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              'tpl-' || (g % 40),
              'to' || g || '@example.test', 'subject ' || g, 'body ' || g,
              (ARRAY['sent','sent','sent','sent','sent',
                     'sent','sent','sent','queued','failed'])[1 + g % 10]::email_status,
              now() - (g * interval '${SPAN_DAYS} days' / ${ROWS}),
              CASE WHEN g % 10 < 8 THEN now() - (g * interval '${SPAN_DAYS} days' / ${ROWS}) END,
              CASE WHEN g % 50 = 0 THEN now() END,
              CASE WHEN g % 50 = 0 THEN 'hard'::email_bounce_kind END,
              CASE WHEN g % 4 = 0 THEN now() END
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    // VACUUM as well as ANALYZE: an index-only scan needs the visibility map,
    // which VACUUM sets and ANALYZE does not, so without this the planner costs
    // every one of these plans with heap fetches it would not actually make.
    await db.pool.query('VACUUM ANALYZE email_outbox');
  }, 120_000);

  afterAll(async () => db?.teardown());

  async function planOf(run: () => Promise<unknown>): Promise<PlanNode[]> {
    const t = tap(db.pool);
    try {
      await run();
    } finally {
      t.restore();
    }
    // The repo issues more than one statement; the one under test is the one
    // that reads `email_outbox`.
    const stmt = t.seen.find((s) => /FROM email_outbox/.test(s.text));
    expect(stmt, 'the repo issued no statement against email_outbox').toBeDefined();
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${stmt!.text}`, stmt!.values);
    return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
  }

  const onlyScans = (nodes: PlanNode[]): PlanNode[] =>
    nodes.filter((n) => n['Node Type'] === 'Index Only Scan');

  it('deliveryStats never visits the heap', async () => {
    const nodes = await planOf(() => deliveryStats(db.pool, WINDOW_DAYS));
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
    const scans = onlyScans(nodes);
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans) expect(s['Heap Fetches']).toBe(0);
    expect(scans.map((s) => s['Index Name'])).toContain('email_outbox_delivery_stats_idx');
  });

  it('deliveryStatsByTemplate never visits the heap', async () => {
    const nodes = await planOf(() => deliveryStatsByTemplate(db.pool, WINDOW_DAYS));
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
    const scans = onlyScans(nodes);
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans) expect(s['Heap Fetches']).toBe(0);
    expect(scans.map((s) => s['Index Name'])).toContain('email_outbox_delivery_stats_idx');
  });

  /**
   * The discriminator, and the thing that actually decays: the INCLUDE list
   * against the columns the two statements name. `Heap Fetches: 0` above can be
   * satisfied by an unrelated index the planner happens to prefer; this asks
   * the catalog directly whether the index still carries what the queries read.
   */
  it('the index carries every column the two statements read', async () => {
    const t = tap(db.pool);
    try {
      await deliveryStats(db.pool, WINDOW_DAYS);
      await deliveryStatsByTemplate(db.pool, WINDOW_DAYS);
    } finally {
      t.restore();
    }
    const sql = t.seen
      .filter((s) => /FROM email_outbox/.test(s.text))
      .map((s) => s.text)
      .join('\n');
    expect(sql).not.toBe('');

    const { rows: cols } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'email_outbox'`,
    );
    // Every column of the table that either statement actually mentions.
    const read = cols.map((c) => c.column_name).filter((c) => new RegExp(`\\b${c}\\b`).test(sql));
    expect(read).toContain('bounce_kind');
    expect(read).toContain('template_key');

    // The definition rather than `pg_index.indkey`, because the columns at
    // issue are in the INCLUDE list and reading those out of the catalog means
    // knowing where `indnkeyatts` divides the vector. The definition names both
    // halves and is what a reviewer would read.
    const { rows: idx } = await db.pool.query<{ def: string }>(
      `SELECT pg_get_indexdef('email_outbox_delivery_stats_idx'::regclass) AS def`,
    );
    const def = idx[0]!.def;
    const missing = read.filter((c) => !new RegExp(`\\b${c}\\b`).test(def));
    expect(missing, `not carried by email_outbox_delivery_stats_idx: ${missing.join(', ')}`).toEqual([]);
  });
});
