import type { Queryable } from '../db/pool.js';
import { newUlid } from '@n409/shared';
import { calendarDateRow } from '../domain/calendarDate.js';
import { MeasurementLinkConflict } from '../domain/measurementLink.js';
import { isUniqueViolation } from '../db/pgError.js';

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
  /** A `date` column, normalised to its day on the way out. See
   *  FundMarkRow.measurement_date and domain/calendarDate.ts. */
  valuation_date: string;
  inputs: Record<string, unknown>;
  result: Record<string, unknown>;
  fair_value: string | null;
  created_by: string | null;
  created_at: Date;
}

/** See the note on `DebtValuationRow.valuation_date`. */
const debtValuation = (row: DebtValuationRow): DebtValuationRow => calendarDateRow(row, 'valuation_date');

/**
 * Ceiling on one page of the instrument book.
 *
 * This query had no `LIMIT` at all: it read the whole table on every load of
 * the instruments page, for a table that grows with the practice and is never
 * pruned. Bounded here at the same 200 the fund book uses, and reported, so the
 * page that draws it can say a book is longer than the page rather than
 * silently becoming a shorter book.
 */
export const DEBT_INSTRUMENT_PAGE_LIMIT = 200;

export async function listInstruments(
  db: Queryable,
  opts: { limit?: number } = {},
): Promise<{ instruments: DebtInstrumentRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? DEBT_INSTRUMENT_PAGE_LIMIT, 1), DEBT_INSTRUMENT_PAGE_LIMIT);
  const { rows } = await db.query<DebtInstrumentRow>(
    'SELECT * FROM debt_instruments ORDER BY created_at DESC LIMIT $1',
    [limit + 1],
  );
  return { instruments: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findInstrument(db: Queryable, id: string): Promise<DebtInstrumentRow | null> {
  const { rows } = await db.query<DebtInstrumentRow>('SELECT * FROM debt_instruments WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** The instrument an engagement prices, if one has been linked (0109). */
export async function findInstrumentByValuation(
  db: Queryable,
  valuationId: string,
): Promise<DebtInstrumentRow | null> {
  const { rows } = await db.query<DebtInstrumentRow>(
    'SELECT * FROM debt_instruments WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

/** Point an instrument at an engagement, or (null) detach it (0109). */
export async function linkInstrumentToValuation(
  db: Queryable,
  instrumentId: string,
  valuationId: string | null,
): Promise<DebtInstrumentRow | null> {
  try {
    const { rows } = await db.query<DebtInstrumentRow>(
      'UPDATE debt_instruments SET valuation_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [instrumentId, valuationId],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isUniqueViolation(err, 'debt_instruments_valuation_uniq'))
      throw new MeasurementLinkConflict('That engagement is already linked to another debt instrument');
    throw err;
  }
}

export async function createInstrument(
  db: Queryable,
  input: {
    name: string;
    instrumentType: InstrumentType;
    currency: string;
    params: Record<string, unknown>;
    createdBy: string;
  },
): Promise<DebtInstrumentRow> {
  const { rows } = await db.query<DebtInstrumentRow>(
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
  db: Queryable,
  id: string,
  input: { name?: string; params?: Record<string, unknown> },
): Promise<DebtInstrumentRow | null> {
  const { rows } = await db.query<DebtInstrumentRow>(
    `UPDATE debt_instruments SET
       name = COALESCE($2, name),
       params = COALESCE($3, params),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, input.name ?? null, input.params ? JSON.stringify(input.params) : null],
  );
  return rows[0] ?? null;
}

/**
 * Remove an instrument and everything keyed to it.
 *
 * `credit_terms` and `debt_valuations` both cascade from this row (0087), so
 * the measurement history goes with the instrument — which is why the route
 * above refuses to delete one that is linked to an engagement: those marks are
 * the evidence behind a report we have issued. Returns false when the id is
 * already gone, so a double-submitted delete is a 404 rather than a 500.
 */
export async function deleteInstrument(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM debt_instruments WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function findCreditTerms(db: Queryable, instrumentId: string): Promise<CreditTermsRow | null> {
  const { rows } = await db.query<CreditTermsRow>('SELECT * FROM credit_terms WHERE instrument_id = $1', [
    instrumentId,
  ]);
  return rows[0] ?? null;
}

export async function upsertCreditTerms(
  db: Queryable,
  instrumentId: string,
  input: {
    rating: string | null;
    benchmarkYield: number | null;
    spread: number | null;
    seniority: Seniority;
    secured: boolean;
  },
): Promise<CreditTermsRow> {
  const { rows } = await db.query<CreditTermsRow>(
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

/**
 * An instrument's measurements, most recent measurement first.
 *
 * By `valuation_date`, not by `created_at`. The two agree only while nobody
 * measures out of order, and `POST /value` takes the date as a parameter, so
 * anything backfilled — a prior quarter entered after the current one, a
 * correction re-run — sorted by when it was typed. Two readers depend on this
 * order and both were wrong when it drifted: the history exhibit prints the
 * `valuation_date` column under the sentence "most recent first", which then
 * describes a table it does not match, and `loadDebtReport` takes the head for
 * the measurement the whole report speaks for, so the report concluded at
 * whichever price was entered last rather than the one that is current.
 *
 * `created_at` stays as the tiebreak, which is what decides two measurements
 * bearing the same date — a re-run after a correction, where the later run is
 * the one that stands. Same rule, same order, as `listMarks` on fund_marks.
 */
/**
 * Ceiling on one page of an instrument's measurement history.
 *
 * Fifty, and the ordering above is what makes saying so matter: the head of
 * this list is the measurement the whole report speaks for, so the reader has
 * every reason to treat the tail as the complete record behind it.
 */
export const DEBT_VALUATION_PAGE_LIMIT = 50;

export async function listValuations(
  db: Queryable,
  instrumentId: string,
  opts: { limit?: number } = {},
): Promise<{ valuations: DebtValuationRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? DEBT_VALUATION_PAGE_LIMIT, 1), DEBT_VALUATION_PAGE_LIMIT);
  const { rows } = await db.query<DebtValuationRow>(
    `SELECT * FROM debt_valuations WHERE instrument_id = $1
      ORDER BY valuation_date DESC, created_at DESC LIMIT $2`,
    [instrumentId, limit + 1],
  );
  return { valuations: rows.slice(0, limit).map(debtValuation), truncated: rows.length > limit };
}

export async function createValuation(
  db: Queryable,
  input: {
    instrumentId: string;
    valuationDate: string;
    inputs: Record<string, unknown>;
    result: Record<string, unknown>;
    fairValue: number | null;
    createdBy: string;
  },
): Promise<DebtValuationRow> {
  const { rows } = await db.query<DebtValuationRow>(
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
  return debtValuation(rows[0]!);
}
