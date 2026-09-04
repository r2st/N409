import type pg from 'pg';
import { problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { diffRecords } from '../domain/auditTrail.js';
import { calendarDateRow } from '../domain/calendarDate.js';
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
  /** Optimistic-lock counter; every writer of this row bumps it (0158). */
  version: number;
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

/**
 * The four `date` columns this row carries, as the days they hold.
 *
 * Two things read them and both were wrong without this. The params routes and
 * the calculation and auditor-portal payloads send the row into JSON, where a
 * Date leaves as an instant on the previous day east of UTC — see
 * domain/calendarDate.ts. And `patchParams` diffs the stored row against the
 * request body with `===`, which no Date is ever equal to a `YYYY-MM-DD`
 * string: re-saving a form without touching its dates recorded four field
 * changes that did not happen and wrote them to the audit trail.
 */
const hydrated = (row: ValuationParamsRow): ValuationParamsRow =>
  calendarDateRow(row, 'inception_date', 'fiscal_year_end', 'exit_timeline', 'last_round_date');

export async function findParams(pool: pg.Pool, valuationId: string): Promise<ValuationParamsRow | null> {
  const { rows } = await pool.query<ValuationParamsRow>(
    'SELECT * FROM valuation_params WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ? hydrated(rows[0]) : null;
}

/**
 * The three columns the monitoring snapshot reads, and nothing else.
 *
 * THE PAGE READ A WHOLE PARAMS ROW TO TAKE TWO REVENUE FIGURES AND A DATE
 * (R393, methodology M8). `buildSnapshots` calls the batch reader once per
 * monitored valuation and `assembleSnapshot` then touches
 * `last_year_revenue_cents`, `ytd_revenue_cents` and `last_round_date`.
 * `valuation_params` carries six `jsonb` columns beside them — `engine_inputs`
 * is the whole engine payload including every share class, and the DLOM, DLOC,
 * required-return and WACC study tables are four more — so a page of monitors
 * pulled all of that across the wire and through the driver's `JSON.parse` for
 * three scalars. Measured at 200 monitors with a fifty-class engine input
 * (11.5 kB): **18.8 ms / 3.71 MB parsed against 0.3 ms / 0.03 MB**, and
 * `MONITOR_PAGE_LIMIT` is 500.
 *
 * This is R298's `latestSucceededCalculationHeadsByValuationIds` beside it in
 * the same `Promise.all`, and the third of that fan-out's four reads to be
 * narrowed — R393 took the cap table in the same round. The one that stays wide
 * is `findResolutionsByValuationIds`, whose row has no document column on it.
 *
 * `findParamsByValuationIds` stays as it is for the other caller: the
 * remediation console re-runs the engine for each row it fetches, so it wants
 * every column, and `MAX_RERUN` is 25.
 *
 * `calendarDateRow` for the same reason `hydrated` applies it: `last_round_date`
 * is a `date` column, the driver hands one back as midnight *local*, and the
 * trigger compares this string against the baseline's. Two malformed strings
 * compare wrong (domain/calendarDate).
 */
export type ValuationParamsHead = Pick<
  ValuationParamsRow,
  'valuation_id' | 'last_year_revenue_cents' | 'ytd_revenue_cents' | 'last_round_date'
>;

export async function findParamsHeadsByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, ValuationParamsHead>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<ValuationParamsHead>(
    `SELECT valuation_id, last_year_revenue_cents, ytd_revenue_cents, last_round_date
       FROM valuation_params WHERE valuation_id = ANY($1)`,
    [[...new Set(valuationIds)]],
  );
  return new Map(rows.map((row) => [row.valuation_id, calendarDateRow(row, 'last_round_date')]));
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
  return new Map(rows.map((row) => [row.valuation_id, hydrated(row)]));
}

/** Refused write: the row moved between the caller's read and this UPDATE. */
function staleParamsWrite(current: number | undefined, expected: number): never {
  throw problems.conflict(
    `These valuation parameters were changed by someone else (expected version ${expected}, ` +
      `now ${current ?? 'unknown'}). Reload and reapply your changes.`,
  );
}

/**
 * Extraction auto-apply (remaining-gaps §2 "Set Valuation Parameters"):
 * merge AI-extracted engine inputs into valuation_params.engine_inputs, with
 * the params_updated audit event. Existing keys are overwritten — the newest
 * applied extraction wins.
 *
 * `expectedVersion` is what makes that last sentence safe for a *human*
 * editor. The merge is `||`, which replaces a top-level block outright, and the
 * financial-model panel posts every block it holds — so without the check, a
 * save built on a document another analyst has since edited quietly reverts
 * them (migration 0158). Supplied from `If-Match` by the engine-inputs route
 * and omitted by the extraction path, which is applying values it just derived
 * rather than a form somebody has been looking at.
 */
export async function applyEngineInputs(
  pool: pg.Pool,
  valuationId: string,
  inputs: Record<string, unknown>,
  actor: EventActor,
  options: { expectedVersion?: number } = {},
): Promise<ValuationParamsRow> {
  return withTransaction(pool, (client) =>
    applyEngineInputsWithin(client, valuationId, inputs, actor, options),
  );
}

/**
 * The body of {@link applyEngineInputs}, on a transaction the caller already
 * holds.
 *
 * Every "adopt this derived figure" route is two or three writes — the engine
 * input this makes, the registry row beside it, and the `applied_at` that names
 * which run the engagement is carrying — and the estate has already written
 * down what happens when they disagree (`markVolatilityEstimateApplied`,
 * `markRollforwardRunApplied`). They disagree if any of them can land without
 * the others, so the routes bind them into one transaction and this is the door
 * that lets them.
 */
export async function applyEngineInputsWithin(
  client: pg.PoolClient,
  valuationId: string,
  inputs: Record<string, unknown>,
  actor: EventActor,
  options: { expectedVersion?: number } = {},
): Promise<ValuationParamsRow> {
  const { expectedVersion } = options;
  const { rows } = await client.query<ValuationParamsRow>(
    `UPDATE valuation_params
     SET engine_inputs = engine_inputs || $2::jsonb, updated_at = now(), version = version + 1
     WHERE valuation_id = $1${expectedVersion === undefined ? '' : ' AND version = $3'}
     RETURNING *`,
    expectedVersion === undefined
      ? [valuationId, JSON.stringify(inputs)]
      : [valuationId, JSON.stringify(inputs), expectedVersion],
  );
  // Without a version condition the WHERE is the primary key of a row the
  // route just loaded, so zero rows can only mean the condition failed.
  if (rows.length === 0) {
    const { rows: live } = await client.query<{ version: number }>(
      'SELECT version FROM valuation_params WHERE valuation_id = $1',
      [valuationId],
    );
    if (expectedVersion !== undefined) staleParamsWrite(live[0]?.version, expectedVersion);
    throw problems.notFound(
      'This valuation’s parameters no longer exist — the valuation was deleted while this save ' +
        'was in flight. Nothing was saved.',
    );
  }
  await recordEvent(client, {
    valuationId,
    type: PIPELINE_EVENT_TYPES.paramsUpdated,
    actor,
    payload: { engine_inputs_applied: inputs },
  });
  return hydrated(rows[0]!);
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
  /**
   * The `version` the caller believes it is patching, from `If-Match`.
   *
   * The lock below already makes each individual field land on the row that is
   * really there; what it cannot see is that the *caller's* idea of the row is
   * out of date. The Params panel posts some forty fields it read when the tab
   * was opened, so a save built on a stale read does not lose the race — it
   * wins it, and reverts everything the other editor changed. That is the same
   * failure `applyEngineInputs` documents, arriving through the larger of the
   * two forms that write this row (migration 0158).
   *
   * Omitted by the callers that are applying values they just derived rather
   * than a form somebody has been looking at: the accounting sync, the
   * roll-forward, the intake mapper.
   */
  expectedVersion?: number;
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
  const { expectedVersion } = options;

  // An empty patch asks for nothing, whatever the row says. Returning here
  // keeps a no-op PATCH from taking a row lock other editors are queued on —
  // but not before answering the question the caller actually asked. A caller
  // that sent `If-Match` is asserting it holds the current row, and telling it
  // "fine" on a row that has moved is the lost-update report the guard exists
  // to prevent, one request early.
  if (Object.keys(fields).length === 0) {
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      staleParamsWrite(current.version, expectedVersion);
    }
    return current;
  }

  return withTransaction(pool, async (client) => {
    const { rows: locked } = await client.query<ValuationParamsRow>(
      'SELECT * FROM valuation_params WHERE valuation_id = $1 FOR UPDATE',
      [current.valuation_id],
    );
    // The row is created with the valuation and deleted only with it, so this
    // is reachable only by a purge landing mid-request.
    const raw = locked[0];
    if (!raw)
      throw problems.notFound(
        'This valuation’s parameters no longer exist — the valuation was deleted while this save ' +
          'was in flight. Nothing was saved.',
      );
    // Normalised *before* the diff, not after: the comparison below is `===`,
    // and a `date` column off the driver is a Date that equals no string.
    const fresh = hydrated(raw);

    // Before the diff, not after. The diff is computed against `fresh`, so a
    // caller whose snapshot is stale produces a perfectly well-formed patch
    // that reverts somebody — and an empty diff is not proof of agreement
    // either, only that this particular form happened to match. The version is
    // the one reading that can tell the two apart, and under the row lock it
    // is exact.
    if (expectedVersion !== undefined && fresh.version !== expectedVersion) {
      staleParamsWrite(fresh.version, expectedVersion);
    }

    const check = options.revalidate?.(fresh);
    if (check && !check.ok) throw problems.unprocessable(check.detail);

    const changes = diffRecords(fresh, fields, PARAM_COLUMNS);
    const entries = Object.entries(changes).map(([key, change]) => [key, change.to] as const);
    if (entries.length === 0) return fresh;

    // Every writer of this row moves the version, not just the guarded one: an
    // engine-inputs editor holding version 4 has to be able to tell that a
    // `PATCH /params` landed, and a write that left the version alone would be
    // invisible to it (migration 0158).
    const sets: string[] = ['updated_at = now()', 'version = version + 1'];
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
    return hydrated(rows[0]!);
  });
}
