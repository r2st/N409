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
 * Users who are not analysts, seeded for one reason: to make `users.id` look
 * like a primary key to ANALYZE.
 *
 * WITHOUT THEM THIS FILE PASSES OVER ITS OWN BUG (R290). A `Memoize` is costed
 * from the planner's estimate of how many distinct values the cache key takes,
 * and R283's LATERAL was keyed on `u.id`. When `users` holds nothing but the
 * twenty analysts, `u.id` has twenty distinct values and the estimate is right
 * by accident — the cache is built and every assertion below is green. On a
 * real book `users` also holds every client contact, board member and closed
 * account, `n_distinct` for its primary key is -1, and the planner estimates a
 * 500-row page to carry 500 distinct analysts and builds no cache at all.
 *
 * So the seed's *population* was the thing under test and nobody had said so.
 *
 * FIFTY THOUSAND, AND FIVE THOUSAND IS NOT ENOUGH — measured, not guessed. At
 * 5k bystanders the planner still builds the cache for the `u.id` spelling and
 * the discriminator below passes over the defect exactly as the twenty-analyst
 * seed did. `n_distinct` reads -1 either way, so the ndistinct assertion is
 * necessary and not sufficient; the discriminator is what actually pins this,
 * and it is why that assertion carries the "is `users` still seeded wide?"
 * message. Do not shrink this to make the file faster.
 */
const BYSTANDERS = 50_000;

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
  /** The R283 spelling: the LATERAL keyed on `u.id`. See R290 below. */
  let uncached = '';
  let currentPlan: PlanNode;
  let previousPlan: PlanNode;
  let uncachedPlan: PlanNode;

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
    // Everyone else. Not assigned anything, but picked up by the roles insert
    // below along with the analysts — every account on this platform holds at
    // least `valuation_user`, so a `user_roles` containing only the analysts is
    // as unrepresentative as a `users` that does, and both estimates feed the
    // decision under test.
    await q(
      `INSERT INTO users (id, email, password_digest)
       SELECT ${ULID('g', 'Y')}, 'b' || g || '@x.y', 'x'
         FROM generate_series(1, ${BYSTANDERS}) g`,
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

    // R283's spelling: the same LATERAL, keyed on the users PK instead of on
    // the assignment it equals. Structurally perfect and uncacheable in
    // practice, which is why the SubPlan discriminator above cannot stand alone.
    uncached = current.replace('WHERE ur.user_id = e.assigned_analyst_id', 'WHERE ur.user_id = u.id');
    if (uncached === current)
      throw new Error('cannot rebuild the R283 spelling: the roster no longer keys on the assignment');

    currentPlan = await explain(current, [501]);
    previousPlan = await explain(previous, [501]);
    uncachedPlan = await explain(uncached, [501]);
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

  it('seeds a users table whose primary key is estimated unique (R290)', async () => {
    // The other vacuity guard, and the one this file was missing. Every
    // assertion about the Memoize is a statement about a planner estimate, and
    // the estimate is only the production one when `users` holds more than the
    // analysts. -1 is how pg_stats spells "as many distinct values as rows".
    const { rows } = await db.pool.query<{ nd: number }>(
      `SELECT n_distinct AS nd FROM pg_stats WHERE tablename = 'users' AND attname = 'id'`,
    );
    expect(rows[0], 'no statistics for users.id — did ANALYZE run?').toBeDefined();
    expect(Number(rows[0]!.nd)).toBeLessThan(0);
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

  it('keys the cache on the assignment, not on the users PK (R290)', () => {
    // R283's spelling, which is a LATERAL in the join tree and passes both
    // assertions above about *shape* — and gets no cache, because the planner
    // reads `u.id`'s uniqueness as "these keys will not repeat". This is the
    // discriminator the file needed: the defect it replaces is not a SubPlan.
    expect(rolesAreASubPlan(uncachedPlan)).toBe(false);
    expect(
      rolesMemoize(uncachedPlan),
      'the u.id spelling was cached — is `users` still seeded wide?',
    ).toBeUndefined();
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
    // And against R283's, which is the spelling this replaced: same join tree,
    // no cache, so the aggregate runs once per row exactly as the SubPlan did.
    expect(now * 4).toBeLessThan(await blocks(uncached));
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
