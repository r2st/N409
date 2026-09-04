import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { requirePrincipal } from '../plugins/auth.js';
import { malformedIfMatch, parseIfMatch, versionEtag } from '../domain/concurrency.js';
import type { EventActor } from '../events/record.js';
import { boundedNonNegative, boundedPositive, boundedSigned } from '../domain/finite.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Analyst-entered financial model (`valuation_params.engine_inputs`).
 *
 * The compute engine (engine-wrapper: app/engine/compute.py) reads its `inputs`
 * document to run the four approaches. Until now that document could only be
 * populated by AI document extraction (routes/ai.ts auto-apply); this endpoint
 * lets an analyst hand-enter the whole model. The Zod schema mirrors exactly
 * what compute.py + waterfall.py consume, so anything that validates here can
 * be fed straight to the engine.
 *
 * Persistence is a jsonb merge (applyEngineInputs) keyed on top-level fields:
 * each section the form submits replaces that key wholesale, and keys it does
 * not touch (e.g. an AI-extracted value the form has no widget for) survive.
 * Send an explicit null to clear a field/section.
 */

// `.finite()`, not merely `.nonnegative()` / `.positive()`: `1e999` in a JSON
// body parses to Infinity, satisfies both, and stringifies back to `null` on
// the way into jsonb and on to the engine. See domain/finite.ts.
//
// Bounded as well as finite. Finite was the floor and not the rule: a quantity
// above 2^53 cannot be added exactly, so a cap table carrying one class of
// 1e16 shares and another of 1 sums to 1e16 and loses the second class
// entirely. Every share count, balance and price below therefore stops at
// MAX_QUANTITY — reachable by a unit slip or a spreadsheet paste, not only by
// a hostile caller.
const nonNeg = boundedNonNegative();
const pos = boundedPositive();

/**
 * The engine's explicit-forecast ceiling — `projection.MAX_FORECAST_YEARS`.
 *
 * Restated here rather than imported because the constant lives in the Python
 * tier; `validate.py` refuses a longer `free_cash_flows` with a field-addressed
 * 422, so this is the number a payload has to clear to be computable at all.
 */
const MAX_FORECAST_YEARS = 100;
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');
const ClassName = z.string().trim().min(1).max(80);

/** One row of the cap table — mirrors waterfall.py `_normalize`. */
const ShareClass = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('common'), name: ClassName, shares: pos }),
  z.object({
    kind: z.literal('preferred'),
    name: ClassName,
    shares: pos,
    preference: nonNeg,
    seniority: z.number().int().min(1).max(50).default(1),
    participating: z.boolean().default(false),
    conversion_ratio: pos.max(1000).default(1),
    /**
     * Total proceeds cap on a participating class — the term sheet's "2x"
     * resolved against the round's actual preference, preference included.
     * Null/absent is uncapped, which is what every cap table stored before
     * this field existed meant. The engine refuses a cap on a
     * non-participating class and a cap at or below the preference; both are
     * left to it rather than restated here, so the two cannot drift.
     */
    participation_cap: pos.nullable().optional(),
  }),
  z.object({ kind: z.literal('option'), name: ClassName, shares: pos, strike: pos }),
]);

export const EngineInputsBody = z
  .object({
    // Cap table / OPM allocation (compute.py "OPM allocation to common").
    shares_outstanding_common: pos.nullable().optional(),
    shares_outstanding_preferred: nonNeg.nullable().optional(),
    options_outstanding: nonNeg.nullable().optional(),
    liquidation_preference: nonNeg.nullable().optional(),
    share_classes: z.array(ShareClass).max(50).nullable().optional(),

    // Shared assumptions.
    volatility: z.number().positive().max(5).nullable().optional(),
    risk_free_rate: z.number().min(0).max(1).nullable().optional(),
    time_to_exit_years: z.number().min(0).max(50).nullable().optional(),
    valuation_date: DateStr.nullable().optional(),
    cash: nonNeg.nullable().optional(),
    debt: nonNeg.nullable().optional(),

    // OPM backsolve — the last priced round.
    last_round_post_money: nonNeg.nullable().optional(),
    last_round_price_per_share: nonNeg.nullable().optional(),
    last_round_class: ClassName.nullable().optional(),

    /**
     * Market-movement adjustment to the round indication
     * (engine/market_movement.py, report §"Adjustment Factor: Market Movement").
     *
     * The backsolve reads a value out of a *dated* round, so a valuation months
     * later concludes on a stale price unless it is moved by what the market
     * did in between. Either the two benchmark levels — the reviewable form —
     * or a return the analyst computed elsewhere.
     *
     * The band on the levels is only a shape check; the engine holds the real
     * one, refusing a factor outside [0.2, 5] because a start of 56 against an
     * end of 5,600 is a decimal point rather than a market move. Left there
     * rather than restated here so the two cannot drift.
     */
    market_movement: z
      .object({
        index_name: z.string().trim().min(1).max(120).nullable().optional(),
        index_start: pos.nullable().optional(),
        index_end: pos.nullable().optional(),
        return: z.number().min(-0.99).max(10).nullable().optional(),
        beta: z.number().min(0).max(5).nullable().optional(),
        period_start: DateStr.nullable().optional(),
        period_end: DateStr.nullable().optional(),
      })
      .strict()
      /**
       * The measurement window, the right way round.
       *
       * These two are the only pair on this body that describe an interval, and
       * each was bounded on its own — so `{ period_start: '2026-06-30',
       * period_end: '2025-01-01' }` validated, persisted, and reached the
       * engine, which prints them back verbatim (`market_movement.py._period`
       * says in as many words that they "are not arithmetic").
       *
       * Exhibit C then states them as fact. `reportExhibits.ts` renders the
       * benchmark row's third cell as `${from} to ${to}`, beside a return
       * computed as `index_end / index_start - 1`, on a signed §409A opinion.
       * An inverted window therefore prints a period running backwards next to
       * a return whose sign is the reverse of what that period implies — and it
       * is the one adjustment in the report a reviewer is meant to check by
       * looking up the benchmark over the stated dates.
       *
       * `routes/params.ts` carries exactly this refinement over the three study
       * tables, for exactly this reason; the market-movement block was the pair
       * that did not. Ordering only, and only when both ends are given: a block
       * stating one end and not the other is undated rather than misdated, and
       * the exhibit already falls back to "Round date to valuation date" unless
       * it has both.
       */
      .refine(
        (m) =>
          !m ||
          m.period_start == null ||
          m.period_end == null ||
          m.period_start <= m.period_end,
        { message: 'period_start must not be after period_end', path: ['period_start'] },
      )
      .nullable()
      .optional(),

    // Asset approach.
    asset: z
      .object({
        /*
         * Signed, and the sign is the estate's opinion rather than this door's
         * (R410, methodology M19).
         *
         * These two were `nonNeg`, and that was the only statement anywhere
         * that a balance-sheet subtotal cannot be negative. Three other places
         * say it can, and one of them says so on purpose:
         *
         *   * `validate._check_asset` requires both figures and then only
         *     *warns* — `negative_nav`, "liabilities exceed assets" — so a
         *     negative subtotal is a payload the pre-flight clears;
         *   * `approaches.asset_value` refuses `cost_to_replicate < 0` and
         *     nothing else, returning `total_assets - total_liabilities`
         *     through `_finite_result`;
         *   * `clients/accounting.storableLedgerCents` bounds the magnitude of
         *     both and says of the sign: "Sign is deliberately not part of the
         *     rule — the engine already reasons about liabilities exceeding
         *     assets, and refusing a negative here would be this module
         *     inventing a bound the approach does not have."
         *
         * And that third one is the door that made it matter. The accounting
         * import writes `asset.total_assets` and `asset.total_liabilities`
         * straight through `applyEngineInputs` from a provider's balance sheet,
         * where a liabilities section netting to a debit balance — a
         * prepayment, an overpaid tax account, a provider's own credit-balance
         * sign convention — comes back negative. It stored under a 200, and
         * `FinancialModelPanel` loads the asset section into its form and posts
         * the whole model back, so every later save answered 422 on a subtotal
         * the analyst never typed and could not correct from that form.
         *
         * A sign slip is still caught, by the engine's `negative_nav` warning,
         * which is where it belongs: liabilities above assets is a finding
         * about the balance sheet rather than a malformed request.
         *
         * `cost_to_replicate` keeps `nonNeg`, because it is the one of the
         * three the engine does refuse below zero.
         */
        total_assets: boundedSigned().nullable().optional(),
        total_liabilities: boundedSigned().nullable().optional(),
        cost_to_replicate: nonNeg.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // Income / DCF approach. `revenues` is stored alongside FCF for the record
    // (the report cites it); only free_cash_flows drives income_dcf().
    income: z
      .object({
        /*
         * The horizon, at the length the *other* two doors onto this cell use
         * (R406, methodology M6).
         *
         * This was 30, and the engine's bound is 100
         * (`projection.MAX_FORECAST_YEARS`, which exists because a float `**`
         * over a longer horizon overflows rather than saturating). Between the
         * two sits the projection route, whose `years` runs to 100 and whose
         * adoption writes `income.free_cash_flows = run.free_cash_flows`
         * straight through `applyEngineInputs` — so a forty-year run was
         * adopted into a document this schema then refused, and the next save
         * of the model came back 400 on an array the analyst had not touched,
         * with no way to correct it from that form.
         *
         * That is the shape the adoption handler already names for
         * `terminal_metric`: "a value into `engine_inputs` by the one path that
         * did not check it — and the 422 then arrived on whoever next pressed
         * Calculate, naming a field they had not touched." The length is the
         * same failure and was not covered. Raised rather than truncating the
         * adoption, because a silently shortened forecast is a different
         * valuation.
         */
        free_cash_flows: z.array(boundedSigned()).max(MAX_FORECAST_YEARS).nullable().optional(),
        revenues: z.array(nonNeg).max(MAX_FORECAST_YEARS).nullable().optional(),
        discount_rate: z.number().positive().max(1).nullable().optional(),
        /*
         * Negative is a perpetuity that shrinks, not a typo (R406, M6).
         *
         * `min(0)` here was the only place in the estate that said a terminal
         * growth rate cannot be negative, and three others say it can:
         *
         *   * the engine floors it at -1 and nowhere else — `validate.py`'s
         *     `out_of_range` check and `projection.terminal_value_gordon` both
         *     draw the line there, and the engine's own remedy text reads
         *     "enter the long-run growth rate as a fraction (-2% is -0.02), or
         *     use -1 for a cash flow that stops at the end of the forecast".
         *     That instruction was unfollowable: the value never got past this
         *     schema to reach the engine that offers it.
         *   * `domain/overwrites.ts` publishes `terminal_growth_rate` over
         *     -0.05 … 0.15, so the overwrites tab admits the sign this door
         *     refuses;
         *   * `domain/healthChecks.ts` raises `terminal_growth_range` as a
         *     *warning* when the stored growth is below zero — a branch nothing
         *     could reach, because nothing could store one.
         *
         * A declining perpetuity is ordinary work: a wasting asset, a single
         * expiring contract, a business in run-off. Floored at the engine's own
         * -1 rather than at the projection route's -0.5, because -1 is the
         * value the engine names for the case it describes and the pre-flight
         * exists so that a payload this schema clears is one `/compute` runs.
         * `r > g` is still enforced below, and is what keeps the Gordon
         * denominator positive.
         */
        terminal_growth: z.number().min(-1).max(1).nullable().optional(),

        /**
         * The two methodology choices the DCF offers (approaches.income_dcf).
         *
         * The engine has read all five of these since it learned to, validates
         * them in `validate.py`, and reports the choice back on the result so a
         * report can state it. Nothing could ever set them: this object is
         * `.strict()`, so an analyst asking for a mid-year convention or an
         * exit-multiple terminal value got a 400 and the engagement kept the
         * end-of-year Gordon default it never chose.
         *
         * The bound on `exit_multiple` is a sanity rail, not a view: 100x
         * EBITDA is not a 409A input, and a fat-fingered 850 that reaches the
         * engine computes cleanly and wrongly.
         */
        mid_year_convention: z.boolean().nullable().optional(),
        terminal_method: z.enum(['gordon', 'exit_multiple']).nullable().optional(),
        exit_multiple: z.number().positive().max(100).nullable().optional(),
        terminal_metric: boundedSigned().nullable().optional(),
        terminal_metric_basis: z.enum(['ebitda', 'revenue', 'fcff']).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // Market / comparable-company multiples.
    market: z
      .object({
        metric: pos.nullable().optional(),
        multiples: z.array(pos).max(50).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // Hybrid method weights (compute.py `allocation_method == 'hybrid'`,
    // hybrid.py). The OPM weight covers the far-term continuation outcome, the
    // PWERM weight the modelled near-term liquidity scenarios; they must sum to
    // 1 (validated in the engine). Absent → the engine defaults to 50/50.
    hybrid: z
      .object({
        opm_weight: z.number().min(0).max(1).nullable().optional(),
        pwerm_weight: z.number().min(0).max(1).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),

    // PWERM discrete exit scenarios (compute.py `allocation_method == 'pwerm'`,
    // pwerm.py). Each scenario carries a probability, an exit value (equity or
    // enterprise), a time to exit and an optional per-scenario discount rate.
    pwerm: z
      .object({
        discount_rate: z.number().min(-0.99).max(1).nullable().optional(),
        scenarios: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(120).nullable().optional(),
                type: z
                  .enum([
                    'ipo',
                    'acquisition',
                    'merger',
                    'continuation',
                    'stay_private',
                    'liquidation',
                    'dissolution',
                  ])
                  .nullable()
                  .optional(),
                probability: z.number().min(0).max(1),
                equity_value: nonNeg.nullable().optional(),
                enterprise_value: boundedSigned().nullable().optional(),
                time_to_exit_years: z.number().min(0).max(50).default(0),
                discount_rate: z.number().min(-0.99).max(1).nullable().optional(),
              })
              .strict()
              .refine((s) => s.equity_value != null || s.enterprise_value != null, {
                message: 'Each scenario needs an equity_value or enterprise_value.',
              }),
          )
          .min(1)
          .max(50)
          .nullable()
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const classes = val.share_classes;
    if (classes && classes.length > 0) {
      if (!classes.some((c) => c.kind === 'common')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['share_classes'],
          message: 'The cap table must include at least one common class.',
        });
      }
      const names = classes.map((c) => c.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['share_classes'],
          message: `Duplicate share class name: ${dupes[0]}`,
        });
      }
      if (val.last_round_class && !names.includes(val.last_round_class)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['last_round_class'],
          message: 'last_round_class must match one of the share class names.',
        });
      }
    }
    const income = val.income;
    const dr = income?.discount_rate;
    const tg = income?.terminal_growth;
    // Only a Gordon perpetuity diverges as the rate approaches the growth rate.
    // An exit multiple capitalises nothing, so demanding the inequality of it
    // refuses an ordinary payload — one that values the horizon at 8x EBITDA
    // and says nothing about perpetual growth. The engine draws the line in the
    // same place (approaches.income_dcf); this is that rule, not a second one.
    const method = income?.terminal_method ?? 'gordon';
    if (method === 'gordon' && dr != null && tg != null && dr <= tg) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['income', 'discount_rate'],
        message: 'Discount rate must exceed terminal growth.',
      });
    }
    // Caught here as well as in the engine because the failure is otherwise
    // deferred: the document stores, the engagement looks configured, and the
    // 422 arrives on whoever next presses Calculate.
    if (method === 'exit_multiple' && income?.exit_multiple == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['income', 'exit_multiple'],
        message: 'An exit-multiple terminal value needs an exit_multiple.',
      });
    }
    if (income?.terminal_metric != null && income.terminal_metric <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['income', 'terminal_metric'],
        message:
          'terminal_metric must be positive to strike a multiple against it — use the Gordon terminal value instead.',
      });
    }
  });

/**
 * The fields a *non-route* writer is about to put into `engine_inputs`, checked
 * against the schema that owns the document, or `null` when they all fit.
 *
 * `applyEngineInputs` is the repo call, and three routes reach it without ever
 * passing a body through `EngineInputsBody`: the projection adoption, the
 * roll-forward adoption, and the AI apply (which has its own narrower gate in
 * `sanitizeExtractedInputs`). The adoption handler in `routes/projections.ts`
 * has named the consequence since R404 — "a value into `engine_inputs` by the
 * one path that did not check it — and the 422 then arrived on whoever next
 * pressed Calculate, naming a field they had not touched" — and it was closed
 * one field at a time, for `terminal_metric`.
 *
 * It is the same failure for every field, and the reason it keeps arriving is
 * that the two bounds are set by different considerations and drift apart
 * without either author being wrong. `rollforward_runs.rolled_equity_value` is
 * bounded by `numeric(20, 2)` — below 1e18, and `requireStorableFigure` holds it
 * there. `last_round_post_money` here is `boundedNonNegative()` — below
 * `MAX_QUANTITY`, 9.007e15, because past 2^53 a double stops adding exactly. A
 * rolled value between the two stores fine, adopts fine, and is refused by the
 * financial-model form ever after.
 *
 * Pass only the fields the writer is actually setting: the section it merges
 * into is the analyst's, and a value they left there is not this check's to
 * refuse a run over. The returned string is `field.path: message`, for a
 * refusal that says which figure to look at.
 */
export function unstorableEngineInputs(written: Record<string, unknown>): string | null {
  const parsed = EngineInputsBody.safeParse(written);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : 'engine_inputs';
  return `${field}: ${issue?.message ?? 'invalid value'}`;
}

export type EngineInputsPatch = z.infer<typeof EngineInputsBody>;

/**
 * The same bounds, for the same fields, applied to what the AI extraction
 * pipeline proposes.
 *
 * `engine_inputs` has two writers. This route validates every figure against
 * the schema above before it lands. The AI path (routes/ai.ts auto-apply, and
 * the manual apply of a stored extraction) merged the pipeline's
 * `engine_inputs` object into the very same jsonb document with no validation
 * at all — so the document had two standards depending on which writer touched
 * it, and the unchecked one was the writer whose values a language model chose
 * from a PDF.
 *
 * The results are not exotic. `volatility` is a fraction here and capped at 5;
 * a model reading "volatility of 65%" off a page and reporting `65` wrote a
 * 6,500% volatility that no analyst could have typed, and the OPM happily
 * priced against it. A negative share count is refused as `pos` here and was
 * accepted there. None of it is visible in the UI, which renders whatever the
 * document holds.
 *
 * Fields are dropped individually rather than the batch being refused: an
 * extraction that found eight good figures and one bad one is still worth
 * applying, and the rejects are returned so the caller can say what was
 * ignored instead of silently losing it.
 *
 * `revenue_*` and `ebitda_*` are not in the analyst schema — they are not
 * engine inputs an analyst edits but the financials the market approach is
 * struck against, selected by `params.market_method` × `params.market_horizon`
 * (compute._market_metric). They are only required to be real numbers, not
 * positive ones: EBITDA is routinely negative for a venture-backed company,
 * and the engine is the right place to refuse a multiple against a negative
 * denominator, since which horizon is even in play is a params question.
 */
const EXTRACTED_FIELD_SCHEMAS: Readonly<Record<string, z.ZodType<number>>> = {
  shares_outstanding_common: pos,
  shares_outstanding_preferred: nonNeg,
  options_outstanding: nonNeg,
  liquidation_preference: nonNeg,
  last_round_post_money: nonNeg,
  last_round_price_per_share: nonNeg,
  cash: nonNeg,
  debt: nonNeg,
  // Signed, for the reason in the block comment above — EBITDA is routinely
  // negative — but bounded in magnitude like every other money figure. A
  // revenue of 1e17 is a unit slip, and it is the denominator of a market
  // multiple.
  revenue_ltm: boundedSigned(),
  revenue_ntm: boundedSigned(),
  ebitda_ltm: boundedSigned(),
  ebitda_ntm: boundedSigned(),
  volatility: z.number().positive().max(5),
  risk_free_rate: z.number().min(0).max(1),
};

/** Field names the extraction pipeline is allowed to propose. */
export const EXTRACTABLE_INPUT_FIELDS: readonly string[] = Object.keys(EXTRACTED_FIELD_SCHEMAS);

export interface RejectedInput {
  field: string;
  value: unknown;
  reason: string;
}

export interface SanitizedExtraction {
  /** Fields that passed, ready to merge into `engine_inputs`. */
  applied: Record<string, number>;
  /** Fields dropped, with why — surfaced to the caller, never applied. */
  rejected: RejectedInput[];
}

/**
 * Filter an extraction result down to the fields that would survive
 * hand-entry. Unknown keys are rejected too: the AI service already whitelists
 * them, and agreeing about the list on both sides is cheaper than trusting it.
 */
export function sanitizeExtractedInputs(raw: unknown): SanitizedExtraction {
  const applied: Record<string, number> = {};
  const rejected: RejectedInput[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { applied, rejected };

  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const schema = EXTRACTED_FIELD_SCHEMAS[field];
    if (!schema) {
      rejected.push({ field, value, reason: 'not an engine input this pipeline may set' });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) applied[field] = parsed.data;
    else rejected.push({ field, value, reason: parsed.error.issues[0]?.message ?? 'invalid value' });
  }
  return { applied, rejected };
}

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

export function registerEngineInputsRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (principal: Principal, id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };

  // Read the current financial model (the raw engine_inputs document).
  app.get('/api/v1/valuations/:id/engine-inputs', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const params = await findParams(deps.pool, id);
    if (!params) throw problems.notFound();
    // The version the editor sends back as If-Match. Also in the body, because
    // fetch wrappers routinely discard response headers and a version the
    // client cannot read is a guard it cannot use.
    reply.header('ETag', versionEtag(params.version));
    return { engine_inputs: params.engine_inputs ?? {}, version: params.version };
  });

  // Hand-enter / edit the financial model. Ops-only, mirroring the params and
  // calculation routes (methodology + inputs are analyst work).
  app.patch('/api/v1/valuations/:id/engine-inputs', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Financial model inputs are operations-only');
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadValuation(principal, id), 'accepting model inputs');
    const current = await findParams(deps.pool, id);
    if (!current) throw problems.notFound();

    // Same contract as PATCH /valuations/:id — see domain/concurrency.ts. A
    // malformed header is refused rather than ignored: an If-Match nobody
    // parses is a lost-update guard that silently is not there.
    const ifMatch = parseIfMatch(req.headers['if-match']);
    if (ifMatch.kind === 'invalid') {
      throw malformedIfMatch(ifMatch);
    }
    const expectedVersion = ifMatch.kind === 'version' ? ifMatch.version : undefined;

    const parsed = EngineInputsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid financial model inputs', parsed.error);
    }

    const updated = await applyEngineInputs(
      deps.pool,
      id,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
      { expectedVersion },
    );
    reply.header('ETag', versionEtag(updated.version));
    return { params: updated };
  });
}
