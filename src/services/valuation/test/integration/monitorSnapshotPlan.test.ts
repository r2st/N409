import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { latestSucceededCalculationHeadsByValuationIds } from '../../src/repos/calculations.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Valuations in the page whose snapshots are being built — `MONITOR_PAGE_LIMIT`
 * of them, which is what both callers actually ask for.
 */
const VALUATIONS = 200;
/**
 * Succeeded engine runs per valuation. The number is the whole point: an
 * engagement re-runs the engine many times a day (`CALCULATION_PAGE_LIMIT`
 * exists because of it), so this is a working file's history, not an outlier —
 * and it is what separates the two spellings. One run each and they read the
 * same rows.
 */
const RUNS = 50;

/**
 * The monitoring snapshot must read the head of each run history, not all of it.
 *
 * `latestSucceededCalculationHeadsByValuationIds` answers "the newest succeeded run
 * for each of these valuations", and it was a `DISTINCT ON` — which is a sort
 * with a filter on top, and a sort cannot stop at the first row of a group. So
 * it read *every* succeeded run of every valuation on the page and ordered the
 * lot to keep one row each. Measured on 200k calculations at a 500-valuation
 * page 100 runs deep: 50,000 rows read and a 9.5 MB external merge sort, 246ms,
 * against 500 rows and 22ms for the lateral.
 *
 * THE COST WAS THE HISTORY AND THE ANSWER IS A PAGE — the same shape R283 found
 * in `funds.latestMarks`, and this is its sibling on the 409A side. Both of this
 * reader's callers make that the shape that matters: `GET /api/v1/monitors`
 * builds snapshots for a whole page, and `POST /api/v1/monitors/scan` does it
 * once per page while paging the entire enabled book.
 *
 * WHAT IS ASSERTED, and why it is not a stopwatch: rows of `calculations`
 * touched, stated as a *difference* — deepen every history and the number must
 * not move. See the note at the foot of `fundMarkRollupPlan.test.ts`: which
 * spelling touches fewer *blocks* is a property of the corpus, and a
 * millisecond threshold fails on a loaded machine for reasons that have nothing
 * to do with the query.
 *
 * The `DISTINCT ON` spelling is explained alongside as the discriminator. It has
 * to fail the check the current one passes, or the check is reading nothing.
 */
interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
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

/** Rows of `calculations` the plan actually touched, however it reached them. */
const runsRead = (plan: PlanNode): number =>
  flatten(plan)
    .filter((n) => (n['Relation Name'] ?? '') === 'calculations')
    .reduce((n, s) => n + Number(s['Actual Rows'] ?? 0), 0);

describe.skipIf(!dbUp)('the monitoring snapshot reads the head of each run history (R298)', () => {
  let db: TestDb;
  let valuationIds: string[] = [];
  let current = '';
  /** The DISTINCT ON spelling, kept as the discriminator. */
  const previous = `SELECT DISTINCT ON (valuation_id) valuation_id, fmv_per_share, created_at
       FROM calculations
      WHERE valuation_id = ANY($1::ulid[]) AND status = 'succeeded'
      ORDER BY valuation_id, created_at DESC`;
  let currentPlan: PlanNode;
  let previousPlan: PlanNode;

  const explain = async (sql: string, params: unknown[]): Promise<PlanNode> => {
    const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    return (rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

    await q(
      `INSERT INTO users (id, email, verified, password_digest)
       VALUES (${ULID('1', 'A')}, 'monitor-plan@example.test', true, 'x')`,
    );
    await q(
      `INSERT INTO valuations (id, kind, state, company_name, user_id)
       SELECT ${ULID('g', 'B')}, '409a', 'completed', 'Co ' || lpad(g::text, 4, '0'), ${ULID('1', 'A')}
         FROM generate_series(1, ${VALUATIONS}) g`,
    );
    /*
     * A history per valuation, oldest first, so the newest run is not simply the
     * last row inserted — the head has to be found by the ordering, not by luck.
     *
     * RUN-MINOR, which decides where the rows physically land and so what this
     * file measures. The platform runs the engine for whoever presses the
     * button, so one engagement's runs are scattered across the table rather
     * than packed together. Seeding valuation-major instead clusters each
     * history into a couple of heap blocks, and a scan that reads fifty
     * clustered runs then costs less than fifty index descents — the old
     * spelling wins on blocks, for a layout no append-only table ever has.
     */
    await q(
      `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results,
                                 fmv_per_share, created_at)
       SELECT ${ULID('(m - 1) * ' + VALUATIONS + ' + v', 'C')}, ${ULID('v', 'B')},
              '1.0.0', 'succeeded', '{}'::jsonb, jsonb_build_object('approaches', '{}'::jsonb),
              -- Distinct per run, so "the head" is a value the assertion below
              -- can check rather than a row count it has to trust.
              (m * 1000 + v)::numeric / 10000,
              now() - ((m * ${VALUATIONS} + v) || ' minutes')::interval
         FROM generate_series(1, ${RUNS}) m, generate_series(1, ${VALUATIONS}) v`,
    );
    await q('ANALYZE');

    const { rows } = await q(`SELECT id FROM valuations ORDER BY company_name LIMIT ${VALUATIONS}`);
    valuationIds = (rows as Array<{ id: string }>).map((r) => r.id);

    const t = tap(db.pool);
    try {
      await latestSucceededCalculationHeadsByValuationIds(db.pool, valuationIds);
    } finally {
      t.restore();
    }
    current = t.seen.find((s) => /calculations/.test(s)) ?? '';
    if (!current) throw new Error('the batch reader issued no statement this recognises');
    if (!/LATERAL/.test(current)) throw new Error('the batch reader is no longer a lateral');

    currentPlan = await explain(current, [valuationIds]);
    previousPlan = await explain(previous, [valuationIds]);
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a history deep enough that reading all of it would show', async () => {
    // Vacuity guard. On one run per valuation both spellings read 200 rows and
    // every assertion below holds of the bug.
    const { rows } = await db.pool.query<{ runs: string; valuations: string }>(
      `SELECT (SELECT count(*)::text FROM calculations) AS runs,
              (SELECT count(*)::text FROM valuations) AS valuations`,
    );
    expect(Number(rows[0]!.valuations)).toBe(VALUATIONS);
    expect(Number(rows[0]!.runs)).toBe(VALUATIONS * RUNS);
  });

  it('returns the same head for every valuation as the DISTINCT ON did', async () => {
    // The answers-match assertion. A faster plan that reads a different row is
    // not a performance fix, and `created_at DESC` is the whole ordering both
    // spellings claim to apply.
    const now = await latestSucceededCalculationHeadsByValuationIds(db.pool, valuationIds);
    const { rows } = await db.pool.query<{ valuation_id: string; fmv_per_share: string }>(previous, [
      valuationIds,
    ]);
    expect(rows.length).toBe(VALUATIONS);
    expect(now.size).toBe(VALUATIONS);
    // The figure identifies the run, since the seed gives every run its own.
    for (const r of rows) expect(now.get(r.valuation_id)?.fmv_per_share).toBe(r.fmv_per_share);
  });

  it('touches one run per valuation, not the whole history', () => {
    // A little slack for the ties `created_at DESC` can leave — the claim is
    // "the head", not "exactly one heap tuple".
    expect(runsRead(currentPlan)).toBeLessThan(VALUATIONS * 3);
    // The discriminator: DISTINCT ON must read every succeeded run there is.
    expect(runsRead(previousPlan)).toBe(VALUATIONS * RUNS);
  });

  it('does not read more when every engagement is re-run another fifty times', async () => {
    // The claim this file exists for, stated as a difference rather than as a
    // level: the work must stop being a function of how long the platform has
    // been running. Doubling every history is the cheapest way to ask it.
    await db.pool.query(
      `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results, created_at)
       SELECT ${ULID('1000000 + (m - 1) * ' + VALUATIONS + ' + v', 'C')}, ${ULID('v', 'B')},
              '1.0.0', 'succeeded', '{}'::jsonb, jsonb_build_object('approaches', '{}'::jsonb),
              now() - ((100000 + m * ${VALUATIONS} + v) || ' minutes')::interval
         FROM generate_series(1, ${RUNS}) m, generate_series(1, ${VALUATIONS}) v`,
    );
    await db.pool.query('ANALYZE calculations');

    const deeper = await explain(current, [valuationIds]);
    const deeperPrevious = await explain(previous, [valuationIds]);
    expect(runsRead(deeper)).toBe(runsRead(currentPlan));
    // The discriminator: the old spelling reads every run, so it doubles.
    expect(runsRead(deeperPrevious)).toBe(runsRead(previousPlan) * 2);
  });
});
