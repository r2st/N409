import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { diffRecords } from '../domain/auditTrail.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

/**
 * Every DLOM method the engine dispatches on (engine dlom.py DLOM_METHODS).
 * The first four are model-derived and need a volatility; 'restricted_stock'
 * blends published study discounts; 'qualitative' is the analyst's own figure.
 */
export const DLOM_METHODS = [
  'chaffee',
  'finnerty',
  'ghaidarov',
  'longstaff',
  'restricted_stock',
  'qualitative',
] as const;
export type DlomMethod = (typeof DLOM_METHODS)[number];

/** Mirrors the valuation_params table (1:1 with valuations, created at birth). */
export interface ValuationParamsRow {
  valuation_id: string;
  rolling_forward: boolean;
  inception_date: string | null;
  fiscal_year_end: string | null;
  exit_timeline: string | null;
  business_overview: string | null;
  revenue_status: 'pre_revenue' | 'post_revenue' | null;
  last_round_date: string | null;
  last_year_revenue_cents: string | number | null;
  ytd_revenue_cents: string | number | null;
  runway_months: number | null;
  weight_asset: string | null;
  weight_opm: string | null;
  weight_income: string | null;
  weight_market: string | null;
  dloc: string | null;
  dlom: string | null;
  dlom_method: DlomMethod | null;
  dlom_qualitative: string | null;
  /** Restricted-stock study configuration; only read when dlom_method is
   * 'restricted_stock'. NULL studies means the engine's default set. */
  dlom_studies: string[] | null;
  dlom_statistic: 'median' | 'mean' | null;
  dlom_study_table: unknown;
  market_method: 'revenue' | 'ebitda' | null;
  market_horizon: 'ltm' | 'ntm' | null;
  market_custom_ranges: unknown;
  asset_method: 'cost_to_replicate' | 'nav' | null;
  /** How equity value is allocated to common: OPM (default), PWERM, a hybrid
   * blend of the two, or the Current Value Method. */
  allocation_method: 'opm' | 'pwerm' | 'hybrid' | 'cvm' | 'monte_carlo';
  updated_at: Date;
  [key: string]: unknown;
}

export const PARAM_COLUMNS = [
  'rolling_forward',
  'inception_date',
  'fiscal_year_end',
  'exit_timeline',
  'business_overview',
  'revenue_status',
  'last_round_date',
  'last_year_revenue_cents',
  'ytd_revenue_cents',
  'runway_months',
  'weight_asset',
  'weight_opm',
  'weight_income',
  'weight_market',
  'dloc',
  'dlom',
  'dlom_method',
  'dlom_qualitative',
  'dlom_studies',
  'dlom_statistic',
  'dlom_study_table',
  'market_method',
  'market_horizon',
  'market_custom_ranges',
  'asset_method',
  'allocation_method',
] as const;

export async function findParams(pool: pg.Pool, valuationId: string): Promise<ValuationParamsRow | null> {
  const { rows } = await pool.query<ValuationParamsRow>(
    'SELECT * FROM valuation_params WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

/**
 * Batch form of {@link findParams}, keyed by valuation id — one round trip for
 * a whole list of valuations rather than one per valuation.
 */
export async function findParamsByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, ValuationParamsRow>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<ValuationParamsRow>(
    'SELECT * FROM valuation_params WHERE valuation_id = ANY($1)',
    [[...new Set(valuationIds)]],
  );
  return new Map(rows.map((row) => [row.valuation_id, row]));
}

/**
 * Extraction auto-apply (remaining-gaps §2 "Set Valuation Parameters"):
 * merge AI-extracted engine inputs into valuation_params.engine_inputs, with
 * the params_updated audit event. Existing keys are overwritten — the newest
 * applied extraction wins.
 */
export async function applyEngineInputs(
  pool: pg.Pool,
  valuationId: string,
  inputs: Record<string, unknown>,
  actor: EventActor,
): Promise<ValuationParamsRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ValuationParamsRow>(
      `UPDATE valuation_params
       SET engine_inputs = engine_inputs || $2::jsonb, updated_at = now()
       WHERE valuation_id = $1
       RETURNING *`,
      [valuationId, JSON.stringify(inputs)],
    );
    await recordEvent(client, {
      valuationId,
      type: PIPELINE_EVENT_TYPES.paramsUpdated,
      actor,
      payload: { engine_inputs_applied: inputs },
    });
    return rows[0]!;
  });
}

/** Field-level patch + params_updated audit event, atomically. */
export async function patchParams(
  pool: pg.Pool,
  current: ValuationParamsRow,
  fields: Record<string, unknown>,
  actor: EventActor,
): Promise<ValuationParamsRow> {
  const changes = diffRecords(current, fields, PARAM_COLUMNS);
  const entries = Object.entries(changes).map(([key, change]) => [key, change.to] as const);
  if (entries.length === 0) return current;

  return withTransaction(pool, async (client) => {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    for (const [key, value] of entries) {
      params.push(key === 'market_custom_ranges' && value !== null ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(current.valuation_id);
    const { rows } = await client.query<ValuationParamsRow>(
      `UPDATE valuation_params SET ${sets.join(', ')} WHERE valuation_id = $${params.length} RETURNING *`,
      params,
    );
    await recordEvent(client, {
      valuationId: current.valuation_id,
      type: PIPELINE_EVENT_TYPES.paramsUpdated,
      actor,
      payload: { changes },
    });
    return rows[0]!;
  });
}
