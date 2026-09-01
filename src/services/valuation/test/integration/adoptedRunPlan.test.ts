import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { findCurrentVolatilityEstimate } from '../../src/repos/volatilityEstimates.js';
import { findCurrentProjection } from '../../src/repos/projections.js';
import { findAppliedRollforwardRun } from '../../src/repos/rollforwardRuns.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Engagements in the fixture. The readers are per-engagement; this is population. */
const VALUATIONS = 30;
/**
 * Tool runs per engagement, and the number is the point. These three panels are
 * re-run all day on a working file — R304 made the histories pageable and had
 * them say when there are more — and one run each is a fixture in which every
 * spelling reads the same rows.
 */
const RUNS = 120;

/**
 * "Which run is the calculation carrying" must cost one row, not the history.
 *
 * `findCurrentVolatilityEstimate`, `findCurrentProjection` and
 * `findAppliedRollforwardRun` are one question asked of three tables, and all
 * three are in the single `Promise.all` that assembles a 409A
 * (routes/reports.ts). Each returned a row and read every run the engagement
 * had ever recorded to find it: the first two because their leading sort term
 * was `(applied_at IS NOT NULL) DESC`, a boolean no btree holds (0181's shape),
 * and the third because nothing indexed `(valuation_id, applied_at)` at all.
 *
 * Migration 0200 indexes all three, and the first two are respelled
 * `applied_at DESC NULLS LAST, …` — which is the same ordering in columns,
 * since a btree DESC is stored NULLS FIRST. The old spelling is kept below as
 * the discriminator, and its *answer* is compared against the new one on every
 * seeded engagement: a faster plan that picks a different run is not a
 * performance fix, it is the R304 defect coming back.
 *
 * WHAT IS ASSERTED is rows of the table touched, stated as a difference —
 * deepen every history and the number must not move. Blocks and milliseconds
 * are properties of the corpus (see the foot of `fundMarkRollupPlan.test.ts`),
 * and this fixture's engagements are small enough that a seq scan would win on
 * both while still being the wrong plan.
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
 * Rows of `table` the plan actually touched, however it reached them.
 *
 * `Rows Removed by Filter` is counted, and has to be: `findAppliedRollforwardRun`
 * carries `applied_at IS NOT NULL` in its WHERE, so its pre-0200 plan walked the
 * whole history and *reported* only the adopted rows as Actual Rows. Reading
 * emitted rows alone, the losing plan looks like it read seventeen of a hundred
 * and twenty — which is the number this file exists to disbelieve.
 */
const rowsOf = (plan: PlanNode, table: string): number =>
  flatten(plan)
    .filter((n) => (n['Relation Name'] ?? '') === table)
    .reduce((n, s) => n + Number(s['Actual Rows'] ?? 0) + Number(s['Rows Removed by Filter'] ?? 0), 0);

/** The pre-0200 spellings, kept so the assertions below cannot pass vacuously. */
const PREVIOUS: Record<string, string> = {
  volatility_estimates: `SELECT * FROM volatility_estimates WHERE valuation_id = $1
      ORDER BY (applied_at IS NOT NULL) DESC, applied_at DESC, created_at DESC, id DESC LIMIT 1`,
  valuation_projections: `SELECT * FROM valuation_projections WHERE valuation_id = $1
      ORDER BY (applied_at IS NOT NULL) DESC, applied_at DESC, created_at DESC, id DESC LIMIT 1`,
  // This one's spelling did not change; what it lacked was the index. Its
  // discriminator is therefore the same statement planned with 0200's index
  // gone — see `explainWithout` — rather than a second spelling.
  rollforward_runs: `SELECT * FROM rollforward_runs WHERE valuation_id = $1 AND applied_at IS NOT NULL
      ORDER BY applied_at DESC, id DESC LIMIT 1`,
};

/** The index each table's pre-0200 plan is the absence of. */
const INDEX_WITHOUT: Record<string, string | null> = {
  volatility_estimates: null,
  valuation_projections: null,
  rollforward_runs: 'rollforward_runs_adopted_idx',
};

describe.skipIf(!dbUp)('the adopted-run lookups cost one row, not the history (R306)', () => {
  let db: TestDb;
  let valuationIds: string[] = [];
  let deep = '';
  const current: Record<string, string> = {};
  const plan: Record<string, PlanNode> = {};
  const previousPlan: Record<string, PlanNode> = {};

  const explain = async (sql: string, params: unknown[]): Promise<PlanNode> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  };

  /**
   * The same statement planned as it was before 0200 existed.
   *
   * `findAppliedRollforwardRun`'s SQL did not change — only the index under it
   * did — so its discriminator cannot be a second spelling. Dropping the index
   * inside a transaction that is rolled back is the honest form of the question,
   * and it is the only form that can fail if 0200 is reverted.
   */
  const explainWithout = async (sql: string, params: unknown[], index: string): Promise<PlanNode> => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DROP INDEX ${index}`);
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  };

  beforeAll(async () => {
    db = await setupTestDb();
    const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

    await q(
      `INSERT INTO users (id, email, verified, password_digest)
       VALUES (${ULID('1', 'A')}, 'adopted-run-plan@example.test', true, 'x')`,
    );
    await q(
      `INSERT INTO valuations (id, kind, state, company_name, user_id)
       SELECT ${ULID('g', 'B')}, '409a', 'completed', 'Co ' || lpad(g::text, 4, '0'), ${ULID('1', 'A')}
         FROM generate_series(1, ${VALUATIONS}) g`,
    );

    /*
     * RUN-MINOR, so one engagement's runs are scattered through the table the
     * way an append-only history really lands — see the note in
     * `monitorSnapshotPlan.test.ts`. Seeded valuation-major, each history packs
     * into a couple of heap blocks and the losing plan wins on blocks.
     *
     * Adoption is deliberately *not* in creation order: `m % 7 = 3` marks a run
     * adopted and the adoption instants run backwards against `created_at`, so
     * the newest adopted run and the newest run are different rows. That is
     * R304's case, and it is what makes the answers-match assertion below able
     * to fail.
     */
    const applied = (m: string) =>
      `CASE WHEN ${m} % 7 = 3 THEN now() - ((1000 - ${m}) || ' minutes')::interval END`;
    const seed = async (from: number, to: number) => {
      await q(
        `INSERT INTO volatility_estimates
           (id, valuation_id, method, window_start, window_end, recommended, confidence, applied_at, created_at)
         SELECT ${ULID(`(m - 1) * ${VALUATIONS} + v`, 'C')}, ${ULID('v', 'B')}, 'historical',
                date '2023-01-01', date '2024-01-01', 0.5 + (m % 10) * 0.01, 'high',
                ${applied('m')}, now() - ((m * ${VALUATIONS} + v) || ' minutes')::interval
           FROM generate_series(${from}, ${to}) m, generate_series(1, ${VALUATIONS}) v`,
      );
      await q(
        `INSERT INTO valuation_projections
           (id, valuation_id, method, years, tax_rate, applied_at, created_at)
         SELECT ${ULID(`(m - 1) * ${VALUATIONS} + v`, 'D')}, ${ULID('v', 'B')}, 'growth', 5, 0.21,
                ${applied('m')}, now() - ((m * ${VALUATIONS} + v) || ' minutes')::interval
           FROM generate_series(${from}, ${to}) m, generate_series(1, ${VALUATIONS}) v`,
      );
      await q(
        `INSERT INTO rollforward_runs
           (id, valuation_id, prior_valuation_date, new_valuation_date, years_elapsed,
            prior_equity_value, rolled_equity_value, annual_accretion, applied_at, created_at)
         SELECT ${ULID(`(m - 1) * ${VALUATIONS} + v`, 'E')}, ${ULID('v', 'B')},
                date '2023-01-01', date '2024-01-01', 1.0, 1000000, 1200000, 0.2,
                ${applied('m')}, now() - ((m * ${VALUATIONS} + v) || ' minutes')::interval
           FROM generate_series(${from}, ${to}) m, generate_series(1, ${VALUATIONS}) v`,
      );
    };
    await seed(1, RUNS);
    await q('ANALYZE');

    const { rows } = await q(`SELECT id FROM valuations ORDER BY company_name`);
    valuationIds = (rows as Array<{ id: string }>).map((r) => r.id);
    deep = valuationIds[0]!;

    // The statements come off the repos rather than being retyped here, so a
    // future rewrite is measured rather than silently unmeasured.
    const t = tap(db.pool);
    try {
      await findCurrentVolatilityEstimate(db.pool, deep);
      await findCurrentProjection(db.pool, deep);
      await findAppliedRollforwardRun(db.pool, deep);
    } finally {
      t.restore();
    }
    for (const table of Object.keys(PREVIOUS)) {
      const sql = t.seen.find((s) => s.includes(table));
      if (!sql) throw new Error(`no statement issued against ${table}`);
      current[table] = sql;
      plan[table] = await explain(sql, [deep]);
      const without = INDEX_WITHOUT[table];
      previousPlan[table] = without
        ? await explainWithout(PREVIOUS[table]!, [deep], without)
        : await explain(PREVIOUS[table]!, [deep]);
    }
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a history deep enough that reading all of it would show', async () => {
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM volatility_estimates WHERE valuation_id = $1`,
      [deep],
    );
    expect(Number(rows[0]!.n)).toBe(RUNS);
  });

  it('no longer leads either ordering with a boolean expression', () => {
    // The rewrite itself, pinned. `expressionSortCoverage` dropped both of these
    // from its exemption roster on the strength of it.
    expect(current.volatility_estimates).not.toMatch(/applied_at IS NOT NULL\) DESC/);
    expect(current.valuation_projections).not.toMatch(/applied_at IS NOT NULL\) DESC/);
    expect(current.volatility_estimates).toMatch(/applied_at DESC NULLS LAST/);
    expect(current.valuation_projections).toMatch(/applied_at DESC NULLS LAST/);
  });

  it.each(Object.keys(PREVIOUS))('reads one row of %s, not the engagement history', (table) => {
    expect(rowsOf(plan[table]!, table)).toBeLessThanOrEqual(2);
    // The discriminator: each pre-0200 plan must read the whole history it is
    // given. `rollforward_runs` filters to the adopted ones on the way past, so
    // it is bounded below rather than pinned — either way it is a function of
    // the history rather than of the answer.
    expect(rowsOf(previousPlan[table]!, table)).toBeGreaterThan(RUNS / 4);
  });

  it('picks the same run the old spelling picked, on every engagement', async () => {
    // The answers-match assertion, and the one that would catch a "fix" that
    // reordered the adopted runs. The seed adopts backwards against creation
    // order on purpose, so the two orderings disagree unless they are the same
    // ordering.
    for (const id of valuationIds) {
      const now = await findCurrentVolatilityEstimate(db.pool, id);
      const { rows } = await db.pool.query<{ id: string }>(PREVIOUS.volatility_estimates!, [id]);
      expect(now?.id).toBe(rows[0]?.id);

      const proj = await findCurrentProjection(db.pool, id);
      const { rows: prev } = await db.pool.query<{ id: string }>(PREVIOUS.valuation_projections!, [id]);
      expect(proj?.id).toBe(prev[0]?.id);
    }
  });

  it('picks an adopted run that is not the newest run', async () => {
    // Vacuity guard on the assertion above: if every engagement's newest run
    // were also its newest adoption, the two orderings could not disagree and
    // the comparison would hold of the defect.
    const { rows } = await db.pool.query<{ newest: string; adopted: string }>(
      `SELECT (SELECT id FROM volatility_estimates WHERE valuation_id = $1
                ORDER BY created_at DESC, id DESC LIMIT 1) AS newest,
              (SELECT id FROM volatility_estimates WHERE valuation_id = $1
                ORDER BY applied_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1) AS adopted`,
      [deep],
    );
    expect(rows[0]!.adopted).not.toBe(rows[0]!.newest);
  });

  it('does not read more when every engagement is re-run another hundred times', async () => {
    await (async () => {
      const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
      await q(
        `INSERT INTO volatility_estimates
           (id, valuation_id, method, window_start, window_end, recommended, confidence, applied_at, created_at)
         SELECT ${ULID(`1000000 + (m - 1) * ${VALUATIONS} + v`, 'C')}, ${ULID('v', 'B')}, 'historical',
                date '2023-01-01', date '2024-01-01', 0.5, 'high',
                CASE WHEN m % 7 = 3 THEN now() - ((5000 - m) || ' minutes')::interval END,
                now() - ((50000 + m * ${VALUATIONS} + v) || ' minutes')::interval
           FROM generate_series(1, ${RUNS}) m, generate_series(1, ${VALUATIONS}) v`,
      );
      await q('ANALYZE volatility_estimates');
    })();

    const deeper = await explain(current.volatility_estimates!, [deep]);
    const deeperPrevious = await explain(PREVIOUS.volatility_estimates!, [deep]);
    expect(rowsOf(deeper, 'volatility_estimates')).toBeLessThanOrEqual(2);
    // And the discriminator grew with the history, which is the claim.
    expect(rowsOf(deeperPrevious, 'volatility_estimates')).toBeGreaterThan(RUNS);
  });
});
