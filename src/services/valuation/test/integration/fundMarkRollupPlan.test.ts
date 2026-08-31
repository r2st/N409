import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { latestMarks } from '../../src/repos/funds.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Holdings on the fund whose NAV is being rolled up — a full page of them. */
const POSITIONS = 200;
/**
 * Marks per holding. Fifty is twelve years of quarterly marking, which is a
 * fund, not an outlier — and it is what separates the two spellings. One mark
 * each and they read the same rows.
 */
const MARKS = 50;

/**
 * The NAV rollup must read the head of each mark trail, not all of it (R283).
 *
 * `latestMarks` answers "the current mark for each of these holdings", and it
 * is read three times over: by the fund page, by `GET /funds/:id/nav`, and by
 * `loadFundReport` on the way into the deliverable, where the NAV schedule is a
 * sum over exactly these rows.
 *
 * It was a `DISTINCT ON`, which is a sort with a filter on top. A sort cannot
 * stop at the first row of a group, so it read and sorted every mark ever taken
 * on every holding of the page to keep two hundred of them. `fund_marks` is
 * append-only — a roll-forward appends, a re-mark appends — so that set is the
 * whole marking history of the fund, and it grows for as long as the fund is
 * held while the answer stays the same two hundred rows wide.
 *
 * As a `CROSS JOIN LATERAL … LIMIT 1` it is one index scan per holding that
 * stops at its first row, because `fund_marks_position_idx` is `(position_id,
 * measurement_date DESC)` and the head of each trail is where the scan starts.
 * Measured on a 200-holding fund: at 50 marks each, 37ms/5103 blocks against
 * 7.5ms/1025; at 100 marks each, 101ms/10176 against 2.5ms/1025.
 *
 * WHAT IS ASSERTED. Rows read, not milliseconds: the claim is that the work
 * stops being a function of how long the fund has been marked, and `actual
 * rows` on the `fund_marks` scan states that directly. The old spelling is
 * explained alongside as the discriminator — on a one-mark-per-holding fund
 * both plans read two hundred rows, so a test that did not seed a trail would
 * pass over the bug.
 *
 * The answers are compared too. A faster query that returns a different mark
 * would restate the NAV of every report this fund has issued.
 */

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
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

/** Rows of `fund_marks` the plan actually touched, however it reached them. */
const marksRead = (plan: PlanNode): number =>
  flatten(plan)
    .filter((n) => (n['Relation Name'] ?? '') === 'fund_marks')
    .reduce((n, s) => n + Number(s['Actual Rows'] ?? 0), 0);

describe.skipIf(!dbUp)('the NAV rollup reads the head of each mark trail (R283)', () => {
  let db: TestDb;
  let positionIds: string[] = [];
  let current = '';
  /** The DISTINCT ON spelling, kept as the discriminator. */
  const previous = `SELECT DISTINCT ON (m.position_id) m.*
       FROM fund_marks m
      WHERE m.position_id = ANY($1::ulid[])
      ORDER BY m.position_id, m.measurement_date DESC, m.created_at DESC`;
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
      `INSERT INTO fund_portfolios (id, name, fund_type, currency)
       VALUES (${ULID('1', 'F')}, 'Marked fund', 'vc', 'USD')`,
    );
    await q(
      `INSERT INTO fund_positions (id, fund_id, company_name, security_type, quantity, cost_basis)
       SELECT ${ULID('g', 'P')}, ${ULID('1', 'F')}, 'Holdco ' || lpad(g::text, 4, '0'),
              'preferred', 1000 + g, 5000 + g
         FROM generate_series(1, ${POSITIONS}) g`,
    );
    // A trail per holding, oldest first, so the newest mark is not simply the
    // last row inserted — the head has to be found by the ordering, not by luck.
    //
    // MEASUREMENT DATE OUTERMOST, which decides where the rows physically land
    // and so what this file measures. A fund is marked at a measurement date:
    // every holding gets its mark for the quarter, then the next quarter's
    // arrive, so one holding's trail is scattered a row at a time across the
    // whole table. Seeding holding-major instead packs each trail into a couple
    // of heap blocks, and a scan that reads fifty clustered marks then costs
    // less than fifty index descents — the old spelling wins on blocks, for a
    // layout no append-only table ever has.
    await q(
      `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level, inputs)
       SELECT ${ULID('(m - 1) * ' + POSITIONS + ' + p', 'M')}, ${ULID('p', 'P')},
              (date '2013-01-01' + (m * 90))::date, 'calibrated_opm',
              100000 + p * 100 + m, 3, jsonb_build_object('model_value', 100000 + p * 100 + m)
         FROM generate_series(1, ${MARKS}) m, generate_series(1, ${POSITIONS}) p`,
    );
    await q('ANALYZE');

    const { rows } = await q(`SELECT id FROM fund_positions ORDER BY company_name LIMIT ${POSITIONS}`);
    positionIds = (rows as Array<{ id: string }>).map((r) => r.id);

    const t = tap(db.pool);
    try {
      await latestMarks(db.pool, positionIds);
    } finally {
      t.restore();
    }
    current = t.seen.find((s) => /fund_marks/.test(s)) ?? '';
    if (!current) throw new Error('latestMarks issued no statement this recognises');
    if (!/LATERAL/.test(current)) throw new Error('latestMarks is no longer a lateral');

    currentPlan = await explain(current, [positionIds]);
    previousPlan = await explain(previous, [positionIds]);
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('seeds a trail deep enough that reading all of it would show', async () => {
    // Vacuity guard. On one mark per holding both spellings read 200 rows and
    // every assertion below holds of the bug.
    const { rows } = await db.pool.query<{ marks: string; positions: string }>(
      `SELECT (SELECT count(*)::text FROM fund_marks) AS marks,
              (SELECT count(*)::text FROM fund_positions) AS positions`,
    );
    expect(Number(rows[0]!.positions)).toBe(POSITIONS);
    expect(Number(rows[0]!.marks)).toBe(POSITIONS * MARKS);
  });

  it('touches one mark per holding, not the whole trail', () => {
    // A little slack for the ties `measurement_date DESC` leaves the
    // incremental sort to break — the claim is "the head", not "exactly one
    // heap tuple".
    expect(marksRead(currentPlan)).toBeLessThan(POSITIONS * 3);
    // The discriminator: DISTINCT ON must read every mark there is.
    expect(marksRead(previousPlan)).toBe(POSITIONS * MARKS);
  });

  it('does not read more when the fund is marked for another twelve years', async () => {
    // The claim this file exists for, stated as a difference rather than as a
    // level: the work must stop being a function of how long the fund has been
    // marked. Doubling every trail is the cheapest way to ask it.
    await db.pool.query(
      `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level)
       SELECT ${ULID('1000000 + (m - 1) * ' + POSITIONS + ' + p', 'M')}, ${ULID('p', 'P')},
              (date '2001-01-01' + (m * 90))::date, 'cost', 90000 + p * 100 + m, 3
         FROM generate_series(1, ${MARKS}) m, generate_series(1, ${POSITIONS}) p`,
    );
    await db.pool.query('ANALYZE fund_marks');

    const deeper = await explain(current, [positionIds]);
    const deeperPrevious = await explain(previous, [positionIds]);
    expect(marksRead(deeper)).toBe(marksRead(currentPlan));
    // The discriminator: the old spelling reads every mark, so it doubles.
    expect(marksRead(deeperPrevious)).toBe(marksRead(previousPlan) * 2);
  });

  /*
   * WHAT IS DELIBERATELY NOT ASSERTED: blocks, or milliseconds.
   *
   * Which of the two spellings touches fewer buffers depends on how much of
   * `fund_marks` the page's holdings account for and on how the rows are laid
   * out. On a database where this fund is the whole table, `DISTINCT ON` reads
   * it end to end in one pass and wins on blocks while reading fifty times the
   * rows; on a 1.6M-mark database where the page is a slice, the lateral read
   * 1025 blocks against 5103 and ran in 7.5ms against 37ms — and at twice the
   * trail depth, 1025 against 10176 and 2.5ms against 101ms. The level is a
   * property of the corpus. The row count is a property of the query, and it is
   * the one that says the cost has stopped growing with the history.
   */

  it('gives the same mark for every holding as the spelling it replaced', async () => {
    const now = await latestMarks(db.pool, positionIds);
    const { rows } = await db.pool.query<{ id: string; position_id: string }>(previous, [positionIds]);
    expect(rows).toHaveLength(POSITIONS);
    expect(now.size).toBe(POSITIONS);
    for (const row of rows) expect(now.get(row.position_id)?.id).toBe(row.id);
  });

  it('answers with the newest measurement date, not the newest row', async () => {
    // The trail is seeded oldest-first, so a reader that took the last row
    // inserted would agree with this. Push one holding's head back in time by
    // appending an *older* measurement after the rest.
    const target = positionIds[0]!;
    await db.pool.query(
      `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level)
       VALUES (${ULID('999999', 'M')}, $1, date '1999-01-01', 'cost', 1, 3)`,
      [target],
    );
    const marks = await latestMarks(db.pool, [target]);
    expect(marks.get(target)!.measurement_date).not.toBe('1999-01-01');
  });

  it('asks nothing at all for an empty page', async () => {
    const t = tap(db.pool);
    try {
      expect((await latestMarks(db.pool, [])).size).toBe(0);
    } finally {
      t.restore();
    }
    expect(t.seen).toHaveLength(0);
  });
});
