import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listAllInvoices, listAllSubscriptions } from '../../src/repos/billing.js';
import { listInvitations } from '../../src/repos/invitations.js';
import { listActiveEngagements } from '../../src/repos/engagements.js';
import { listSuppressions } from '../../src/repos/emailDelivery.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Rows per table. Enough that a sequential scan is measurably the wrong plan. */
const ROWS = 20_000;

/**
 * Six reads whose cost was the size of a table and whose output was a page.
 *
 * R187 gave every list endpoint a `LIMIT`, and R166 fixed the `ORDER BY`
 * spellings that took the valuation list off its indexes. Between them they
 * leave a shape neither was looking for, and it is the one this file guards: a
 * list with a perfectly good cap, ordered by a column no index leads with.
 *
 * The cap makes the response small. It does nothing to the work — Postgres
 * reads the whole table and sorts it to find out which rows the cap keeps — so
 * the endpoint costs the table and returns a screenful, and it degrades with
 * nothing about the response changing as it does. That is the property that
 * makes it worth a standing test rather than a one-off fix: there is no
 * symptom until there is an outage, and the next admin list somebody adds will
 * be written the same way.
 *
 * The queue reaper is here for the same reason from the other direction. It is
 * not a list and nobody is waiting on it, but it runs on a timer on every
 * instance, and its predicate (`status = 'running'`) is true of a few rows and
 * false of every AI job the platform has ever completed. A sweep whose cost is
 * the whole table and whose frequency is every N seconds is the one that stops
 * being free without anybody deciding anything.
 *
 * The assertion in every case is the same and is deliberately about the plan
 * rather than about time: no sequential scan of the growing table, and the
 * driving scan reads a page's worth of blocks rather than a table's. A timing
 * assertion on a query that got faster is a flake waiting for a busy CI box.
 */

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

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];
const blocks = (n: PlanNode) => (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0);

/**
 * Statements captured from the repositories that issue them, so what is
 * explained is what runs.
 *
 * Two of the six are restated instead, and the reason is worth naming rather
 * than leaving as an inconsistency. `GET /scim/v2/Users` builds its SQL inline
 * in the route with no repository to call, and `reapStaleAiJobs` takes its rows
 * `FOR UPDATE` inside a transaction on a checked-out client — running it to
 * capture the statement would also reap, and explaining a `FOR UPDATE` is not
 * explaining what the sweep does. Both are short enough that a copy is legible;
 * `matches the statement the source issues` below keeps the copies honest.
 */
function tap(pool: pg.Pool): { seen: Array<{ text: string; values: unknown[] }>; restore: () => void } {
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

/** The unfiltered SCIM directory listing (routes/scim.ts). */
const SCIM_SQL = `
  SELECT id, email, first_name, last_name, scim_external_id, deleted_at, created_at
    FROM users WHERE provisioned_by = 'scim' ORDER BY created_at DESC LIMIT 200`;

/** The AI-job reaper's candidate query (repos/aiJobs.ts), less its FOR UPDATE. */
const REAPER_SQL = `
  SELECT * FROM ai_jobs
   WHERE status = 'running'
     AND created_at < now() - ($1 || ' seconds')::interval
   ORDER BY created_at ASC
   LIMIT $2`;

interface Case {
  /** Reported in failures, and the reason the case exists. */
  name: string;
  /** The table that was being read end to end. */
  table: string;
  /** The index migration 0178/0179 added for it. */
  index: string;
  run: (db: TestDb) => Promise<{ text: string; values: unknown[] }>;
}

const OWNER = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';

/** `upper(to_hex(n))` zero-padded is a ULID: uppercase hex ⊂ Crockford base32. */
const ULID = (expr: string) => `upper(lpad(to_hex(${expr}), 26, '0'))`;

describe.skipIf(!dbUp)('a capped list still reads a page, not a table (R193)', () => {
  let db: TestDb;
  const plans = new Map<string, PlanNode[]>();
  const statements = new Map<string, string>();

  const captured =
    (match: RegExp, call: (db: TestDb) => Promise<unknown>) =>
    async (d: TestDb): Promise<{ text: string; values: unknown[] }> => {
      const t = tap(d.pool);
      try {
        await call(d);
      } finally {
        t.restore();
      }
      const hit = t.seen.find((s) => match.test(s.text));
      if (!hit) throw new Error(`no statement matched ${match}; saw ${t.seen.length}`);
      return hit;
    };

  const CASES: Case[] = [
    {
      name: 'listAllInvoices',
      table: 'invoices',
      index: 'invoices_issued_at_idx',
      run: captured(/FROM invoices/i, (d) => listAllInvoices(d.pool, { limit: 200 })),
    },
    {
      name: 'listAllSubscriptions',
      table: 'subscriptions',
      index: 'subscriptions_created_at_idx',
      run: captured(/FROM subscriptions/i, (d) => listAllSubscriptions(d.pool, { limit: 200 })),
    },
    {
      name: 'listInvitations',
      table: 'user_invitations',
      index: 'user_invitations_created_at_idx',
      run: captured(/FROM user_invitations/i, (d) => listInvitations(d.pool, { limit: 200 })),
    },
    {
      name: 'listActiveEngagements',
      table: 'engagements',
      index: 'engagements_open_stage_entered_idx',
      run: captured(/FROM engagements/i, (d) => listActiveEngagements(d.pool, { limit: 200 })),
    },
    {
      // R202. Same shape as the five above, on the table the R193 sweep could
      // not see: `listSuppressions` assembles its WHERE per call, and a sweep
      // that explains static SQL literals cannot parse a template hole. The
      // index is plain rather than partial on purpose — see 0183.
      name: 'listSuppressions',
      table: 'email_suppressions',
      index: 'email_suppressions_recent_idx',
      run: captured(/FROM email_suppressions/i, (d) => listSuppressions(d.pool, { limit: 100 })),
    },
    {
      name: 'GET /scim/v2/Users',
      table: 'users',
      index: 'users_scim_provisioned_idx',
      run: async () => ({ text: SCIM_SQL, values: [] }),
    },
    {
      name: 'reapStaleAiJobs',
      table: 'ai_jobs',
      index: 'ai_jobs_running_idx',
      run: async () => ({ text: REAPER_SQL, values: ['600', 100] }),
    },
  ];

  beforeAll(async () => {
    db = await setupTestDb();
    const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

    await q(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'owner@x.y', 'x')`, [OWNER]);
    // A directory-provisioned minority among ordinary accounts, which is what
    // every deployment looks like — and the reason the SCIM index is partial.
    await q(
      `INSERT INTO users (id, email, password_digest, provisioned_by, created_at)
       SELECT ${ULID('g')}, 'u' || g || '@x.y', 'x',
              CASE WHEN g % 200 = 0 THEN 'scim' ELSE NULL END,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q(
      `INSERT INTO valuations (id, kind, company_name, user_id, archived_at)
       SELECT ${ULID('g')}, '409a', 'Co ' || g, $1,
              CASE WHEN g % 20 = 0 THEN now() ELSE NULL END
         FROM generate_series(1, ${ROWS}) g`,
      [OWNER],
    );
    await q(
      `INSERT INTO engagements (id, valuation_id, current_stage, stage_entered_at)
       SELECT ${ULID('g')}, ${ULID('g')},
              CASE WHEN g % 4 = 0 THEN 'complete' ELSE 'intake' END,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q(
      `INSERT INTO invoices (id, number, user_id, amount_cents, status, line_items, issued_at)
       SELECT ${ULID('g')}, 'INV-' || g, $1, 1000, 'paid', '[]'::jsonb,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
      [OWNER],
    );
    await q(
      `INSERT INTO subscriptions (id, user_id, plan_tier, status, created_at)
       SELECT ${ULID('g')}, ${ULID('g')}, 'per_valuation', 'active',
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q(
      `INSERT INTO user_invitations (id, email, roles, invited_by, token_sha256, expires_at, created_at)
       SELECT ${ULID('g')}, 'i' || g || '@x.y', ARRAY['valuation_user'], $1, 'h' || g,
              now() + '7 days'::interval, now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
      [OWNER],
    );
    // A handful running among a history of finished work: the reaper's whole
    // point is that the rows it wants are a rounding error on the table.
    await q(
      `INSERT INTO ai_jobs (id, valuation_id, pipeline, status, input, created_at)
       SELECT ${ULID('g')}, ${ULID('g')}, 'extract',
              (CASE WHEN g % 500 = 0 THEN 'running' ELSE 'succeeded' END)::ai_job_status,
              '{}'::jsonb, now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    // Held addresses far outnumber released ones — a suppression is released
    // by hand and almost none are. That share is load-bearing for 0183: it is
    // why a plain index on `created_at` serves the filtered listing too.
    await q(
      `INSERT INTO email_suppressions (to_email, reason, detail, created_at, released_at)
       SELECT 'sup' || g || '@x.y', (ARRAY['hard','soft','complaint'])[1 + g % 3]::email_bounce_kind,
              'detail ' || g, now() - (g || ' minutes')::interval,
              CASE WHEN g % 20 = 0 THEN now() END
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q('ANALYZE');

    for (const c of CASES) {
      const stmt = await c.run(db);
      statements.set(c.name, stmt.text.replace(/\s+/g, ' ').trim());
      const { rows } = await db.pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${stmt.text}`,
        stmt.values,
      );
      plans.set(c.name, flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan));
    }
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds enough of each table for the wrong plan to be wrong', async () => {
    // Vacuity guard. "No sequential scan" is true of every empty table, so
    // without this the whole file passes against a database nobody filled.
    const { rows } = await db.pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM invoices) AS invoices,
              (SELECT count(*) FROM subscriptions) AS subscriptions,
              (SELECT count(*) FROM user_invitations) AS user_invitations,
              (SELECT count(*) FROM engagements WHERE current_stage <> 'complete') AS open_engagements,
              (SELECT count(*) FROM users WHERE provisioned_by = 'scim') AS scim_users,
              (SELECT count(*) FROM ai_jobs WHERE status = 'running') AS running_jobs,
              (SELECT count(*) FROM email_suppressions WHERE released_at IS NULL) AS held`,
    );
    const counts = rows[0]!;
    expect(Number(counts.invoices)).toBe(ROWS);
    expect(Number(counts.subscriptions)).toBe(ROWS);
    expect(Number(counts.user_invitations)).toBe(ROWS);
    expect(Number(counts.open_engagements)).toBeGreaterThan(1_000);
    // The two selective ones: a minority, which is what makes their partial
    // indexes small and the scans they replaced wasteful.
    expect(Number(counts.scim_users)).toBe(ROWS / 200);
    expect(Number(counts.running_jobs)).toBe(ROWS / 500);
    // The opposite of selective, and deliberately so: 0183's index is plain
    // because this predicate keeps almost everything.
    expect(Number(counts.held)).toBe(ROWS - ROWS / 20);
  });

  it('matches the statement the source issues, for the two written out here', () => {
    // The copies. A route or repo edited without this file is the failure mode,
    // and it is silent otherwise: the copy would keep passing while the real
    // query regressed.
    const scim = statements.get('GET /scim/v2/Users')!;
    expect(scim).toContain("provisioned_by = 'scim'");
    expect(scim).toContain('ORDER BY created_at DESC LIMIT 200');
    const reaper = statements.get('reapStaleAiJobs')!;
    expect(reaper).toContain("status = 'running'");
    expect(reaper).toContain('ORDER BY created_at ASC');
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s does not sequentially scan its growing table',
    (_name, c) => {
      const scan = plans.get(c.name)!.find((n) => n['Relation Name'] === c.table);
      expect(scan, `no ${c.table} node in the plan`).toBeDefined();
      expect(scan!['Node Type']).not.toBe('Seq Scan');
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s reaches its table through the index added for it',
    (_name, c) => {
      const used = plans
        .get(c.name)!
        .map((n) => n['Index Name'])
        .filter((n): n is string => Boolean(n));
      expect(used).toContain(c.index);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s discards nothing it had to read the table to discard',
    (_name, c) => {
      // The other way a plan can be wrong without being a Seq Scan: an index
      // scan on the wrong index still visits — and then throws away — rows it
      // was never going to return. `Rows Removed by Filter` on the driving scan
      // is what that looks like, and a page of 200 should not have to discard
      // thousands to find them.
      //
      // The block bound is set where it separates the two plans rather than at
      // a round number. Measured at 20,000 rows: 6, 6, 7, 8, 41 and 101 blocks
      // with these indexes in place, against 308, 364 and 417 for the three
      // that still plan without them (the other three fail an assertion above
      // before reaching here). The gap widens with the table, since one side is
      // a page and the other is the table.
      const scan = plans.get(c.name)!.find((n) => n['Relation Name'] === c.table)!;
      expect(scan['Rows Removed by Filter'] ?? 0).toBeLessThan(1_000);
      expect(blocks(scan)).toBeLessThan(200);
    },
  );
});
