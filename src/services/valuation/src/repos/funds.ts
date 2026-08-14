import type pg from 'pg';
import { newUlid } from '@n409/shared';
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
   * A `date` column. node-postgres parses OID 1082 into a JS Date and nothing
   * here overrides that, so this is a Date at runtime however it was written —
   * declared honestly because reading it as a string silently throws at the
   * first `.slice()`, which is how it reached the PDF renderer.
   */
  measurement_date: string | Date;
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

// ── Positions ─────────────────────────────────────────────────────────────

export async function listPositions(pool: pg.Pool, fundId: string): Promise<FundPositionRow[]> {
  const { rows } = await pool.query<FundPositionRow>(
    'SELECT * FROM fund_positions WHERE fund_id = $1 ORDER BY company_name',
    [fundId],
  );
  return rows;
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

// ── Marks (append-only history) ─────────────────────────────────────────────

export async function listMarks(pool: pg.Pool, positionId: string): Promise<FundMarkRow[]> {
  const { rows } = await pool.query<FundMarkRow>(
    'SELECT * FROM fund_marks WHERE position_id = $1 ORDER BY measurement_date DESC, created_at DESC',
    [positionId],
  );
  return rows;
}

/** Latest mark per position for a fund (for the NAV roll-up). */
export async function latestMarks(pool: pg.Pool, fundId: string): Promise<Map<string, FundMarkRow>> {
  const { rows } = await pool.query<FundMarkRow>(
    `SELECT DISTINCT ON (m.position_id) m.*
       FROM fund_marks m
       JOIN fund_positions p ON p.id = m.position_id
      WHERE p.fund_id = $1
      ORDER BY m.position_id, m.measurement_date DESC, m.created_at DESC`,
    [fundId],
  );
  const map = new Map<string, FundMarkRow>();
  for (const r of rows) map.set(r.position_id, r);
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
  return rows[0]!;
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
