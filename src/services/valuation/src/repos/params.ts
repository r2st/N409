import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

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
  dlom_method: 'chaffee' | 'finnerty' | 'qualitative' | null;
  dlom_qualitative: string | null;
  market_method: 'revenue' | 'ebitda' | null;
  market_horizon: 'ltm' | 'ntm' | null;
  market_custom_ranges: unknown;
  asset_method: 'cost_to_replicate' | 'nav' | null;
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
  'market_method',
  'market_horizon',
  'market_custom_ranges',
  'asset_method',
] as const;

export async function findParams(pool: pg.Pool, valuationId: string): Promise<ValuationParamsRow | null> {
  const { rows } = await pool.query<ValuationParamsRow>(
    'SELECT * FROM valuation_params WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

/** Field-level patch + params_updated audit event, atomically. */
export async function patchParams(
  pool: pg.Pool,
  current: ValuationParamsRow,
  fields: Record<string, unknown>,
  actor: EventActor,
): Promise<ValuationParamsRow> {
  const entries = Object.entries(fields).filter(
    ([k, v]) => (PARAM_COLUMNS as readonly string[]).includes(k) && current[k] !== v,
  );
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
    const changes = Object.fromEntries(entries.map(([k, v]) => [k, { from: current[k] ?? null, to: v }]));
    await recordEvent(client, {
      valuationId: current.valuation_id,
      type: PIPELINE_EVENT_TYPES.paramsUpdated,
      actor,
      payload: { changes },
    });
    return rows[0]!;
  });
}
