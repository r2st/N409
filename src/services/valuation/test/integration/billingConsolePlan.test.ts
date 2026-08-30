import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingSummary } from '../../src/repos/billing.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Rows per ledger. Enough that reading one end to end is measurably wrong. */
const ROWS = 20_000;

/**
 * The admin billing console's third statement, which nothing was measuring.
 *
 * `growthScanPlans` covers the two lists on that page — `listAllSubscriptions`
 * and `listAllInvoices` both reach the `ORDER BY` indexes 0178 added. It does
 * not cover `billingSummary`, and `listQueryScaling` does not reach the page at
 * all: its fixture grows *valuations*, and no number of engagements adds a
 * subscription or an invoice, so the endpoint could not have been measured
 * there without a green check that proved nothing.
 *
 * That leaves the one figure on the page whose cost is a whole table, on the
 * surface R240 rebuilt. Two separate properties hold it up, and they are
 * asserted separately because they degrade for different reasons.
 *
 * ## The subscription half is bounded by the customers being served
 *
 * `active`, `trialing`, `past_due` and the MRR sum are four reads of
 * `subscriptions`, and all four ask for the same set: the statuses migration
 * 0080's partial unique index (`subscriptions_one_active_per_user`) is built
 * over. So they cost the number of *live* subscriptions rather than the number
 * this platform has ever held — which matters precisely because the two
 * diverge: every cancellation leaves its row behind for ever, so the served
 * share falls with age, and a plan that scanned the table would get slower on
 * exactly the history that makes the index more selective.
 *
 * The seed below is a served minority among cancellations for that reason. A
 * fixture of all-active rows (which is what `growthScanPlans` needs for its own
 * question) makes the partial index cover the whole table, and then a sequential
 * scan and an index scan cost the same and the assertion cannot fail.
 *
 * ## The invoice half is a lifetime total, read once
 *
 * `gross_cents` and `refunded_cents` are every paid invoice ever raised. No
 * index answers that and none is expected to; the property that *is* worth
 * holding is that the table is read **once** for all four money figures. The
 * `collected` CTE exists to make that true — the two lifetime sums and the two
 * month windows are all `CTE Scan`s over one pass — and the regression is not a
 * missing index but somebody inlining the CTE back into four subqueries, which
 * reads `invoices` four times for the same answer. `INLINED_SPELLING` below is
 * that version, run alongside as the discriminator.
 */
interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'CTE Name'?: string;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/** `upper(to_hex(n))` zero-padded is a ULID: uppercase hex ⊂ Crockford base32. */
const ULID = (expr: string) => `upper(lpad(to_hex(${expr}), 26, '0'))`;

/**
 * The four money figures with the shared pass taken away — the same answers,
 * spelled as four independent reads of `invoices`.
 *
 * Not a query anybody runs. It is here so `reads the invoice ledger once` has
 * something to fail against: without it that assertion is one node count on a
 * plan nobody would notice changing.
 */
const INLINED_SPELLING = `
  WITH bounds AS (
    SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AS this_month,
           date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month' AS prev_month
  )
  SELECT
    (SELECT coalesce(sum(amount_cents), 0) FROM invoices WHERE status = 'paid') AS gross_cents,
    (SELECT coalesce(sum(least(refunded_cents, amount_cents)), 0)
       FROM invoices WHERE status = 'paid') AS refunded_cents,
    (SELECT coalesce(sum(amount_cents - least(refunded_cents, amount_cents)), 0)
       FROM invoices, bounds
      WHERE status = 'paid'
        AND coalesce(paid_at, issued_at) AT TIME ZONE 'UTC' >= bounds.this_month) AS month_cents,
    (SELECT coalesce(sum(amount_cents - least(refunded_cents, amount_cents)), 0)
       FROM invoices, bounds
      WHERE status = 'paid'
        AND coalesce(paid_at, issued_at) AT TIME ZONE 'UTC' >= bounds.prev_month
        AND coalesce(paid_at, issued_at) AT TIME ZONE 'UTC' < bounds.this_month) AS prev_month_cents`;

describe.skipIf(!dbUp)('the billing console summary costs its live customers, not its history', () => {
  let db: TestDb;
  let nodes: PlanNode[] = [];
  let inlinedNodes: PlanNode[] = [];

  beforeAll(async () => {
    db = await setupTestDb();
    const q = (text: string, values: unknown[] = []) => db.pool.query(text, values);

    await q(
      `INSERT INTO users (id, email, password_digest)
       SELECT ${ULID('g')}, 'u' || g || '@x.y', 'x' FROM generate_series(1, ${ROWS}) g`,
    );
    // A served minority among the accounts that have come and gone. `canceled`
    // rows are outside the partial index, which is the whole point of it.
    await q(
      `INSERT INTO subscriptions (id, user_id, plan_tier, status, created_at)
       SELECT ${ULID('g')}, ${ULID('g')}, 'annual_retainer',
              CASE WHEN g % 25 = 0 THEN 'active'
                   WHEN g % 25 = 1 THEN 'trialing'
                   WHEN g % 25 = 2 THEN 'past_due'
                   ELSE 'canceled' END,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    // Mostly settled, a minority refunded, spread across this month and the
    // ones before it so both windows have something to find.
    await q(
      `INSERT INTO invoices (id, number, user_id, amount_cents, refunded_cents, status,
                             line_items, issued_at, paid_at)
       SELECT ${ULID('g')}, 'INV-' || g, ${ULID('g')}, 1000,
              CASE WHEN g % 50 = 0 THEN 400 ELSE 0 END,
              CASE WHEN g % 10 = 0 THEN 'open' ELSE 'paid' END,
              '[]'::jsonb,
              now() - (g || ' minutes')::interval,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q('ANALYZE');

    // The statement the repository issues, so what is explained is what runs.
    let captured: string | null = null;
    const original = db.pool.query.bind(db.pool);
    (db.pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      if (/collected AS \(/.test(text)) captured = text;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await billingSummary(db.pool);
    } finally {
      (db.pool as unknown as { query: unknown }).query = original;
    }
    if (!captured) throw new Error('billingSummary issued no statement carrying the shared pass');

    const explain = async (sql: string): Promise<PlanNode[]> => {
      const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      return flatten((rows[0]! as { 'QUERY PLAN': Array<{ Plan: PlanNode }> })['QUERY PLAN'][0]!.Plan);
    };
    nodes = await explain(captured);
    inlinedNodes = await explain(INLINED_SPELLING);
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a served minority, so the partial index is the smaller thing to read', async () => {
    // Vacuity guard. Every assertion below is true of an empty table, and the
    // index one is also true of a table where every row is served.
    const { rows } = await db.pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM subscriptions) AS total,
              (SELECT count(*) FROM subscriptions
                WHERE status IN ('active', 'trialing', 'past_due')) AS served,
              (SELECT count(*) FROM invoices WHERE status = 'paid') AS paid`,
    );
    const counts = rows[0]!;
    expect(Number(counts.total)).toBe(ROWS);
    expect(Number(counts.served)).toBe((ROWS / 25) * 3);
    expect(Number(counts.served)).toBeLessThan(Number(counts.total) / 4);
    expect(Number(counts.paid)).toBeGreaterThan(ROWS / 2);
  });

  it('never reads the subscription table end to end', () => {
    const scanned = nodes
      .filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'subscriptions')
      .map((n) => n['Node Type']);
    expect(scanned).toEqual([]);
  });

  it('answers every served-status figure from the partial index', () => {
    const onSubscriptions = nodes.filter((n) => n['Relation Name'] === 'subscriptions');
    // Three counts and the MRR sum.
    expect(onSubscriptions.length).toBe(4);
    for (const node of onSubscriptions) {
      expect(node['Index Name'], JSON.stringify(node)).toBe('subscriptions_one_active_per_user');
    }
  });

  it('reads the invoice ledger once for all four money figures', () => {
    const invoiceScans = nodes.filter((n) => n['Relation Name'] === 'invoices');
    expect(invoiceScans.length).toBe(1);
    // And the other three figures come off that one pass rather than repeating it.
    expect(nodes.filter((n) => n['CTE Name'] === 'collected').length).toBeGreaterThan(1);
  });

  it('and the inlined spelling reads it four times, so the count above can fail', () => {
    expect(inlinedNodes.filter((n) => n['Relation Name'] === 'invoices').length).toBe(4);
  });
});
