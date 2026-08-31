import type { Queryable } from '../db/pool.js';
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
  db: Queryable,
  opts: { limit?: number } = {},
): Promise<{ funds: FundRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? FUND_PAGE_LIMIT, 1), FUND_PAGE_LIMIT);
  const { rows } = await db.query<FundRow>(
    'SELECT * FROM fund_portfolios ORDER BY created_at DESC LIMIT $1',
    [limit + 1],
  );
  return { funds: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findFund(db: Queryable, id: string): Promise<FundRow | null> {
  const { rows } = await db.query<FundRow>('SELECT * FROM fund_portfolios WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * The portfolio, with its row held for the rest of the transaction.
 *
 * For `PUT /funds/:id/valuation`, which is a read-then-write pair: it decides
 * which engagement's spine gets `measurement_subject_unlinked` from the link
 * the row *had*, and then overwrites it. Read on the pool, those are two
 * statements with a gap, and a second link change landing in the gap makes the
 * first half describe a state that no longer exists — the detach event goes to
 * the engagement the fund used to be on, and the one it was actually taken off
 * is never told. Its trail then says the portfolio is its measurement subject
 * with nothing afterwards saying it stopped, which is what an auditor reads to
 * find out where the NAV schedule went.
 *
 * `FOR UPDATE` makes the pair atomic against a second change to the same
 * portfolio, exactly as `restoreValuations` uses it against a second restore of
 * the same id.
 */
export async function lockFund(db: Queryable, id: string): Promise<FundRow | null> {
  const { rows } = await db.query<FundRow>('SELECT * FROM fund_portfolios WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ?? null;
}

/** The portfolio an engagement measures, if one has been linked (0109). */
export async function findFundByValuation(db: Queryable, valuationId: string): Promise<FundRow | null> {
  const { rows } = await db.query<FundRow>('SELECT * FROM fund_portfolios WHERE valuation_id = $1', [
    valuationId,
  ]);
  return rows[0] ?? null;
}

/** Point a portfolio at an engagement, or (null) detach it (0109). */
export async function linkFundToValuation(
  db: Queryable,
  fundId: string,
  valuationId: string | null,
): Promise<FundRow | null> {
  try {
    const { rows } = await db.query<FundRow>(
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
  db: Queryable,
  input: {
    name: string;
    fundType: FundType;
    currency: string;
    vintageYear: number | null;
    createdBy: string;
  },
): Promise<FundRow> {
  const { rows } = await db.query<FundRow>(
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
  db: Queryable,
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
  if (sets.length === 0) return findFund(db, id);
  const { rows } = await db.query<FundRow>(
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
export async function deleteFund(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM fund_portfolios WHERE id = $1', [id]);
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
  db: Queryable,
  fundId: string,
  opts: { limit?: number } = {},
): Promise<{ positions: FundPositionRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? FUND_POSITION_PAGE_LIMIT, 1), FUND_POSITION_PAGE_LIMIT);
  const { rows } = await db.query<FundPositionRow>(
    'SELECT * FROM fund_positions WHERE fund_id = $1 ORDER BY company_name LIMIT $2',
    [fundId, limit + 1],
  );
  return { positions: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findPosition(
  db: Queryable,
  fundId: string,
  positionId: string,
): Promise<FundPositionRow | null> {
  const { rows } = await db.query<FundPositionRow>(
    'SELECT * FROM fund_positions WHERE id = $1 AND fund_id = $2',
    [positionId, fundId],
  );
  return rows[0] ?? null;
}

/**
 * The holding, held against deletion for the rest of the transaction.
 *
 * For the two routes that write a `fund_marks` row after an engine round trip.
 * `fund_marks.position_id` is a NOT NULL foreign key (0086) and the value they
 * INSERT comes from a copy read on the pool *before* the call — so a `DELETE
 * /funds/:id/positions/:pid` landing inside the call left the INSERT raising
 * 23503. That is not a SQLSTATE `databaseUnavailableReason` recognises, so it
 * reached the caller as `urn:n409:problem:internal`: a 500 telling somebody the
 * server is broken, with catalogued advice to retry a request that can never
 * succeed, and an `alert: true` page for two people editing one portfolio.
 *
 * `FOR KEY SHARE` rather than `FOR SHARE` or `FOR UPDATE`, and the difference
 * matters here: it is the lock the foreign-key check itself takes, so it says
 * exactly what this needs — the key must not disappear — while leaving two
 * concurrent marks on the same holding free to proceed. It conflicts with the
 * `FOR UPDATE` a DELETE takes, which is what makes the two orders the only two
 * orders: either this transaction holds the row and the delete waits (the mark
 * lands, then the holding goes and cascades it, and the removal event counts
 * it), or the delete commits first and this reads back nothing and 404s.
 *
 * Scoped by `fund_id` like every other position query here, for the reason
 * `deletePosition` gives.
 */
export async function lockPosition(
  db: Queryable,
  fundId: string,
  positionId: string,
): Promise<FundPositionRow | null> {
  const { rows } = await db.query<FundPositionRow>(
    'SELECT * FROM fund_positions WHERE id = $1 AND fund_id = $2 FOR KEY SHARE',
    [positionId, fundId],
  );
  return rows[0] ?? null;
}

export async function createPosition(
  db: Queryable,
  input: {
    fundId: string;
    companyName: string;
    securityType: SecurityType;
    quantity: number;
    costBasis: number;
    markMethod: MarkMethod;
  },
): Promise<FundPositionRow> {
  const { rows } = await db.query<FundPositionRow>(
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
  db: Queryable,
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
  if (sets.length === 0) return findPosition(db, fundId, positionId);
  const { rows } = await db.query<FundPositionRow>(
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
export async function deletePosition(db: Queryable, fundId: string, positionId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM fund_positions WHERE id = $1 AND fund_id = $2', [
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
  db: Queryable,
  positionId: string,
  opts: { limit?: number } = {},
): Promise<{ marks: FundMarkRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? FUND_MARK_PAGE_LIMIT, 1), FUND_MARK_PAGE_LIMIT);
  const { rows } = await db.query<FundMarkRow>(
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
 *
 * A LATERAL AND NOT A `DISTINCT ON`, because the two read different amounts of
 * the table to give the same answer. `DISTINCT ON` is a sort with a filter on
 * top: it cannot stop at the first row of each group, so it reads and sorts
 * every mark ever taken on every position of the page to keep the newest two
 * hundred. `fund_marks` is append-only and quarterly at minimum, so that set is
 * the *history* of the fund, and it grows for as long as the fund is held while
 * the answer stays two hundred rows wide.
 *
 * The lateral is one index scan per position that stops at its first row —
 * `fund_marks_position_idx` is `(position_id, measurement_date DESC)`, so the
 * head of each trail is where the scan starts. Measured on a 200-holding fund
 * inside a 1.6M-mark database: at 50 marks per holding, 37ms/5103 blocks
 * against 7.5ms/1025; at 100, 101ms/10176 against 2.5ms/1025. The old shape
 * doubles with the trail and the new one does not move, which is the whole
 * point — this sits on the fund page, on `GET /funds/:id/nav`, and on the
 * report render, and the NAV exhibit is a sum over exactly these rows.
 *
 * The *level* of that win is a property of the corpus rather than of the query:
 * on a database where the page's holdings are most of `fund_marks`, `DISTINCT
 * ON` reads the table end to end in one pass and touches fewer buffers while
 * still reading fifty times the rows. What changes unconditionally is that the
 * rows read stop being a function of how long the fund has been marked.
 *
 * Invisible to `listQueryScaling` for R193's reason: the endpoint issues one
 * statement however deep the trail gets, so a ratio over statement counts
 * cannot see cost inside one. `fundMarkRollupPlan` measures it instead.
 */
export async function latestMarks(
  db: Queryable,
  positionIds: readonly string[],
): Promise<Map<string, FundMarkRow>> {
  if (positionIds.length === 0) return new Map();
  const { rows } = await db.query<FundMarkRow>(
    `SELECT m.*
       FROM unnest($1::ulid[]) AS p(position_id)
       CROSS JOIN LATERAL (
         SELECT * FROM fund_marks fm
          WHERE fm.position_id = p.position_id
          ORDER BY fm.measurement_date DESC, fm.created_at DESC
          LIMIT 1
       ) m`,
    [[...new Set(positionIds)]],
  );
  const map = new Map<string, FundMarkRow>();
  for (const r of rows) map.set(r.position_id, mark(r));
  return map;
}

/**
 * How many marks a holding carries.
 *
 * A count rather than a page: its one caller is the `fund_position_removed`
 * event, which has to say how much of the mark trail the cascade took with the
 * holding, and the answer is a number rather than a list.
 */
export async function countMarks(db: Queryable, positionId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM fund_marks WHERE position_id = $1',
    [positionId],
  );
  return rows[0]!.n;
}

export async function createMark(
  db: Queryable,
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
  const { rows } = await db.query<FundMarkRow>(
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

export async function findLpTerms(db: Queryable, fundId: string): Promise<LpTermsRow | null> {
  const { rows } = await db.query<LpTermsRow>('SELECT * FROM lp_terms WHERE fund_id = $1', [fundId]);
  return rows[0] ?? null;
}

export async function upsertLpTerms(
  db: Queryable,
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
  const { rows } = await db.query<LpTermsRow>(
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
