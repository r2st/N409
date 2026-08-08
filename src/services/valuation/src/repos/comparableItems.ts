import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { ComparableSource } from '../domain/comparables.js';

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
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const NUMERIC_COLUMNS = ['revenue_ltm', 'revenue_ntm', 'ebitda_ltm', 'ebitda_ntm', 'ev', 'score'] as const;

function hydrate(row: Record<string, unknown>): ComparableItemRow {
  const out = { ...row } as Record<string, unknown>;
  for (const column of NUMERIC_COLUMNS) {
    const value = out[column];
    out[column] = value === null || value === undefined ? null : Number(value);
  }
  return out as unknown as ComparableItemRow;
}

/**
 * The whole set for one engagement.
 *
 * Included first, then by score descending, then by name — the order the tab
 * and the exhibit both read in, so a reviewer comparing the two is not
 * re-sorting in their head. Nulls sort last: an unscored analyst addition
 * belongs below the screened rows, not above them.
 */
export async function listComparableItems(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
): Promise<ComparableItemRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM comparable_items
      WHERE valuation_id = $1
      ORDER BY included DESC, score DESC NULLS LAST, name ASC`,
    [valuationId],
  );
  return rows.map(hydrate);
}

export async function findComparableItem(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  itemId: string,
): Promise<ComparableItemRow | null> {
  const { rows } = await pool.query(`SELECT * FROM comparable_items WHERE id = $1 AND valuation_id = $2`, [
    itemId,
    valuationId,
  ]);
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
  createdBy?: string | null;
}

const INSERT_SQL = `
  INSERT INTO comparable_items
    (id, valuation_id, ticker, name, sic, source, included, exclude_reason,
     revenue_ltm, revenue_ntm, ebitda_ltm, ebitda_ntm, ev, score, score_breakdown, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`;

function insertParams(input: ComparableItemInput): unknown[] {
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
    input.createdBy ?? null,
  ];
}

export async function insertComparableItem(
  pool: pg.Pool | pg.PoolClient,
  input: ComparableItemInput,
): Promise<ComparableItemRow> {
  const { rows } = await pool.query(`${INSERT_SQL} RETURNING *`, insertParams(input));
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
  const { rows } = await pool.query(
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

    const written: ComparableItemRow[] = [];
    for (const item of items) {
      if (item.ticker && taken.has(item.ticker)) continue;
      const decision = item.ticker ? decisions.get(item.ticker) : undefined;
      const { rows } = await tx.query(
        `${INSERT_SQL} RETURNING *`,
        insertParams({
          ...item,
          valuationId,
          source,
          included: decision ? decision.included : (item.included ?? true),
          excludeReason: decision ? decision.excludeReason : (item.excludeReason ?? null),
        }),
      );
      written.push(hydrate(rows[0]!));
      if (item.ticker) taken.add(item.ticker);
    }
    return written;
  });
}
