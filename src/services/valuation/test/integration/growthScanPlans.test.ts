import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listAllInvoices, listAllSubscriptions } from '../../src/repos/billing.js';
import { listInvitations } from '../../src/repos/invitations.js';
import { listActiveEngagements } from '../../src/repos/engagements.js';
import { listSuppressions } from '../../src/repos/emailDelivery.js';
import { listJobs } from '../../src/repos/jobs.js';
import { listValuations as listDebtValuations } from '../../src/repos/debtInstruments.js';
import { listEnabledMonitors } from '../../src/repos/monitors.js';
import { listUnfiledDocuments } from '../../src/repos/documents.js';
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
  /**
   * Block ceiling for the driving scan, when the shared one does not apply.
   *
   * A BLOCK COUNT IS A PROPERTY OF THE CORPUS, NOT OF THE QUERY (R283). The
   * shared bound of 200 works for every case whose predicate keeps most of the
   * table, because there the index scan and the rows it wants are the same
   * thing. It does not hold for a *selective* one: `listUnfiledDocuments` keeps
   * one row in twenty, scattered a row at a time across the heap, so each of
   * the 200 it returns is its own heap block — and at this seed the whole
   * `documents` table is smaller than that. The index still wins where it
   * matters, and by more the bigger the table gets (at 300k documents,
   * 26.05ms/300,000 rows against 5.50ms/500); it is the *level* that is
   * meaningless at 20k, not the fix.
   *
   * Raising it does not weaken the case. The plan without the index is a
   * parallel seq scan discarding nineteen rows in twenty, which fails both
   * `does not sequentially scan` and `discards nothing` before it reaches here.
   */
  maxBlocks?: number;
  run: (db: TestDb) => Promise<{ text: string; values: unknown[] }>;
}

const OWNER = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
/** The one instrument whose whole pricing history the seed piles up. */
const INSTRUMENT = 'DDDDDDDDDDDDDDDDDDDDDDDDDD';

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
      // R231. Not a list with a bad ORDER BY but a *merge* with one: the
      // Published Tasks page is a UNION ALL over five queue tables ordered by
      // `created_at DESC`, which Postgres plans as a Merge Append that stops as
      // soon as it has a page. It can only do that if every branch is walkable
      // backwards on `created_at`, and four of the five had that column only as
      // the second half of a composite led by `valuation_id`. One unindexed
      // branch stalls the whole merge — it is read in full and sorted before
      // the merge can produce its first row — which is why this case explains
      // the page query and looks at `ai_jobs`. Measured at 300k outbox rows:
      // 37.3ms with an 8MB external merge sort, 0.23ms with 0189.
      name: 'listJobs',
      table: 'ai_jobs',
      index: 'ai_jobs_created_idx',
      run: captured(/ORDER BY j\.created_at DESC/, (d) => listJobs(d.pool, { page: 1, perPage: 25 })),
    },
    {
      // R283. The fifth table with this shape, and found by an asymmetry rather
      // than by a sweep: `fund_marks` — the same append-only measurement trail
      // on the other half of the same surface, read by the same page ordering —
      // has carried `(position_id, measurement_date DESC)` since 0086, and debt
      // never got its counterpart. 0087 indexed `(instrument_id, created_at
      // DESC)`, which is a different question: `POST /value` takes the
      // measurement date as a parameter, so a quarter entered late sits
      // somewhere other than where it was inserted, and ordering by
      // `valuation_date` is the whole reason the report and the screen agree
      // about which measurement is current. Measured at 810 runs on one
      // instrument: 7.74ms/81 blocks against 0.06ms/7 with 0198.
      name: 'listValuations (debt)',
      table: 'debt_valuations',
      index: 'debt_valuations_instrument_measured_idx',
      run: captured(/FROM debt_valuations/i, (d) => listDebtValuations(d.pool, INSTRUMENT)),
    },
    {
      // R298. The sixth and seventh tables with this shape, and both found the
      // way R283's was — by the sibling rather than by a sweep. Every other
      // console list on the platform got its ordering index in 0170, 0181,
      // 0189, 0192 or 0193; `valuation_monitors` carried nothing but its
      // primary key and the UNIQUE on `valuation_id`, so a page of the
      // monitoring dashboard was a seq scan of every monitor hash-joined to a
      // seq scan of every live engagement, top-N sorted. 10.56ms and 40,000
      // rows read at 20k monitors, against 3.18ms and 1,002 with 0199.
      name: 'listEnabledMonitors',
      table: 'valuation_monitors',
      index: 'valuation_monitors_enabled_recent_idx',
      run: captured(/FROM valuation_monitors/i, (d) => listEnabledMonitors(d.pool, { limit: 200 })),
    },
    {
      // R298. The same shape hiding behind a *selective* predicate, which is
      // why no round had looked at it: the unfiled queue keeps a few thousand
      // rows, so its sort is small and looks cheap. The cost is the 295,000
      // rows discarded to find them — `documents` has the least reason of any
      // table here ever to stop growing, and every one of its indexes leads
      // with `valuation_id` or `uploaded_by`, neither of which this queue has.
      // Paid twice per page load, because `countUnfiledDocuments` is rendered
      // beside the list and repeats the scan. 26.05ms and 300,000 rows read at
      // 300k documents, against 5.50ms and 500 with 0199 — and the `Sort` node
      // disappears rather than getting cheaper, because the index is already in
      // the queue's oldest-first order.
      name: 'listUnfiledDocuments',
      table: 'documents',
      index: 'documents_unfiled_idx',
      maxBlocks: 800,
      run: captured(/FROM documents/i, (d) => listUnfiledDocuments(d.pool, { limit: 200 })),
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
    // One instrument priced over and over, which is what an instrument held to
    // maturity looks like: `debt_valuations` is append-only and every re-price
    // appends. The measurement dates deliberately do not follow the insertion
    // order — that is the difference between 0087's index and 0198's.
    await q(
      `INSERT INTO debt_instruments (id, name, instrument_type, currency, params)
       VALUES ($1, 'Ten-year note', 'bond', 'USD', '{}'::jsonb)`,
      [INSTRUMENT],
    );
    await q(
      `INSERT INTO debt_valuations (id, instrument_id, valuation_date, inputs, result, fair_value, created_at)
       SELECT ${ULID('g')}, $1, (date '2015-01-01' + ((g * 7919) % 4000))::date,
              '{}'::jsonb, '{}'::jsonb, 900000 + g, now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
      [INSTRUMENT],
    );
    // One monitor per engagement, which is the most there can ever be
    // (`valuation_monitors_valuation_id_key`), all enabled: the dashboard's
    // predicate keeps nearly everything, which is what made the seq scan
    // expensive rather than selective.
    await q(
      `INSERT INTO valuation_monitors (id, valuation_id, enabled, baseline, created_by, created_at)
       SELECT ${ULID('g')}, ${ULID('g')}, true, '{}'::jsonb, $1,
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
      [OWNER],
    );
    // The opposite share to the monitors, and it is the point of this case: a
    // document the platform knows nothing about on either axis is a minority of
    // uploads. A selective predicate is what makes the sort look cheap and the
    // scan behind it invisible.
    await q(
      `INSERT INTO documents (id, valuation_id, kind, category, filename, content_type,
                              size_bytes, sha256, storage_path, created_at)
       SELECT ${ULID('g')}, ${ULID('g')},
              (CASE WHEN g % 20 = 0 THEN 'other' ELSE 'cap_table' END)::document_kind,
              (CASE WHEN g % 20 = 0 THEN 'uploads' ELSE 'captable_documents' END)::document_category,
              'f' || g || '.pdf', 'application/pdf', 1000, md5(g::text), '/x/' || g,
              now() - (g || ' minutes')::interval
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
              (SELECT count(*) FROM ai_jobs) AS jobs_total,
              (SELECT count(*) FROM email_suppressions WHERE released_at IS NULL) AS held,
              (SELECT count(*) FROM debt_valuations) AS debt_runs,
              (SELECT count(*) FROM valuation_monitors WHERE enabled) AS monitors,
              (SELECT count(*) FROM documents) AS documents_total,
              (SELECT count(*) FROM documents
                WHERE deleted_at IS NULL AND category = 'uploads' AND kind = 'other') AS unfiled`,
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
    // The jobs feed reads whichever branch has the newest rows, so the seed
    // has to give it more than a page of them to have anything to stop at.
    expect(Number(counts.jobs_total)).toBe(ROWS);
    // The opposite of selective, and deliberately so: 0183's index is plain
    // because this predicate keeps almost everything.
    expect(Number(counts.held)).toBe(ROWS - ROWS / 20);
    // All on one instrument: the page is fifty of them however many there are,
    // which is what makes reading the rest of the trail waste.
    expect(Number(counts.debt_runs)).toBe(ROWS);
    // Every engagement monitored, because that is the ceiling and the dashboard
    // filter keeps nearly all of it — the seq scan this replaced was expensive
    // for being unselective, not for being wrong.
    expect(Number(counts.monitors)).toBe(ROWS);
    // And the unfiled queue the other way round: a minority of a table that
    // must be big enough for the discarded majority to be the cost.
    expect(Number(counts.documents_total)).toBe(ROWS);
    expect(Number(counts.unfiled)).toBe(ROWS / 20);
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
      expect(blocks(scan)).toBeLessThan(c.maxBlocks ?? 200);
    },
  );
});
