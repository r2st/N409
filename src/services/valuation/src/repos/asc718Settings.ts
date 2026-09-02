import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

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

/**
 * The columns a save can move, in the order the event lists them.
 *
 * `PUT .../asc718/settings` replaces the whole row — the body carries every
 * one of these on every save — so the diff below is over the complete set and
 * a missing field is a clear, not an omission.
 */
export const ASC718_SETTING_FIELDS = [
  'company_type',
  'ticker',
  'expected_term_method',
  'espp_discount_pct',
  'espp_lookback_months',
  'rsu_performance_conditions',
  'tsr_peer_basket',
] as const;
export type Asc718SettingField = (typeof ASC718_SETTING_FIELDS)[number];

/** The two `jsonb` columns, where `===` says nothing and key order says less. */
const JSONB_FIELDS: ReadonlySet<Asc718SettingField> = new Set([
  'rsu_performance_conditions',
  'tsr_peer_basket',
]);

/**
 * A value's canonical spelling, so two equal documents compare equal.
 *
 * `jsonb` does not preserve key order: the object the client sent and the
 * object Postgres hands back are the same document written two ways, and
 * `JSON.stringify` on the raw pair reports a change on every save. Objects sort
 * their keys, arrays keep theirs — a basket is a list and its order is part of
 * what it says.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

function same(field: Asc718SettingField, before: unknown, after: unknown): boolean {
  if (JSONB_FIELDS.has(field)) return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
  return before === after;
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

/**
 * The row as the diff has to read it: `numeric` off the driver is a string,
 * and a string equals no number the caller ever sends.
 *
 * `patchParams` normalises for the same reason one line before its own diff —
 * "the comparison below is `===`, and a `date` column off the driver is a Date
 * that equals no string". A row that does not exist yet is every column at
 * null, not an absent object: diffing against `{}` reads `undefined !== null`
 * and reports the blank fields of a first save as edits nobody made.
 */
function baselineOf(before: Asc718SettingsRow | undefined): Record<Asc718SettingField, unknown> {
  if (!before) {
    return Object.fromEntries(ASC718_SETTING_FIELDS.map((f) => [f, null])) as Record<
      Asc718SettingField,
      unknown
    >;
  }
  return {
    company_type: before.company_type,
    ticker: before.ticker,
    expected_term_method: before.expected_term_method,
    espp_discount_pct: before.espp_discount_pct === null ? null : Number(before.espp_discount_pct),
    espp_lookback_months: before.espp_lookback_months,
    rsu_performance_conditions: before.rsu_performance_conditions,
    tsr_peer_basket: before.tsr_peer_basket,
  };
}

/**
 * Upsert the engagement's ASC 718 settings — audited.
 *
 * THIS WRITE USED TO BE INVISIBLE (round 392, methodology M11). The row decides
 * how the stock-compensation charge is measured: the expected-term election
 * every grant that states none of its own inherits (`resolveExpectedTerm`), the
 * ESPP discount and lookback, the RSU performance conditions, the TSR peer
 * basket, and whether the issuer is measured as public — which switches the
 * underlying and the volatility onto a market feed. Each of those moves a
 * number that lands in somebody's financial statements, and none of them left
 * a trace: the upsert wrote the new value over the old one, keeping
 * `updated_by`/`updated_at` — who saved last, never what they changed or what
 * it had been.
 *
 * Every sibling input on the same engagement already recorded one.
 * `patchParams` writes `params_updated`, `upsertCompanyProfile` writes
 * `company_profile_updated`, the workbook, the methodology decisions and the
 * analyst overwrites all write theirs, and R279 put the fund and debt
 * measurement surfaces on the spine on exactly this argument — a stored input
 * the deliverable is computed from, changed by a route that said nothing. This
 * was the last per-engagement settings repo in the service whose only caller
 * recorded nothing at all.
 *
 * The event names the fields that *moved*, with their before and after values,
 * and not the fields the caller sent: the ASC 718 tab posts all seven columns
 * on every save, so a list of what was submitted would be the same list every
 * time and would answer nothing — `upsertCompanyProfile` documents where that
 * ends. A save that moves nothing therefore writes nothing: no row, no event,
 * no `updated_at`.
 */
export async function upsertAsc718Settings(
  pool: pg.Pool,
  valuationId: string,
  input: Asc718SettingsInput,
  actor: EventActor,
): Promise<Asc718SettingsRow> {
  // Exactly what the statement below will store, defaults included, so the
  // change list describes the row that ends up there rather than the body.
  const incoming: Record<Asc718SettingField, unknown> = {
    company_type: input.companyType,
    ticker: input.ticker ?? null,
    expected_term_method: input.expectedTermMethod ?? 'simplified',
    espp_discount_pct: input.esppDiscountPct ?? null,
    espp_lookback_months: input.esppLookbackMonths ?? null,
    rsu_performance_conditions: input.rsuPerformanceConditions ?? null,
    tsr_peer_basket: input.tsrPeerBasket ?? null,
  };

  return withTransaction(pool, async (client) => {
    // Read under the lock: the diff has to be against the row that is really
    // there. A second saver blocks here until the first commits, then reads
    // what the first left behind — the trap `patchParams` sets out at length.
    const { rows: locked } = await client.query<Asc718SettingsRow>(
      'SELECT * FROM asc718_settings WHERE valuation_id = $1 FOR UPDATE',
      [valuationId],
    );
    const before = locked[0];
    const baseline = baselineOf(before);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of ASC718_SETTING_FIELDS) {
      if (same(field, baseline[field], incoming[field])) continue;
      changes[field] = { from: baseline[field] ?? null, to: incoming[field] };
    }
    if (before && Object.keys(changes).length === 0) return before;

    const { rows } = await client.query<Asc718SettingsRow>(
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
        incoming.company_type,
        incoming.ticker,
        incoming.expected_term_method,
        incoming.espp_discount_pct,
        incoming.espp_lookback_months,
        // NULL stays NULL: `JSON.stringify(null)` is the four characters
        // "null", which stores a jsonb null literal rather than clearing the
        // column, and `IS NULL` would stop being true of a cleared basket.
        incoming.rsu_performance_conditions === null
          ? null
          : JSON.stringify(incoming.rsu_performance_conditions),
        incoming.tsr_peer_basket === null ? null : JSON.stringify(incoming.tsr_peer_basket),
        input.updatedBy,
      ],
    );

    await recordEvent(client, {
      valuationId,
      type: 'asc718_settings_updated',
      actor,
      payload: { changes },
    });
    return rows[0]!;
  });
}
