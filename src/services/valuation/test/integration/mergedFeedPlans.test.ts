import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { listActivity } from '../../src/repos/activityLog.js';
import { dashboardActivity } from '../../src/repos/valuations.js';
import { mergeWindow } from '../../src/domain/pagination.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Two reverse-chronological feeds are merged from more than one table, and both
 * used to be written the obvious way: `UNION ALL` the branches, then
 * `ORDER BY occurred_at DESC LIMIT n` over the result. That is a scan of every
 * table in the union to produce one screen — and both tables are append-only
 * audit logs that nothing prunes, so the cost of rendering the *first* page
 * grows for the life of the product. R167 measured it at 63ms and 73ms on 220k
 * events and pushed the window into each branch (see `mergeWindow`).
 *
 * This is the guard, and it is a *plan* test for the same reason
 * `listSortPlans.test.ts` is: nothing about the old SQL looked wrong. Both
 * spellings return byte-identical rows, so no assertion on output could ever
 * have caught it, and no assertion on output will catch it coming back. Only
 * asking Postgres what it intends to do can.
 *
 * Both properties are asserted for each feed:
 *
 *  - the rows are the same as the old spelling's, which is what makes the
 *    rewrite legitimate rather than merely faster, and
 *  - the plan reads a bounded prefix of each event table rather than all of it.
 *
 * The old spelling is executed here too, as the discriminator: if it planned
 * the same way as the new one, this file would be measuring nothing and the
 * "reads fewer rows" assertions would be vacuous.
 */

/** Enough events that a full scan is measurably the wrong plan. */
const EVENTS = 40_000;
const ADMIN_EVENTS = 8_000;
const VALUATIONS = 2_000;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** Rows the plan actually pulled off `table`, summed over every node that touched it. */
function rowsRead(plan: PlanNode[], table: string): number {
  return plan
    .filter((n) => n['Relation Name'] === table)
    .reduce((total, n) => total + (n['Actual Rows'] ?? 0) * 1, 0);
}

/**
 * The statements a repo call actually issued, text and parameters both.
 *
 * The plan assertions below EXPLAIN *these*, not a copy of the SQL pasted into
 * this file. A copy would be the vacuous version of this test: revert the repo
 * to the union spelling and a test that plans its own string keeps passing
 * while the service goes back to reading the whole log. Asking the repo what it
 * sent is the only form of the question that cannot drift from the answer.
 */
function tapStatements(pool: pg.Pool): {
  seen: Array<{ text: string; params: unknown[] }>;
  restore: () => void;
} {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    seen.push({ text, params: (args[1] as unknown[]) ?? [] });
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return {
    seen,
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

/** The statements one repo call issued, longest first (the page query, then the count). */
async function statementsOf(pool: pg.Pool, body: () => Promise<unknown>) {
  const tap = tapStatements(pool);
  try {
    await body();
  } finally {
    tap.restore();
  }
  return tap.seen;
}

describe.skipIf(!dbUp)('merged feeds read a window, not the whole log (R167)', () => {
  let db: TestDb;
  let userId: string;

  const explain = async (sql: string, params: unknown[] = []): Promise<PlanNode[]> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
  };

  beforeAll(async () => {
    db = await setupTestDb();
    userId = newUlid();
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, 'feeds@x.y', 'x')`, [
      userId,
    ]);
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, created_at)
       SELECT ('01' || lpad(upper(to_hex(g)), 24, '0'))::ulid, '409a',
              'Feed Co ' || lpad(g::text, 6, '0'), $2, now() - (g || ' minutes')::interval
         FROM generate_series(1, $1) g`,
      [VALUATIONS, userId],
    );
    await db.pool.query(
      `INSERT INTO valuation_events (id, valuation_id, type, actor_type, actor_id, occurred_at, payload)
       SELECT ('02' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              ('01' || lpad(upper(to_hex(1 + g % ${VALUATIONS})), 24, '0'))::ulid,
              (ARRAY['created','state_changed','comment_added'])[1 + g % 3],
              'human', $2, now() - (g || ' seconds')::interval, '{}'::jsonb
         FROM generate_series(1, $1) g`,
      [EVENTS, userId],
    );
    await db.pool.query(
      `INSERT INTO admin_events (id, type, actor_type, actor_id, subject_type, subject_id, occurred_at, payload)
       SELECT ('04' || lpad(upper(to_hex(g)), 24, '0'))::ulid,
              'user_role_changed', 'human', $2, 'valuation',
              ('01' || lpad(upper(to_hex(1 + g % ${VALUATIONS})), 24, '0'))::text,
              now() - (g || ' seconds')::interval, '{}'::jsonb
         FROM generate_series(1, $1) g`,
      [ADMIN_EVENTS, userId],
    );
    // Without statistics the planner is costing tables it believes are empty.
    await db.pool.query('ANALYZE');
  }, 300_000);
  afterAll(async () => db?.teardown());

  describe('mergeWindow', () => {
    it('is the page plus everything skipped to reach it', () => {
      expect(mergeWindow(1, 25)).toBe(25);
      expect(mergeWindow(2, 25)).toBe(50);
      expect(mergeWindow(4, 10)).toBe(40);
    });
  });

  describe('the ops activity log', () => {
    /**
     * `listActivity` as it was written before R167 — the union with the
     * ordering above it, and the `valuations` join inside the branch. Kept
     * verbatim so the comparisons below are against the thing that shipped.
     */
    const OLD_SQL = `
      SELECT s.*, u.email AS actor_email
      FROM (
        SELECT e.id, 'valuation' AS scope, e.type, e.actor_type::text AS actor_type, e.actor_id,
               e.source, 'valuation' AS subject_type, e.valuation_id::text AS subject_id,
               v.company_name || ' · #' || v.number AS subject_label,
               e.payload, e.occurred_at
        FROM valuation_events e
        JOIN valuations v ON v.id = e.valuation_id
        UNION ALL
        SELECT a.id, 'admin' AS scope, a.type, a.actor_type::text AS actor_type, a.actor_id,
               a.source, a.subject_type, a.subject_id, a.subject_label, a.payload, a.occurred_at
        FROM admin_events a
      ) s
      LEFT JOIN users u ON u.id = s.actor_id
      ORDER BY s.occurred_at DESC, s.id DESC
      LIMIT $1 OFFSET $2`;

    it('returns exactly the rows the old spelling returned, on page 1 and deeper', async () => {
      for (const page of [1, 3]) {
        const fresh = await listActivity(db.pool, { scope: 'all', page, perPage: 20 });
        const { rows: old } = await db.pool.query<{ id: string; subject_label: string | null }>(OLD_SQL, [
          20,
          (page - 1) * 20,
        ]);
        expect(fresh.items.map((i) => i.id)).toEqual(old.map((o) => o.id));
        // The label moved out of the branch and is now attached below the
        // merge — it has to come back with the same text it always did.
        expect(fresh.items.map((i) => i.subject_label)).toEqual(old.map((o) => o.subject_label));
      }
    });

    it('counts the same total as counting the union did', async () => {
      const { total } = await listActivity(db.pool, { scope: 'all', page: 1, perPage: 20 });
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM (SELECT e.id FROM valuation_events e JOIN valuations v ON v.id = e.valuation_id
                 UNION ALL SELECT a.id FROM admin_events a) s`,
      );
      expect(total).toBe(Number(rows[0]!.n));
      expect(total).toBe(EVENTS + ADMIN_EVENTS);
    });

    it('honours every filter the same way the union-level WHERE did', async () => {
      const subject = `01${(1).toString(16).toUpperCase().padStart(24, '0')}`;
      const cases: Array<Record<string, unknown>> = [
        { type: 'state_changed' },
        { actorId: userId },
        { actorType: 'human' },
        { valuationId: subject },
        { scope: 'valuations' },
        { scope: 'admin' },
      ];
      for (const extra of cases) {
        const filters = { scope: 'all' as const, page: 1, perPage: 20, ...extra };
        const fresh = await listActivity(db.pool, filters);
        // Every returned row must satisfy the filter it was asked for — the
        // trap with a per-branch cap is a predicate left above it, which shows
        // up as rows that should not be here or a page that came back short.
        for (const row of fresh.items) {
          if (filters.type) expect(row.type).toBe(filters.type);
          if (filters.actorId) expect(row.actor_id).toBe(filters.actorId);
          if (filters.valuationId) expect(row.subject_id).toBe(filters.valuationId);
          if (filters.scope === 'valuations') expect(row.scope).toBe('valuation');
          if (filters.scope === 'admin') expect(row.scope).toBe('admin');
        }
        // …and a filter that matches plenty must still fill the page.
        if (!filters.valuationId) expect(fresh.items.length).toBe(20);
      }
    });

    it('reads a bounded prefix of each event table rather than all of it', async () => {
      const [count, page] = await statementsOf(db.pool, () =>
        listActivity(db.pool, { scope: 'all', page: 1, perPage: 20 }),
      );
      const plan = await explain(page!.text, page!.params);
      // A few more than the cap: an index scan overshoots by a page.
      expect(rowsRead(plan, 'valuation_events')).toBeLessThan(200);
      expect(rowsRead(plan, 'admin_events')).toBeLessThan(200);
      expect(plan.map((n) => n['Index Name'])).toContain('valuation_events_occurred_idx');
      expect(plan.map((n) => n['Index Name'])).toContain('admin_events_occurred_idx');
      // The page query does not touch `valuations` for more than the rows it
      // is decorating: the join moved below the merge.
      expect(rowsRead(plan, 'valuations')).toBeLessThanOrEqual(20);

      // The count is the other half of the request, and the join is gone from
      // it entirely — an inner join on a NOT NULL foreign key cannot change a
      // count, and paying for it meant hashing the whole valuations table.
      expect(count!.text).not.toMatch(/join\s+valuations/i);
      const countPlan = await explain(count!.text, count!.params);
      expect(rowsRead(countPlan, 'valuations')).toBe(0);
    });

    it('and the old spelling did not — which is what makes the bound above mean something', async () => {
      const plan = await explain(OLD_SQL, [20, 0]);
      // Every row of both tables, plus the whole of `valuations` for the join.
      expect(rowsRead(plan, 'valuation_events')).toBeGreaterThanOrEqual(EVENTS);
      expect(rowsRead(plan, 'admin_events')).toBeGreaterThanOrEqual(ADMIN_EVENTS);
      expect(rowsRead(plan, 'valuations')).toBeGreaterThanOrEqual(VALUATIONS);
    });
  });

  describe('the dashboard activity band', () => {
    const OLD_SQL = `
      SELECT s.*, u.email AS actor_email
      FROM (
        SELECT e.id, 'valuation' AS scope, e.type, e.actor_type::text AS actor_type, e.actor_id,
               v.id AS valuation_id, v.company_name, v.number, e.occurred_at
        FROM valuation_events e
        JOIN valuations v ON v.id = e.valuation_id
        WHERE v.archived_at IS NULL
        UNION ALL
        SELECT a.id, 'admin' AS scope, a.type, a.actor_type::text AS actor_type, a.actor_id,
               v.id AS valuation_id, v.company_name, v.number, a.occurred_at
        FROM admin_events a
        JOIN valuations v ON v.id = a.subject_id
        WHERE v.archived_at IS NULL AND a.subject_type = 'valuation'
      ) s
      LEFT JOIN users u ON u.id = s.actor_id
      ORDER BY s.occurred_at DESC, s.id DESC
      LIMIT $1`;

    it('returns exactly the rows the old spelling returned', async () => {
      const fresh = await dashboardActivity(db.pool, { kind: 'all' }, 20, true);
      const { rows: old } = await db.pool.query<{ id: string; company_name: string }>(OLD_SQL, [20]);
      expect(fresh.map((r) => r.id)).toEqual(old.map((o) => o.id));
      expect(fresh.map((r) => r.company_name)).toEqual(old.map((o) => o.company_name));
    });

    it('keeps the join inside each branch, because there it is the scope', async () => {
      // The client-facing feed drops the admin branch whole and narrows the
      // valuation branch to the client-visible types; both are still capped.
      const clientSide = await dashboardActivity(db.pool, { kind: 'all' }, 20, false);
      expect(clientSide.length).toBe(20);
      expect(clientSide.every((r) => r.scope === 'valuation')).toBe(true);
      expect(clientSide.some((r) => r.type === 'state_changed')).toBe(true);
    });

    it('reads a bounded prefix of each event table rather than all of it', async () => {
      const [feed] = await statementsOf(db.pool, () => dashboardActivity(db.pool, { kind: 'all' }, 20, true));
      const plan = await explain(feed!.text, feed!.params);
      expect(rowsRead(plan, 'valuation_events')).toBeLessThan(200);
      expect(rowsRead(plan, 'admin_events')).toBeLessThan(200);
      expect(plan.map((n) => n['Index Name'])).toContain('valuation_events_occurred_idx');
    });

    it('and the old spelling read both tables entire', async () => {
      const plan = await explain(OLD_SQL, [20]);
      expect(rowsRead(plan, 'valuation_events')).toBeGreaterThanOrEqual(EVENTS);
      expect(rowsRead(plan, 'admin_events')).toBeGreaterThanOrEqual(ADMIN_EVENTS);
    });
  });
});
