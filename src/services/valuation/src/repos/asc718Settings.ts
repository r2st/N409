import type pg from 'pg';

/** Persistent ASC 718 configuration for a valuation (public-company path). */
export interface Asc718SettingsRow {
  valuation_id: string;
  company_type: 'private' | 'public';
  ticker: string | null;
  expected_term_method: 'simplified' | 'lattice' | 'historical';
  espp_discount_pct: string | null;
  espp_lookback_months: number | null;
  rsu_performance_conditions: Record<string, unknown> | null;
  tsr_peer_basket: unknown[] | null;
  updated_at: Date;
  updated_by: string | null;
}

export interface Asc718SettingsInput {
  companyType: 'private' | 'public';
  ticker?: string | null;
  expectedTermMethod?: 'simplified' | 'lattice' | 'historical';
  esppDiscountPct?: number | null;
  esppLookbackMonths?: number | null;
  rsuPerformanceConditions?: Record<string, unknown> | null;
  tsrPeerBasket?: unknown[] | null;
  updatedBy: string;
}

export async function findAsc718Settings(
  pool: pg.Pool,
  valuationId: string,
): Promise<Asc718SettingsRow | null> {
  const { rows } = await pool.query<Asc718SettingsRow>(
    'SELECT * FROM asc718_settings WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

export async function upsertAsc718Settings(
  pool: pg.Pool,
  valuationId: string,
  input: Asc718SettingsInput,
): Promise<Asc718SettingsRow> {
  const { rows } = await pool.query<Asc718SettingsRow>(
    `INSERT INTO asc718_settings
       (valuation_id, company_type, ticker, expected_term_method,
        espp_discount_pct, espp_lookback_months, rsu_performance_conditions,
        tsr_peer_basket, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (valuation_id) DO UPDATE SET
       company_type = EXCLUDED.company_type,
       ticker = EXCLUDED.ticker,
       expected_term_method = EXCLUDED.expected_term_method,
       espp_discount_pct = EXCLUDED.espp_discount_pct,
       espp_lookback_months = EXCLUDED.espp_lookback_months,
       rsu_performance_conditions = EXCLUDED.rsu_performance_conditions,
       tsr_peer_basket = EXCLUDED.tsr_peer_basket,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      valuationId,
      input.companyType,
      input.ticker ?? null,
      input.expectedTermMethod ?? 'simplified',
      input.esppDiscountPct ?? null,
      input.esppLookbackMonths ?? null,
      input.rsuPerformanceConditions ? JSON.stringify(input.rsuPerformanceConditions) : null,
      input.tsrPeerBasket ? JSON.stringify(input.tsrPeerBasket) : null,
      input.updatedBy,
    ],
  );
  return rows[0]!;
}
