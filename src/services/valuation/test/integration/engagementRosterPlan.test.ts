import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listActiveEngagements, eachActiveEngagement } from '../../src/repos/engagements.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Engagements. Enough that a per-row aggregate is measurably the wrong plan. */
const ROWS = 20_000;
/**
 * Analysts holding them. Twenty, because that is what an engagement book looks
 * like — a firm's open pipeline is worked by a couple of dozen people, not by a
 * different person per file — and it is the whole reason the two spellings
 * differ. One analyst per engagement would make the SubPlan and the LATERAL do
 * the same amount of work, and this file would pass over the bug.
 */
const ANALYSTS = 20;

/**
 * The active-engagement roster must ask for an analyst's roles once per
 * analyst, not once per engagement (R283).
 *
 * R279 gave `ACTIVE_ENGAGEMENT_SELECT` three analyst columns so the overdue
 * sweep could decide whether an assignment is still one it may act on
 * (`analystIsChasable`). Two of them come off the `users` join it already had.
 * The third, `analyst_roles`, arrived as a scalar subquery in the select list —
 * and a scalar SubPlan is the one join shape Postgres cannot cache. It is
 * re-executed for every row of the outer plan, so twenty analysts holding a
 * 500-row page were asked the same twenty questions five hundred times.
 *
 * Written as a LATERAL it sits in the join tree instead, under a `Memoize`
 * keyed on `u.id` exactly like the `users` scan beside it. Measured on 40k
 * engagements: 1717 buffers to 81 for the roles alone, 8.3ms to 4.9ms for the
 * page.
 *
 * WHAT IS ASSERTED, and why it is not a stopwatch. The claim is structural —
 * the roles lookup runs once per distinct analyst — and `Memoize`'s own
 * counters state exactly that: hits plus misses is the row count, and misses is
 * the number of distinct keys. A timing threshold would make this file fail on
 * a loaded machine for reasons that have nothing to do with the query.
 *
 * The R279 spelling is explained alongside as the discriminator. It has to fail
 * the same check the current one passes, or the check is reading nothing — the
 * `Memoize` under the `users` join is present in *both* plans, so a naive "is
 * there a Memoize" test would pass over the bug entirely.
 */

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  'Cache Hits'?: number;
  'Cache Misses'?: number;
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

/** Every node that reads `user_roles`, however the planner reached it. */
const roleScans = (plan: PlanNode): PlanNode[] =>
  flatten(plan).filter((n) => (n['Relation Name'] ?? '') === 'user_roles');

/**
 * True when the roles lookup hangs off the select list rather than the join
 * tree — which is the defect, and is what makes it uncacheable.
 */
const rolesAreASubPlan = (plan: PlanNode): boolean =>
  flatten(plan).some((n) => (n['Parent Relationship'] ?? '') === 'SubPlan' && roleScans(n).length > 0);

/** The `Memoize` that caches the roles lookup, if the planner built one. */
const rolesMemoize = (plan: PlanNode): PlanNode | undefined =>
  flatten(plan).find((n) => n['Node Type'] === 'Memoize' && roleScans(n).length > 0);

describe.skipIf(!dbUp)('the engagement roster reads an analyst’s roles once per analyst (R283)', () => {
  let db: TestDb;
  let current = '';
  /** The R279 spelling, rebuilt from the current one by swapping the join back. */
  let previous = '';
  let currentPlan: PlanNode;
  let previousPlan: PlanNode;

  const explain = async (sql: string, params: unknown[]): Promise<PlanNode> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

    await q(
      `INSERT INTO users (id, email, password_digest)
       SELECT ${ULID('g', 'X')}, 'u' || g || '@x.y', 'x' FROM generate_series(1, ${ANALYSTS}) g`,
    );
    // Two roles each, so `array_agg` has something to aggregate and the join to
    // `roles` inside the lookup is real work rather than a single index probe.
    await q(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u
       JOIN LATERAL (SELECT id FROM roles ORDER BY id LIMIT 2) r ON true`,
    );
    await q(
      `INSERT INTO valuations (id, kind, company_name, user_id)
       SELECT ${ULID('g', 'V')}, '409a', 'Co ' || g, ${ULID('1 + (g % ' + ANALYSTS + ')', 'X')}
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q(
      `INSERT INTO engagements (id, valuation_id, current_stage, assigned_analyst_id, stage_entered_at)
       SELECT ${ULID('g', 'E')}, ${ULID('g', 'V')},
              (ARRAY['kickoff','data_collection','analysis','review'])[1 + (g % 4)],
              ${ULID('1 + (g % ' + ANALYSTS + ')', 'X')},
              now() - (g || ' minutes')::interval
         FROM generate_series(1, ${ROWS}) g`,
    );
    await q('ANALYZE');

    const t = tap(db.pool);
    try {
      await listActiveEngagements(db.pool);
    } finally {
      t.restore();
    }
    current = t.seen.find((s) => /analyst_roles/.test(s)) ?? '';
    if (!current) throw new Error('listActiveEngagements issued no statement this recognises');

    // The R279 spelling: same value, asked from the select list. Built by
    // swapping the LATERAL back out, so the two differ in nothing else.
    previous = current
      .replace(
        'ar.analyst_roles',
        `(SELECT array_agg(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id) AS analyst_roles`,
      )
      .replace(/LEFT JOIN LATERAL \(\s*SELECT array_agg\(r\.key\) AS analyst_roles[\s\S]*?\) ar ON true/, '');
    if (previous === current || /LATERAL/.test(previous))
      throw new Error('cannot rebuild the R279 spelling: the statement has changed shape');

    currentPlan = await explain(current, [501]);
    previousPlan = await explain(previous, [501]);
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a page far wider than the number of analysts holding it', async () => {
    // Vacuity guard. Every assertion below is true of a one-row table, and the
    // two spellings only differ when a page repeats its analysts.
    const { rows } = await db.pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM engagements WHERE current_stage <> 'complete') AS open,
              (SELECT count(DISTINCT assigned_analyst_id) FROM engagements) AS analysts`,
    );
    expect(Number(rows[0]!.open)).toBeGreaterThan(1_000);
    expect(Number(rows[0]!.analysts)).toBe(ANALYSTS);
  });

  it('asks for the roles from the join tree, not from the select list', () => {
    expect(rolesAreASubPlan(currentPlan)).toBe(false);
    // The discriminator: R279's spelling must fail exactly this.
    expect(rolesAreASubPlan(previousPlan)).toBe(true);
  });

  it('caches the lookup, so it runs once per analyst and not once per row', () => {
    const memo = rolesMemoize(currentPlan);
    expect(memo, 'the roles lookup is not under a Memoize').toBeDefined();
    const misses = memo!['Cache Misses'] ?? 0;
    const hits = memo!['Cache Hits'] ?? 0;
    // One miss per distinct analyst on the page; every other row is a hit.
    expect(misses).toBeLessThanOrEqual(ANALYSTS);
    expect(hits).toBeGreaterThan(400);
    // The discriminator again: a SubPlan cannot be cached at all.
    expect(rolesMemoize(previousPlan)).toBeUndefined();
  });

  it('reads far fewer blocks of user_roles than the old spelling', async () => {
    const blocks = async (sql: string): Promise<number> => {
      const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [501]);
      const plan = (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
      return roleScans(plan).reduce(
        (n, s) => n + Number((s as unknown as Record<string, number>)['Shared Hit Blocks'] ?? 0),
        0,
      );
    };
    const now = await blocks(current);
    const then = await blocks(previous);
    // Measured ~20x on 40k engagements; asserted at 4x so the file is about the
    // shape of the plan rather than about one machine's buffer accounting.
    expect(now * 4).toBeLessThan(then);
  });

  it('the sweep reads the same roster, so it gets the same plan', async () => {
    const t = tap(db.pool);
    try {
      const it = eachActiveEngagement(db.pool, { pageSize: 50 });
      await it.next();
      await it.return(undefined);
    } finally {
      t.restore();
    }
    const sweep = t.seen.find((s) => /analyst_roles/.test(s));
    expect(sweep, 'eachActiveEngagement issued no roster statement').toBeDefined();
    expect(rolesAreASubPlan(await explain(sweep!, [50]))).toBe(false);
  });

  it('an engagement with no analyst still reads back null roles', async () => {
    await db.pool.query(
      // The oldest row, because the board sorts oldest-in-stage first and this
      // has to land on the page the assertion below reads.
      `UPDATE engagements SET assigned_analyst_id = NULL WHERE id = ${ULID(String(ROWS), 'E')}`,
    );
    const { engagements } = await listActiveEngagements(db.pool, { limit: 500 });
    const orphan = engagements.find((e) => e.assigned_analyst_id === null);
    expect(orphan, 'the unassigned engagement fell off the page').toBeDefined();
    // The LEFT JOIN LATERAL adds a row per outer row whatever `u` is, so this
    // is the value the aggregate produces over an empty set — not a dropped row.
    expect(orphan!.analyst_roles).toBeNull();
    expect(orphan!.analyst_email).toBeNull();
  });
});
