import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { MeasurementLinkConflict } from '../domain/measurementLink.js';

export type InstrumentType = 'bond' | 'term_loan' | 'convertible' | 'safe' | 'credit_spread';
export type Seniority = 'senior_secured' | 'senior' | 'subordinated' | 'mezzanine';

export interface DebtInstrumentRow {
  id: string;
  name: string;
  instrument_type: InstrumentType;
  currency: string;
  params: Record<string, unknown>;
  /** The engagement this instrument is priced for, or null when ops are pricing it standalone (0109). */
  valuation_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreditTermsRow {
  instrument_id: string;
  rating: string | null;
  benchmark_yield: string | null;
  spread: string | null;
  seniority: Seniority;
  secured: boolean;
  updated_at: Date;
}

export interface DebtValuationRow {
  id: string;
  instrument_id: string;
  /** A `date` column — a JS Date at runtime. See FundMarkRow.measurement_date. */
  valuation_date: string | Date;
  inputs: Record<string, unknown>;
  result: Record<string, unknown>;
  fair_value: string | null;
  created_by: string | null;
  created_at: Date;
}

export async function listInstruments(pool: pg.Pool): Promise<DebtInstrumentRow[]> {
  const { rows } = await pool.query<DebtInstrumentRow>(
    'SELECT * FROM debt_instruments ORDER BY created_at DESC',
  );
  return rows;
}

export async function findInstrument(pool: pg.Pool, id: string): Promise<DebtInstrumentRow | null> {
  const { rows } = await pool.query<DebtInstrumentRow>('SELECT * FROM debt_instruments WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** The instrument an engagement prices, if one has been linked (0109). */
export async function findInstrumentByValuation(
  pool: pg.Pool,
  valuationId: string,
): Promise<DebtInstrumentRow | null> {
  const { rows } = await pool.query<DebtInstrumentRow>(
    'SELECT * FROM debt_instruments WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

/** Point an instrument at an engagement, or (null) detach it (0109). */
export async function linkInstrumentToValuation(
  pool: pg.Pool,
  instrumentId: string,
  valuationId: string | null,
): Promise<DebtInstrumentRow | null> {
  try {
    const { rows } = await pool.query<DebtInstrumentRow>(
      'UPDATE debt_instruments SET valuation_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [instrumentId, valuationId],
    );
    return rows[0] ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw new MeasurementLinkConflict('That engagement is already linked to another debt instrument');
    throw err;
  }
}

export async function createInstrument(
  pool: pg.Pool,
  input: {
    name: string;
    instrumentType: InstrumentType;
    currency: string;
    params: Record<string, unknown>;
    createdBy: string;
  },
): Promise<DebtInstrumentRow> {
  const { rows } = await pool.query<DebtInstrumentRow>(
    `INSERT INTO debt_instruments (id, name, instrument_type, currency, params, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      newUlid(),
      input.name,
      input.instrumentType,
      input.currency,
      JSON.stringify(input.params),
      input.createdBy,
    ],
  );
  return rows[0]!;
}

export async function updateInstrument(
  pool: pg.Pool,
  id: string,
  input: { name?: string; params?: Record<string, unknown> },
): Promise<DebtInstrumentRow | null> {
  const { rows } = await pool.query<DebtInstrumentRow>(
    `UPDATE debt_instruments SET
       name = COALESCE($2, name),
       params = COALESCE($3, params),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, input.name ?? null, input.params ? JSON.stringify(input.params) : null],
  );
  return rows[0] ?? null;
}

export async function findCreditTerms(pool: pg.Pool, instrumentId: string): Promise<CreditTermsRow | null> {
  const { rows } = await pool.query<CreditTermsRow>('SELECT * FROM credit_terms WHERE instrument_id = $1', [
    instrumentId,
  ]);
  return rows[0] ?? null;
}

export async function upsertCreditTerms(
  pool: pg.Pool,
  instrumentId: string,
  input: {
    rating: string | null;
    benchmarkYield: number | null;
    spread: number | null;
    seniority: Seniority;
    secured: boolean;
  },
): Promise<CreditTermsRow> {
  const { rows } = await pool.query<CreditTermsRow>(
    `INSERT INTO credit_terms (instrument_id, rating, benchmark_yield, spread, seniority, secured)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (instrument_id) DO UPDATE SET
       rating = EXCLUDED.rating,
       benchmark_yield = EXCLUDED.benchmark_yield,
       spread = EXCLUDED.spread,
       seniority = EXCLUDED.seniority,
       secured = EXCLUDED.secured,
       updated_at = now()
     RETURNING *`,
    [instrumentId, input.rating, input.benchmarkYield, input.spread, input.seniority, input.secured],
  );
  return rows[0]!;
}

export async function listValuations(pool: pg.Pool, instrumentId: string): Promise<DebtValuationRow[]> {
  const { rows } = await pool.query<DebtValuationRow>(
    'SELECT * FROM debt_valuations WHERE instrument_id = $1 ORDER BY created_at DESC LIMIT 50',
    [instrumentId],
  );
  return rows;
}

export async function createValuation(
  pool: pg.Pool,
  input: {
    instrumentId: string;
    valuationDate: string;
    inputs: Record<string, unknown>;
    result: Record<string, unknown>;
    fairValue: number | null;
    createdBy: string;
  },
): Promise<DebtValuationRow> {
  const { rows } = await pool.query<DebtValuationRow>(
    `INSERT INTO debt_valuations (id, instrument_id, valuation_date, inputs, result, fair_value, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      newUlid(),
      input.instrumentId,
      input.valuationDate,
      JSON.stringify(input.inputs),
      JSON.stringify(input.result),
      input.fairValue,
      input.createdBy,
    ],
  );
  return rows[0]!;
}
