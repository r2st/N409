import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { calendarDateRow } from '../domain/calendarDate.js';
import { MeasurementLinkConflict } from '../domain/measurementLink.js';
import { isUniqueViolation } from '../db/pgError.js';

export type FundType = 'vc' | 'pe' | 'credit' | 'growth' | 'other';
export type SecurityType = 'common' | 'preferred' | 'safe' | 'note' | 'warrant' | 'other';
export type MarkMethod = 'market' | 'last_round' | 'calibrated_opm' | 'cost';

export interface FundRow {
  id: string;
  name: string;
  fund_type: FundType;
  currency: string;
  vintage_year: number | null;
  /** The engagement this portfolio is measured for, or null when ops are marking it standalone (0109). */
  valuation_id: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface FundPositionRow {
  id: string;
  fund_id: string;
  company_name: string;
  security_type: SecurityType;
  quantity: string;
  cost_basis: string;
  mark_method: MarkMethod;
  created_at: Date;
}

export interface FundMarkRow {
  id: string;
  position_id: string;
  /**
   * A `date` column. node-postgres parses OID 1082 into a JS Date; every read
   * path below now puts it back through `calendarDateRow`, so past the repo it
   * is the `YYYY-MM-DD` this says and not the instant the driver produced. It
   * was declared `string | Date` while that was untrue, which pushed the
   * question onto each consumer — and the two `reply.send({ mark })` sites in
   * routes/funds.ts answered it by shipping an ISO instant on the day before.
   */
  measurement_date: string;
  method: MarkMethod;
  fair_value: string;
  level: number;
  inputs: Record<string, unknown> | null;
  created_by: string | null;
  created_at: Date;
}

export interface LpTermsRow {
  fund_id: string;
  committed_capital: string;
  contributed_capital: string;
  preferred_return_rate: string;
  carry_pct: string;
  gp_catch_up: boolean;
  management_fee_pct: string;
  management_fees_paid: string;
  gp_distributions_to_date: string;
  updated_at: Date;
}

// ── Funds ─────────────────────────────────────────────────────────────────

/** Ceiling on one page of a list that grows with the business. */
export const FUND_PAGE_LIMIT = 200;

/**
 * Every portfolio, newest first — a page of them.
 *
 * Bounded because nothing else bounded it: the table grows with the number of
 * funds under management and the page that reads it is a picker plus a table,
 * neither of which is improved by a thousandth row. `truncated` is returned so
 * the caller can say the list is partial rather than imply it is complete.
 */
export async function listFunds(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ funds: FundRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? FUND_PAGE_LIMIT, 1), FUND_PAGE_LIMIT);
  const { rows } = await pool.query<FundRow>(
    'SELECT * FROM fund_portfolios ORDER BY created_at DESC LIMIT $1',
    [limit + 1],
  );
  return { funds: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findFund(pool: pg.Pool, id: string): Promise<FundRow | null> {
  const { rows } = await pool.query<FundRow>('SELECT * FROM fund_portfolios WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** The portfolio an engagement measures, if one has been linked (0109). */
export async function findFundByValuation(pool: pg.Pool, valuationId: string): Promise<FundRow | null> {
  const { rows } = await pool.query<FundRow>('SELECT * FROM fund_portfolios WHERE valuation_id = $1', [
    valuationId,
  ]);
  return rows[0] ?? null;
}

/** Point a portfolio at an engagement, or (null) detach it (0109). */
export async function linkFundToValuation(
  pool: pg.Pool,
  fundId: string,
  valuationId: string | null,
): Promise<FundRow | null> {
  try {
    const { rows } = await pool.query<FundRow>(
      'UPDATE fund_portfolios SET valuation_id = $2 WHERE id = $1 RETURNING *',
      [fundId, valuationId],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isUniqueViolation(err, 'fund_portfolios_valuation_uniq'))
      throw new MeasurementLinkConflict('That engagement is already linked to another fund portfolio');
    throw err;
  }
}

export async function createFund(
  pool: pg.Pool,
  input: {
    name: string;
    fundType: FundType;
    currency: string;
    vintageYear: number | null;
    createdBy: string;
  },
): Promise<FundRow> {
  const { rows } = await pool.query<FundRow>(
    `INSERT INTO fund_portfolios (id, name, fund_type, currency, vintage_year, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), input.name, input.fundType, input.currency, input.vintageYear, input.createdBy],
  );
  return rows[0]!;
}

/**
 * Rename / reclassify a portfolio. Every field is optional; an absent one is
 * left alone rather than nulled, so a caller correcting a vintage year cannot
 * blank the fund's name by omission.
 *
 * `valuation_id` is deliberately not patchable here — linking a portfolio to an
 * engagement is `linkFundToValuation`, which has a uniqueness conflict to
 * translate and an audit story of its own.
 */
export async function updateFund(
  pool: pg.Pool,
  id: string,
  patch: { name?: string; fundType?: FundType; currency?: string; vintageYear?: number | null },
): Promise<FundRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.fundType !== undefined) add('fund_type', patch.fundType);
  if (patch.currency !== undefined) add('currency', patch.currency);
  if (patch.vintageYear !== undefined) add('vintage_year', patch.vintageYear);
  if (sets.length === 0) return findFund(pool, id);
  const { rows } = await pool.query<FundRow>(
    `UPDATE fund_portfolios SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * Remove a portfolio and everything keyed to it.
 *
 * `fund_positions`, `fund_marks` and `lp_terms` all cascade from this row
 * (0086), so the mark history goes with the fund. That is why the route refuses
 * to delete a portfolio linked to an engagement: those marks are the NAV a
 * report we have issued speaks for. Returns false when the row is already gone.
 */
export async function deleteFund(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM fund_portfolios WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

// ── Positions ─────────────────────────────────────────────────────────────

/**
 * Ceiling on one page of a fund's holdings.
 *
 * This query had no `LIMIT`. Two hundred is more positions than a fund of funds
 * carries and the flag is what makes the cap safe: NAV, the level breakdown and
 * the unrealised-gain total on the fund page are all sums over the rows this
 * returns, so a silently short list is a wrong NAV rather than a short table.
 */
export const FUND_POSITION_PAGE_LIMIT = 200;

export async function listPositions(
  pool: pg.Pool,
  fundId: string,
  opts: { limit?: number } = {},
): Promise<{ positions: FundPositionRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? FUND_POSITION_PAGE_LIMIT, 1), FUND_POSITION_PAGE_LIMIT);
  const { rows } = await pool.query<FundPositionRow>(
    'SELECT * FROM fund_positions WHERE fund_id = $1 ORDER BY company_name LIMIT $2',
    [fundId, limit + 1],
  );
  return { positions: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findPosition(
  pool: pg.Pool,
  fundId: string,
  positionId: string,
): Promise<FundPositionRow | null> {
  const { rows } = await pool.query<FundPositionRow>(
    'SELECT * FROM fund_positions WHERE id = $1 AND fund_id = $2',
    [positionId, fundId],
  );
  return rows[0] ?? null;
}

export async function createPosition(
  pool: pg.Pool,
  input: {
    fundId: string;
    companyName: string;
    securityType: SecurityType;
    quantity: number;
    costBasis: number;
    markMethod: MarkMethod;
  },
): Promise<FundPositionRow> {
  const { rows } = await pool.query<FundPositionRow>(
    `INSERT INTO fund_positions (id, fund_id, company_name, security_type, quantity, cost_basis, mark_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      newUlid(),
      input.fundId,
      input.companyName,
      input.securityType,
      input.quantity,
      input.costBasis,
      input.markMethod,
    ],
  );
  return rows[0]!;
}

/**
 * Correct a holding in place. Same optional-field rule as {@link updateFund}.
 *
 * Changing `quantity` or `mark_method` does not rewrite the marks already
 * taken: a mark records the fair value concluded on its measurement date from
 * the inputs of the day, and back-dating it to a corrected share count would
 * restate a figure that has already been reported. The new quantity is the
 * default the *next* mark is taken at.
 */
export async function updatePosition(
  pool: pg.Pool,
  fundId: string,
  positionId: string,
  patch: {
    companyName?: string;
    securityType?: SecurityType;
    quantity?: number;
    costBasis?: number;
    markMethod?: MarkMethod;
  },
): Promise<FundPositionRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [positionId, fundId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (patch.companyName !== undefined) add('company_name', patch.companyName);
  if (patch.securityType !== undefined) add('security_type', patch.securityType);
  if (patch.quantity !== undefined) add('quantity', patch.quantity);
  if (patch.costBasis !== undefined) add('cost_basis', patch.costBasis);
  if (patch.markMethod !== undefined) add('mark_method', patch.markMethod);
  if (sets.length === 0) return findPosition(pool, fundId, positionId);
  const { rows } = await pool.query<FundPositionRow>(
    `UPDATE fund_positions SET ${sets.join(', ')} WHERE id = $1 AND fund_id = $2 RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * Remove a holding and its marks (`fund_marks` cascades from it, 0086).
 *
 * Scoped by `fund_id` as well as by id, like every other position query here:
 * a position id from one fund must not delete a row out of another, and the
 * route's 404 for a mismatched pair depends on this clause rather than on the
 * caller having checked first.
 */
export async function deletePosition(pool: pg.Pool, fundId: string, positionId: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM fund_positions WHERE id = $1 AND fund_id = $2', [
    positionId,
    fundId,
  ]);
  return (rowCount ?? 0) > 0;
}

// ── Marks (append-only history) ─────────────────────────────────────────────

/** See the note on `FundMarkRow.measurement_date` and domain/calendarDate.ts. */
const mark = (row: FundMarkRow): FundMarkRow => calendarDateRow(row, 'measurement_date');

/**
 * Ceiling on one page of a holding's mark trail.
 *
 * Append-only and quarterly at minimum, so two hundred is decades of marks for
 * one position — but it grows without bound and every roll-forward adds a row,
 * so the cap is reported rather than assumed unreachable.
 */
export const FUND_MARK_PAGE_LIMIT = 200;

export async function listMarks(
  pool: pg.Pool,
  positionId: string,
  opts: { limit?: number } = {},
): Promise<{ marks: FundMarkRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? FUND_MARK_PAGE_LIMIT, 1), FUND_MARK_PAGE_LIMIT);
  const { rows } = await pool.query<FundMarkRow>(
    `SELECT * FROM fund_marks WHERE position_id = $1
      ORDER BY measurement_date DESC, created_at DESC LIMIT $2`,
    [positionId, limit + 1],
  );
  return { marks: rows.slice(0, limit).map(mark), truncated: rows.length > limit };
}

/** Latest mark per position for a fund (for the NAV roll-up). */
/**
 * The current mark for each of `positionIds`, newest measurement first.
 *
 * Keyed on the positions rather than on the fund. Both callers hand this the
 * page `listPositions` returned and then look each position up in the map, so
 * asking by fund read a mark for every position the fund holds — including the
 * ones past `FUND_POSITION_PAGE_LIMIT`, whose marks were loaded and dropped.
 * The bound now comes from the page, which is where the caller's bound already
 * was; nothing about which mark answers for a position changes.
 */
export async function latestMarks(
  pool: pg.Pool,
  positionIds: readonly string[],
): Promise<Map<string, FundMarkRow>> {
  if (positionIds.length === 0) return new Map();
  const { rows } = await pool.query<FundMarkRow>(
    `SELECT DISTINCT ON (m.position_id) m.*
       FROM fund_marks m
      WHERE m.position_id = ANY($1::ulid[])
      ORDER BY m.position_id, m.measurement_date DESC, m.created_at DESC`,
    [[...new Set(positionIds)]],
  );
  const map = new Map<string, FundMarkRow>();
  for (const r of rows) map.set(r.position_id, mark(r));
  return map;
}

export async function createMark(
  pool: pg.Pool,
  input: {
    positionId: string;
    measurementDate: string;
    method: MarkMethod;
    fairValue: number;
    level: number;
    inputs: Record<string, unknown> | null;
    createdBy: string;
  },
): Promise<FundMarkRow> {
  const { rows } = await pool.query<FundMarkRow>(
    `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level, inputs, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      newUlid(),
      input.positionId,
      input.measurementDate,
      input.method,
      input.fairValue,
      input.level,
      input.inputs ? JSON.stringify(input.inputs) : null,
      input.createdBy,
    ],
  );
  return mark(rows[0]!);
}

// ── LP terms ────────────────────────────────────────────────────────────────

export async function findLpTerms(pool: pg.Pool, fundId: string): Promise<LpTermsRow | null> {
  const { rows } = await pool.query<LpTermsRow>('SELECT * FROM lp_terms WHERE fund_id = $1', [fundId]);
  return rows[0] ?? null;
}

export async function upsertLpTerms(
  pool: pg.Pool,
  fundId: string,
  input: {
    committedCapital: number;
    contributedCapital: number;
    preferredReturnRate: number;
    carryPct: number;
    gpCatchUp: boolean;
    managementFeePct: number;
    managementFeesPaid: number;
    gpDistributionsToDate: number;
  },
): Promise<LpTermsRow> {
  const { rows } = await pool.query<LpTermsRow>(
    `INSERT INTO lp_terms
       (fund_id, committed_capital, contributed_capital, preferred_return_rate, carry_pct,
        gp_catch_up, management_fee_pct, management_fees_paid, gp_distributions_to_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (fund_id) DO UPDATE SET
       committed_capital = EXCLUDED.committed_capital,
       contributed_capital = EXCLUDED.contributed_capital,
       preferred_return_rate = EXCLUDED.preferred_return_rate,
       carry_pct = EXCLUDED.carry_pct,
       gp_catch_up = EXCLUDED.gp_catch_up,
       management_fee_pct = EXCLUDED.management_fee_pct,
       management_fees_paid = EXCLUDED.management_fees_paid,
       gp_distributions_to_date = EXCLUDED.gp_distributions_to_date,
       updated_at = now()
     RETURNING *`,
    [
      fundId,
      input.committedCapital,
      input.contributedCapital,
      input.preferredReturnRate,
      input.carryPct,
      input.gpCatchUp,
      input.managementFeePct,
      input.managementFeesPaid,
      input.gpDistributionsToDate,
    ],
  );
  return rows[0]!;
}
