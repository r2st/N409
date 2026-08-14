import type pg from 'pg';
import { problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { diffRecords } from '../domain/auditTrail.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

/**
 * Every DLOM method the engine dispatches on (engine dlom.py DLOM_METHODS).
 * The first four are model-derived and need a volatility; 'restricted_stock'
 * and 'pre_ipo' blend published study discounts from two different empirical
 * families (see migration 0131 for why they are not one table); 'qualitative'
 * is the analyst's own figure.
 */
export const DLOM_METHODS = [
  'chaffee',
  'finnerty',
  'ghaidarov',
  'longstaff',
  'restricted_stock',
  'pre_ipo',
  'qualitative',
] as const;
export type DlomMethod = (typeof DLOM_METHODS)[number];

/**
 * Every DLOC method the engine dispatches on (engine dloc.py DLOC_METHODS).
 *
 * 'control_premium' inverts a stated premium (DLOC = 1 − 1/(1+CP) — the two are
 * the same fact from opposite sides, and the conversion is not symmetric);
 * 'studies' blends published control-premium observations and inverts once, on
 * the premium scale; 'qualitative' is the analyst's own figure. NULL — no
 * method — applies `dloc` as a stated number, which is what every row written
 * before migration 0132 does.
 */
export const DLOC_METHODS = ['control_premium', 'studies', 'qualitative'] as const;
export type DlocMethod = (typeof DLOC_METHODS)[number];

/** Mirrors the valuation_params table (1:1 with valuations, created at birth). */
export interface ValuationParamsRow {
  valuation_id: string;
  rolling_forward: boolean;
  inception_date: string | null;
  fiscal_year_end: string | null;
  exit_timeline: string | null;
  business_overview: string | null;
  revenue_status: 'pre_revenue' | 'post_revenue' | null;
  /** AICPA stage 1-6; null until the analyst concludes one. */
  development_stage: number | null;
  last_round_date: string | null;
  last_year_revenue_cents: string | number | null;
  ytd_revenue_cents: string | number | null;
  runway_months: number | null;
  weight_asset: string | null;
  weight_opm: string | null;
  weight_income: string | null;
  weight_market: string | null;
  dloc: string | null;
  /**
   * How the DLOC was derived (migration 0132). NULL applies `dloc` as a stated
   * figure, which is what every row written before that migration does, and
   * what a recalculation of an engagement concluded last year must keep doing.
   */
  dloc_method: DlocMethod | null;
  /** Only read when dloc_method is 'control_premium'. Inverted, not subtracted:
   * DLOC = 1 − 1/(1+CP), so a 25% premium is a 20% discount. */
  control_premium: string | null;
  /** Share of an observed acquisition premium attributed to synergies rather
   * than to control, removed before the inversion. */
  dloc_synergy_share: string | null;
  /** Control-premium study configuration; only read when dloc_method is
   * 'studies'. NULL studies means the engine's default set. */
  dloc_studies: string[] | null;
  dloc_statistic: 'median' | 'mean' | null;
  dloc_study_table: unknown;
  dlom: string | null;
  dlom_method: DlomMethod | null;
  /**
   * A discount weighted across several methods instead of concluded on one
   * (migration 0129). Mutually exclusive with `dlom_method` — enforced by the
   * route, the engine's pre-flight and a table constraint.
   */
  dlom_methods: Array<{ method: DlomMethod; weight: number }> | null;
  dlom_qualitative: string | null;
  /** Restricted-stock study configuration; only read when dlom_method is
   * 'restricted_stock'. NULL studies means the engine's default set. */
  dlom_studies: string[] | null;
  dlom_statistic: 'median' | 'mean' | null;
  dlom_study_table: unknown;
  /** Pre-IPO study configuration (migration 0131); only read when dlom_method
   * is 'pre_ipo'. Its own columns rather than the two above because the two
   * study tables share no names — a blend weighting both families has to be
   * able to select from each. `dlom_statistic` is shared by both. */
  dlom_pre_ipo_studies: string[] | null;
  dlom_pre_ipo_table: unknown;
  /** A firm's own required-return ladder by stage (migration 0130). NULL means
   * the built-in literature ranges. */
  required_return_table: unknown;
  /** The CAPM/WACC build-up inputs (migration 0135), keyed as the engine takes
   * them. NULL until an analyst has entered one. */
  wacc_inputs: unknown;
  /** Whether the build-up drives the DCF discount rate. */
  auto_wacc: boolean;
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
  'development_stage',
  'last_round_date',
  'last_year_revenue_cents',
  'ytd_revenue_cents',
  'runway_months',
  'weight_asset',
  'weight_opm',
  'weight_income',
  'weight_market',
  'dloc',
  'dloc_method',
  'control_premium',
  'dloc_synergy_share',
  'dloc_studies',
  'dloc_statistic',
  'dloc_study_table',
  'dlom',
  'dlom_method',
  'dlom_methods',
  'dlom_qualitative',
  'dlom_studies',
  'dlom_statistic',
  'dlom_study_table',
  'dlom_pre_ipo_studies',
  'dlom_pre_ipo_table',
  'required_return_table',
  'wacc_inputs',
  'auto_wacc',
  'market_method',
  'market_horizon',
  'market_custom_ranges',
  'asset_method',
  'allocation_method',
] as const;

/**
 * The `jsonb` columns among them, which have to be serialized on the way in.
 *
 * node-pg maps a JS value to a Postgres parameter by its *JavaScript* type, not
 * by the column it is bound to: an array becomes an array literal, a plain
 * object becomes `[object Object]`. That is right for `dloc_studies` (`text[]`)
 * and wrong for every jsonb column here, and only `market_custom_ranges` was
 * ever stringified.
 *
 * The five that were not are not obscure. `dlom_methods` is the weighted-DLOM
 * feature; `dlom_study_table`, `dlom_pre_ipo_table` and `dloc_study_table` are
 * how a firm supplies its own subscription study data instead of the engine's
 * built-in indicative tables; `required_return_table` is the firm's own stage
 * ladder for Appendix III. Each has a validated Zod schema on the route, a
 * column with a CHECK constraint, engine code that reads it and an exhibit that
 * prints it — and each one 500'd on `invalid input syntax for type json` at the
 * only step that could ever set it. The features were complete and unreachable.
 *
 * Typed against the column list rather than as bare strings, so a name that is
 * misspelled or no longer a column is a compile error here. A jsonb column
 * added later still has to be added to this set by hand — there is nothing in
 * the schema for the type system to read.
 */
export const JSONB_PARAM_COLUMNS: ReadonlySet<(typeof PARAM_COLUMNS)[number]> = new Set([
  'dloc_study_table',
  'dlom_methods',
  'dlom_study_table',
  'dlom_pre_ipo_table',
  'required_return_table',
  'wacc_inputs',
  'market_custom_ranges',
]);

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

export interface PatchParamsOptions {
  /**
   * The row's invariants, re-checked against the row under the write lock.
   *
   * Supplied by the route (`checkParamInvariants`), which has already run the
   * same rules on the row the request read. This second run is the one that
   * holds under concurrency — see the comment on `patchParams` below.
   */
  revalidate?: (fresh: ValuationParamsRow) => { ok: true } | { ok: false; detail: string };
}

/**
 * Field-level patch + params_updated audit event, atomically.
 *
 * `current` is the row the caller read, which by the time the write runs may
 * no longer be the row on the table. Everything that depends on the row's
 * contents therefore happens *here*, against a fresh `SELECT ... FOR UPDATE`,
 * and `current` is used for nothing but its id:
 *
 *   * the diff, so a field the caller is setting is compared against what is
 *     stored rather than against what was stored when the form was opened.
 *     Patching `runway_months` to 12 when the caller's snapshot said 12 and
 *     another editor has since made it 18 is a real change, and diffing
 *     against the snapshot dropped it as a no-op — a lost update that left the
 *     analyst looking at a saved form holding a value nobody stored;
 *   * `revalidate`, so the invariants are checked on the merged row that will
 *     actually be written. Two individually-legal patches can compose into a
 *     row that violates `weights_sum_to_one` or
 *     `valuation_params_one_dlom_form`, and a check constraint firing under a
 *     repo nothing catches is a 500 rather than the 422 naming the rule;
 *   * the audit event's `from` values, which now report a transition that
 *     happened instead of one the caller assumed.
 *
 * The row lock is what makes the three agree: a second writer blocks on it
 * until the first commits, then reads what the first left behind.
 */
export async function patchParams(
  pool: pg.Pool,
  current: ValuationParamsRow,
  fields: Record<string, unknown>,
  actor: EventActor,
  options: PatchParamsOptions = {},
): Promise<ValuationParamsRow> {
  // An empty patch asks for nothing, whatever the row says. Returning here
  // keeps a no-op PATCH from taking a row lock other editors are queued on.
  if (Object.keys(fields).length === 0) return current;

  return withTransaction(pool, async (client) => {
    const { rows: locked } = await client.query<ValuationParamsRow>(
      'SELECT * FROM valuation_params WHERE valuation_id = $1 FOR UPDATE',
      [current.valuation_id],
    );
    // The row is created with the valuation and deleted only with it, so this
    // is reachable only by a purge landing mid-request.
    const fresh = locked[0];
    if (!fresh) throw problems.notFound();

    const check = options.revalidate?.(fresh);
    if (check && !check.ok) throw problems.unprocessable(check.detail);

    const changes = diffRecords(fresh, fields, PARAM_COLUMNS);
    const entries = Object.entries(changes).map(([key, change]) => [key, change.to] as const);
    if (entries.length === 0) return fresh;

    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    for (const [key, value] of entries) {
      // NULL stays NULL: `JSON.stringify(null)` is the four characters "null",
      // which stores a jsonb null literal rather than clearing the column, and
      // `IS NULL` would stop being true of a cleared table.
      const jsonb = JSONB_PARAM_COLUMNS.has(key as (typeof PARAM_COLUMNS)[number]);
      params.push(jsonb && value !== null ? JSON.stringify(value) : value);
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
