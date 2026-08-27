import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { ComparableFiguresSource, ComparableSource } from '../domain/comparables.js';

/**
 * The persisted peer set (migration 0119).
 *
 * `numeric` columns come back from pg as strings, so every reader here maps
 * them to numbers once. Doing it at the boundary rather than at each use site
 * is what keeps `impliedMultiples` from having to guess at its input types —
 * and a silent `'12.00' / '3.00'` is the class of bug that produces a plausible
 * NaN in a report exhibit.
 */

export interface ComparableItemRow {
  id: string;
  valuation_id: string;
  ticker: string | null;
  name: string;
  sic: string | null;
  source: ComparableSource;
  included: boolean;
  exclude_reason: string | null;
  revenue_ltm: number | null;
  revenue_ntm: number | null;
  ebitda_ltm: number | null;
  ebitda_ntm: number | null;
  ev: number | null;
  score: number | null;
  score_breakdown: Record<string, unknown>;
  /**
   * Where this row's *figures* came from, and when (migration 0133) — a
   * different question from `source`, which is who put the row in the set.
   * NULL on every row written before the columns existed, and that means the
   * engine's static snapshot at an unknown moment.
   */
  figures_source: ComparableFiguresSource | null;
  figures_as_of: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The `numeric` columns — the ones the driver hands back as strings. */
type NumericColumn = 'revenue_ltm' | 'revenue_ntm' | 'ebitda_ltm' | 'ebitda_ntm' | 'ev' | 'score';

/**
 * A row as the pg driver actually hands it back, rather than as the reader ends
 * up seeing it: the `numeric` columns arrive as strings.
 *
 * Naming that difference is what lets `hydrate` return `ComparableItemRow`
 * without an assertion. It used to take a `Record<string, unknown>`, convert
 * columns in place and launder the result through `as unknown as` — which types
 * a forgotten column, or one added to the interface later, as a number when it
 * is really an untouched string. `'12.00' / '3.00'` is the NaN this module's
 * header warns about; the cast was the thing that let it compile.
 */
type RawComparableItemRow = Omit<ComparableItemRow, NumericColumn> &
  Record<NumericColumn, string | number | null>;

const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

function hydrate(row: RawComparableItemRow): ComparableItemRow {
  return {
    ...row,
    revenue_ltm: num(row.revenue_ltm),
    revenue_ntm: num(row.revenue_ntm),
    ebitda_ltm: num(row.ebitda_ltm),
    ebitda_ntm: num(row.ebitda_ntm),
    ev: num(row.ev),
    score: num(row.score),
  };
}

/**
 * The whole set for one engagement.
 *
 * Included first, then by score descending, then by name — the order the tab
 * and the exhibit both read in, so a reviewer comparing the two is not
 * re-sorting in their head. Nulls sort last: an unscored analyst addition
 * belongs below the screened rows, not above them.
 */
/**
 * Ceiling on one page of an engagement's peer set.
 *
 * Machine-generated rows are replaced wholesale on each run, but analyst-added
 * peers accumulate beside them and nothing removes an excluded one — exclusion
 * is a flag, kept so the reasoning survives into the report. Included first,
 * then by score, so a capped page is the peer set that carries the conclusion
 * and the tail that falls off is the rejected end.
 */
export const COMPARABLE_PAGE_LIMIT = 500;

export async function listComparableItems(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
): Promise<{ items: ComparableItemRow[]; truncated: boolean }> {
  const { rows } = await pool.query<RawComparableItemRow>(
    `SELECT * FROM comparable_items
      WHERE valuation_id = $1
      ORDER BY included DESC, score DESC NULLS LAST, name ASC
      LIMIT $2`,
    [valuationId, COMPARABLE_PAGE_LIMIT + 1],
  );
  return {
    items: rows.slice(0, COMPARABLE_PAGE_LIMIT).map(hydrate),
    truncated: rows.length > COMPARABLE_PAGE_LIMIT,
  };
}

export async function findComparableItem(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  itemId: string,
): Promise<ComparableItemRow | null> {
  const { rows } = await pool.query<RawComparableItemRow>(
    `SELECT * FROM comparable_items WHERE id = $1 AND valuation_id = $2`,
    [itemId, valuationId],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * The peer already holding this ticker, if any — the friendly half of the
 * unique index, asked as a lookup.
 *
 * Both callers had scanned the whole peer set for it. That was correct only
 * while the set was the whole set: from a capped page the check misses a
 * duplicate sitting past the cap, the insert then hits the index, and the
 * analyst gets a 500 in place of the sentence this function exists to produce.
 */
export async function findComparableByTicker(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  ticker: string,
): Promise<ComparableItemRow | null> {
  const { rows } = await pool.query<RawComparableItemRow>(
    'SELECT * FROM comparable_items WHERE valuation_id = $1 AND ticker = $2',
    [valuationId, ticker],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export interface ComparableItemInput {
  valuationId: string;
  ticker?: string | null;
  name: string;
  sic?: string | null;
  source: ComparableSource;
  included?: boolean;
  excludeReason?: string | null;
  revenueLtm?: number | null;
  revenueNtm?: number | null;
  ebitdaLtm?: number | null;
  ebitdaNtm?: number | null;
  ev?: number | null;
  score?: number | null;
  scoreBreakdown?: unknown;
  /** Both or neither — the schema's pair CHECK, stated once here too. */
  figuresSource?: ComparableFiguresSource | null;
  figuresAsOf?: Date | null;
  createdBy?: string | null;
}

/**
 * The target and its column order, shared by the single-row insert and the
 * batch in `replaceMachineComparables` — stated once so the two cannot drift
 * apart from each other or from `insertParams`, which supplies both.
 */
const INSERT_COLUMNS = `
  INSERT INTO comparable_items
    (id, valuation_id, ticker, name, sic, source, included, exclude_reason,
     revenue_ltm, revenue_ntm, ebitda_ltm, ebitda_ntm, ev, score, score_breakdown,
     figures_source, figures_as_of, created_by)`;

/** `score_breakdown`, the one parameter that needs a cast. Index into `insertParams`. */
const JSONB_PARAM_INDEX = 14;

const INSERT_SQL = `${INSERT_COLUMNS}
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)`;

function insertParams(input: ComparableItemInput): unknown[] {
  // A source with no moment is a claim with no vintage, and a moment with no
  // source names nothing. The schema refuses the mismatch; normalising here
  // means a caller that sets one and forgets the other gets the sane row
  // rather than a constraint violation halfway through a bulk screen.
  const figuresSource = input.figuresSource ?? null;
  const figuresAsOf = figuresSource === null ? null : (input.figuresAsOf ?? new Date());
  return [
    newUlid(),
    input.valuationId,
    input.ticker ?? null,
    input.name,
    input.sic ?? null,
    input.source,
    input.included ?? true,
    input.excludeReason ?? null,
    input.revenueLtm ?? null,
    input.revenueNtm ?? null,
    input.ebitdaLtm ?? null,
    input.ebitdaNtm ?? null,
    input.ev ?? null,
    input.score ?? null,
    JSON.stringify(input.scoreBreakdown ?? {}),
    figuresSource,
    figuresAsOf,
    input.createdBy ?? null,
  ];
}

export async function insertComparableItem(
  pool: pg.Pool | pg.PoolClient,
  input: ComparableItemInput,
): Promise<ComparableItemRow> {
  const { rows } = await pool.query<RawComparableItemRow>(`${INSERT_SQL} RETURNING *`, insertParams(input));
  return hydrate(rows[0]!);
}

export interface ComparableItemPatch {
  ticker?: string | null;
  name?: string;
  sic?: string | null;
  included?: boolean;
  excludeReason?: string | null;
  revenueLtm?: number | null;
  revenueNtm?: number | null;
  ebitdaLtm?: number | null;
  ebitdaNtm?: number | null;
  ev?: number | null;
  figuresSource?: ComparableFiguresSource | null;
  figuresAsOf?: Date | null;
}

const PATCH_COLUMNS: Array<[keyof ComparableItemPatch, string]> = [
  ['ticker', 'ticker'],
  ['name', 'name'],
  ['sic', 'sic'],
  ['included', 'included'],
  ['excludeReason', 'exclude_reason'],
  ['revenueLtm', 'revenue_ltm'],
  ['revenueNtm', 'revenue_ntm'],
  ['ebitdaLtm', 'ebitda_ltm'],
  ['ebitdaNtm', 'ebitda_ntm'],
  ['ev', 'ev'],
  ['figuresSource', 'figures_source'],
  ['figuresAsOf', 'figures_as_of'],
];

/** Sparse update; an absent key leaves the column alone, an explicit null clears it. */
export async function updateComparableItem(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  itemId: string,
  patch: ComparableItemPatch,
): Promise<ComparableItemRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of PATCH_COLUMNS) {
    if (!(key in patch)) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findComparableItem(pool, valuationId, itemId);
  params.push(itemId, valuationId);
  const { rows } = await pool.query<RawComparableItemRow>(
    `UPDATE comparable_items SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length - 1} AND valuation_id = $${params.length}
      RETURNING *`,
    params,
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function deleteComparableItem(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  itemId: string,
): Promise<boolean> {
  const result = await pool.query(`DELETE FROM comparable_items WHERE id = $1 AND valuation_id = $2`, [
    itemId,
    valuationId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Write a screen's output over the machine-sourced half of the set.
 *
 * Analyst rows survive untouched, and so does an analyst's include/exclude
 * decision on a machine row: `keepDecisions` carries the (ticker → decision)
 * pairs forward so a re-screen does not silently re-admit a comp somebody
 * excluded with a reason. Re-screening is a refresh of the data, not a reset of
 * the judgement — an analyst who has to re-exclude the same three comps after
 * every screen stops re-screening.
 *
 * One transaction: a delete that commits without its insert leaves an
 * engagement with an empty peer set and a calculation that silently falls back
 * to the AI aggregate.
 */
export async function replaceMachineComparables(
  pool: pg.Pool,
  valuationId: string,
  source: Exclude<ComparableSource, 'analyst'>,
  items: readonly Omit<ComparableItemInput, 'valuationId' | 'source'>[],
): Promise<ComparableItemRow[]> {
  return withTransaction(pool, async (tx) => {
    const { rows: prior } = await tx.query<{
      ticker: string | null;
      included: boolean;
      exclude_reason: string | null;
    }>(`SELECT ticker, included, exclude_reason FROM comparable_items WHERE valuation_id = $1`, [
      valuationId,
    ]);
    const decisions = new Map(
      prior
        .filter((r) => r.ticker !== null)
        .map((r) => [r.ticker!, { included: r.included, excludeReason: r.exclude_reason }]),
    );

    await tx.query(`DELETE FROM comparable_items WHERE valuation_id = $1 AND source = $2`, [
      valuationId,
      source,
    ]);

    // A ticker an analyst already holds by hand is theirs; the screen does not
    // get to insert a second row for it (the unique index would reject it, and
    // the analyst's own figures are the ones they entered on purpose).
    const { rows: kept } = await tx.query<{ ticker: string | null }>(
      `SELECT ticker FROM comparable_items WHERE valuation_id = $1 AND ticker IS NOT NULL`,
      [valuationId],
    );
    const taken = new Set(kept.map((r) => r.ticker!));

    // Decide the whole set first, then write it in one statement. A screen
    // returns tens of peers and this used to be one round trip each, inside
    // the transaction holding the delete above.
    const admitted: ComparableItemInput[] = [];
    for (const item of items) {
      if (item.ticker && taken.has(item.ticker)) continue;
      const decision = item.ticker ? decisions.get(item.ticker) : undefined;
      admitted.push({
        ...item,
        valuationId,
        source,
        included: decision ? decision.included : (item.included ?? true),
        excludeReason: decision ? decision.excludeReason : (item.excludeReason ?? null),
      });
      // A ticker repeated inside one screen is admitted once — the unique
      // index would reject the second, and the loop this replaces skipped it.
      if (item.ticker) taken.add(item.ticker);
    }
    if (admitted.length === 0) return [];

    // Tuples are built from `insertParams`, so the batch cannot drift from the
    // single-row INSERT's column order: both read the same function.
    const params: unknown[] = [];
    const tuples = admitted.map((item) => {
      const values = insertParams(item);
      const base = params.length;
      params.push(...values);
      return `(${values.map((_, i) => `$${base + i + 1}${i === JSONB_PARAM_INDEX ? '::jsonb' : ''}`).join(', ')})`;
    });
    const { rows } = await tx.query<RawComparableItemRow>(
      `${INSERT_COLUMNS} VALUES ${tuples.join(', ')} RETURNING *`,
      params,
    );
    return rows.map(hydrate);
  });
}
