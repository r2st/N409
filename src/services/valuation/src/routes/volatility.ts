import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { withTransaction } from '../db/pool.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { applyEngineInputsWithin, findParams, type ValuationParamsRow } from '../repos/params.js';
import { listComparableItems } from '../repos/comparableItems.js';
import { upsertOverwriteWithin } from '../repos/overwrites.js';
import { OVERWRITE_FIELDS_BY_KEY, validateOverwriteValue } from '../domain/overwrites.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  findVolatilityEstimate,
  insertVolatilityEstimate,
  listVolatilityEstimates,
  VOLATILITY_ESTIMATE_PAGE_LIMIT,
  markVolatilityEstimateApplied,
  type VolatilityEstimateRow,
  type VolatilityExclusion,
} from '../repos/volatilityEstimates.js';
import {
  DEFAULT_WINDOW_DAYS,
  isoDate,
  measuredCount,
  resolveWindow,
  seriesFromBars,
  shapeEstimate,
  VOLATILITY_METHODS,
  VolatilityInputError,
  type VolatilityEngineResponse,
  type VolatilitySeries,
} from '../domain/volatility.js';
import { refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { recordMarketFeedAnswer } from '../clients/marketFeedMetrics.js';

/**
 * Selected volatility — the derivation behind sigma.
 *
 * `engine/v1/volatility` has estimated expected volatility from comparable
 * price series since it was written, and had no caller. Every 409A on the
 * platform therefore ran its OPM allocation, its option-based DLOM and its
 * ASC 718 assumptions on a number an analyst typed into a field labelled
 * "Equity volatility from guideline companies", with no guideline company
 * anywhere behind it. This is that endpoint's caller.
 *
 * The shape follows the peer-set refresh in routes/comparables.ts, for the same
 * reasons and with one addition:
 *
 *   * The price feed answers per ticker and can answer for some and not
 *     others. One unreachable ticker is not a failed estimate — it is a peer
 *     reported as considered and not measured, named in the stored run, and
 *     the estimate is struck on the rest.
 *   * Estimating and adopting are separate calls. An estimate that silently
 *     overwrote the engagement's sigma would move the concluded value of a
 *     valuation somebody may already have reviewed, on a button labelled
 *     "estimate". Adoption is its own POST, writes through the ordinary
 *     override path so it lands in the audit trail as an override like any
 *     other, and is the only thing that makes Exhibit F-1 claim the
 *     derivation belongs to the calculation.
 *
 * Reading is open to anyone who can read the engagement — "where did 64% come
 * from" is a fair question from the client whose report rests on it. Estimating
 * and adopting are operations-only.
 */

/** Wall clock for one ticker's price history. Per ticker, not per set. */
const FEED_TIMEOUT_MS = 12_000;

/** Wall clock for the estimator itself. In-process arithmetic; generous. */
const ESTIMATE_TIMEOUT_MS = 15_000;

/**
 * The most peers one estimate will fetch price history for.
 *
 * A screen returns at most twelve, so this is not a limit an ordinary set
 * reaches. It bounds the case that would otherwise be unbounded: a hand-built
 * set of a hundred tickers turning one button press into a hundred sequential
 * third-party fetches.
 */
const MAX_SERIES = 20;

/**
 * The `volatility` override field, and why this file needs it.
 *
 * Adopting an estimate writes `overwrites` for this field — see the apply
 * route below — and `domain/overwrites.ts` declares a range for it:
 * `{ min: 0.05, max: 3 }`. That range is enforced by `validateOverwriteValue`,
 * which `routes/overwrites.ts` calls and this file did not, so the two doors
 * onto one cell disagreed about what may be in it. `manual_override` was
 * `gt(0).lt(5)`, wider at both ends, and an estimate pinned at 4.5 was adopted
 * into a field whose own schema endpoint tells the overwrites tab the maximum
 * is 3 — a value that screen then refuses to save back.
 *
 * Read once here rather than at each use: the field is a constant of that
 * module, so an absent one is a programming error, and this is the point where
 * it is cheap to say so.
 */
const VOLATILITY_FIELD = (() => {
  const def = OVERWRITE_FIELDS_BY_KEY.get('volatility');
  if (!def) throw new Error('The volatility override field is not defined');
  return def;
})();

const EstimateBody = z
  .object({
    method: z.enum(VOLATILITY_METHODS).default('historical'),
    /** Observation window length, in days back from the valuation date. */
    window_days: z.number().int().min(30).max(3650).default(DEFAULT_WINDOW_DAYS),
    /**
     * Pins the estimate rather than deriving it. The engine echoes it back as
     * the recommendation with `method: "manual"`, so an analyst's judgement is
     * recorded in the same table, with the same peer measurements beside it,
     * rather than as an unexplained number in a params field.
     */
    manual_override: z
      .number()
      .min(VOLATILITY_FIELD.min ?? 0)
      .max(VOLATILITY_FIELD.max ?? Number.MAX_SAFE_INTEGER)
      .nullish(),
  })
  .strict();

/** `engine/v1/market-feed` `kind: "prices"`. */
interface PriceFeedResponse {
  source?: unknown;
  warning?: unknown;
  prices?: unknown;
}

function present(row: VolatilityEstimateRow) {
  return {
    id: row.id,
    method: row.method,
    periods_per_year: row.periods_per_year,
    // `date` columns; see domain/calendarDate.ts for why not toISOString.
    window_start: isoDate(row.window_start),
    window_end: isoDate(row.window_end),
    time_to_exit_years: row.time_to_exit_years,
    recommended: row.recommended,
    median_volatility: row.median_vol,
    mean_volatility: row.mean_vol,
    min_volatility: row.min_vol,
    max_volatility: row.max_vol,
    coefficient_of_variation: row.coefficient_of_variation,
    confidence: row.confidence,
    manual_override: row.manual_override,
    companies: row.companies,
    excluded: row.excluded,
    // Derived here rather than stored, so the count and the rows behind it can
    // never disagree.
    measured_count: measuredCount(row),
    applied_at: row.applied_at,
    created_at: row.created_at,
  };
}

/**
 * One numeric engine input, as the calculation would read it.
 *
 * `valuation_params.engine_inputs` rather than the `overwrites` table, because
 * that is where the figure is read from: `buildEngineInputs`
 * (routes/calculations.ts) assembles a run from the stored extraction, this
 * document, the screened peer set and the caller's body, and no path merges an
 * override into it. The override registry is the audit trail beside the figure
 * — the before/after pair and the reason naming the run — not the figure.
 *
 * Both of this file's questions were asked of the trail. Sigma is the one this
 * panel exists for, and it read back only what the adopt route had written, so
 * an engagement whose volatility was typed on the financial-model form — the
 * ordinary way it is set — showed "no applied figure" beside a derivation the
 * calculation was in fact already ignoring or already agreeing with, and the
 * reviewer could not tell which. The horizon carried onto an estimate row is
 * the same mistake with a quieter symptom: `time_to_exit_years` is an engine
 * input like any other, so Exhibit F-1 printed a measurement window with no
 * expected term beside it on every engagement that had one, and the disclosure
 * the horizon exists to make — whether a one-year measurement is supporting a
 * five-year option — silently was not made.
 */
function engineInputNumber(paramsRow: ValuationParamsRow | null | undefined, key: string): number | null {
  const inputs = paramsRow?.engine_inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  const raw = (inputs as Record<string, unknown>)[key];
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The engagement's sigma as the calculation would read it today. */
function appliedVolatility(paramsRow: ValuationParamsRow | null | undefined): number | null {
  return engineInputNumber(paramsRow, 'volatility');
}

export function registerVolatilityRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadReadable = async (id: string, principal: Principal): Promise<ValuationRow> => {
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

  const loadOps = async (id: string, principal: Principal): Promise<ValuationRow> => {
    if (!isOps(principal)) throw problems.forbidden('Deriving the volatility is operations-only');
    return loadReadable(id, principal);
  };

  const audit = async (
    valuation: ValuationRow,
    principal: Principal,
    type: AdminEventType,
    payload: Record<string, unknown>,
  ) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload,
    });

  /**
   * Every derivation run for this engagement, newest first, and the sigma the
   * calculation would read today.
   *
   * The applied figure is served beside the runs rather than left for the
   * caller to fetch from the params tab, because the only question the panel
   * exists to answer is whether the two agree.
   */
  app.get('/api/v1/valuations/:id/volatility', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(id, principal);

    const [estimatePage, paramsRow, peerPage] = await Promise.all([
      listVolatilityEstimates(deps.pool, valuation.id),
      findParams(deps.pool, valuation.id),
      listComparableItems(deps.pool, valuation.id),
    ]);

    return {
      estimates: estimatePage.estimates.map(present),
      // The derivation history is a page. The adopted run can be anywhere in
      // it — adopting is a POST on any run by id — so a capped list is one
      // that can be missing the row `applied_volatility` came from.
      estimates_truncated: estimatePage.truncated,
      estimates_page_limit: VOLATILITY_ESTIMATE_PAGE_LIMIT,
      applied_volatility: appliedVolatility(paramsRow),
      // What an estimate would be struck on if one were run now. A set with no
      // tickers in it is the reason the button cannot work, and saying so here
      // is cheaper than a 422 after the press.
      eligible_tickers: peerPage.items.filter((p) => p.included && p.ticker !== null).map((p) => p.ticker!),
      // The tickers an estimate would be struck on come off a page of the peer
      // set, so a set past the cap would measure volatility over fewer peers
      // than the engagement holds — and the resulting figure would carry no
      // sign of it.
      peers_truncated: peerPage.truncated,
      can_edit: isOps(principal),
    };
  });

  /**
   * Measure the peer set and record the estimate.
   *
   * Does not touch the engagement's sigma — see the module note.
   */
  app.post(
    '/api/v1/valuations/:id/volatility/estimate',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id } = req.params as { id: string };
      const valuation = await loadOps(id, principal);
      refuseIfRetired(valuation, 'accepting volatility estimates');

      const parsed = EstimateBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw invalidBody('Invalid volatility request', parsed.error);
      }
      const { method, window_days, manual_override } = parsed.data;

      const { items: peers } = await listComparableItems(deps.pool, valuation.id);
      const tickers = peers.filter((p) => p.included && p.ticker !== null).map((p) => p.ticker!);
      if (tickers.length === 0 && (manual_override === null || manual_override === undefined)) {
        throw problems.unprocessable(
          'No included comparable in this peer set carries a ticker to measure — screen the set on the ' +
            'Network Items tab first, or pin a volatility by hand',
        );
      }

      const paramsRow = await findParams(deps.pool, valuation.id);
      const rawDate = (paramsRow?.engine_inputs as { valuation_date?: unknown } | null | undefined)
        ?.valuation_date;
      const valuationDate = typeof rawDate === 'string' && rawDate ? rawDate : null;
      // Carried through to the engine and onto the row so the exhibit can print
      // the horizon beside the window. The estimator does not use it to compute
      // anything — it is disclosure, and the point of the disclosure is to let a
      // reviewer see whether a one-year measurement is supporting a five-year
      // option.
      const timeToExit = engineInputNumber(paramsRow, 'time_to_exit_years');

      let window: { start: string; end: string };
      try {
        window = resolveWindow(valuationDate, window_days, new Date());
      } catch (err) {
        if (err instanceof VolatilityInputError) throw problems.unprocessable(err.message);
        throw err;
      }

      const series: VolatilitySeries[] = [];
      const feedFailures: VolatilityExclusion[] = [];
      /*
       * The peers `MAX_SERIES` cuts off, named.
       *
       * The cap is a real one and stays — twenty sequential third-party fetches
       * is already the ceiling a button press should carry. What it must not do
       * is take peers out of the measurement without saying so. `excluded` is
       * the list the exhibit prints under "Considered and not measured", the
       * one the module note promises names every peer that is in the set and
       * out of the number, and a ticker dropped here was in neither it nor
       * `companies`: an estimate struck on twenty of thirty peers reported
       * twenty peers and a set of twenty, and nothing on the row, in the audit
       * event or in the exhibit carried a trace of the other ten.
       *
       * `listComparableItems` orders included first and then by score, so the
       * tail is the lowest-scoring end of the screened set — which is the right
       * end to drop and still the wrong thing to drop silently.
       */
      const overCap = tickers.slice(MAX_SERIES);
      // Sequential rather than concurrent: this leaves the process for a
      // third-party API that rate-limits, and twenty parallel fetches is the
      // shape that gets an API key throttled for everyone on the deployment.
      for (const ticker of tickers.slice(0, MAX_SERIES)) {
        let feed: PriceFeedResponse;
        try {
          feed = await postJson<PriceFeedResponse>(
            'engine',
            `${deps.engineUrl}/engine/v1/market-feed`,
            { kind: 'prices', ticker, start: window.start, end: window.end },
            {
              timeoutMs: FEED_TIMEOUT_MS,
              record: { valuationId: valuation.id, name: 'engine market-feed prices' },
            },
          );
        } catch (err) {
          if (err instanceof InternalServiceError) {
            req.log.warn({ err, ticker }, 'price history fetch failed');
            recordMarketFeedAnswer('prices', 'unreachable');
            feedFailures.push({ ticker, reason: 'the price feed could not be reached' });
            continue;
          }
          throw err;
        }

        // A fallback payload is the engine's caller-supplied estimate, not an
        // observed price series. Measuring a volatility off it would produce a
        // figure with a peer's name on it that the peer never had.
        //
        // Counted (R305, M11): a fallback is a 200, so the breaker, the
        // `network_items` row and `http_request_errors_total` all read healthy
        // and are right to — nothing failed. Until this counter the only
        // record that the live source had gone dark was a per-ticker line in
        // the body of one request, read by one analyst.
        recordMarketFeedAnswer('prices', feed.source === 'yfinance' ? 'observed' : 'fallback');
        if (feed.source !== 'yfinance') {
          feedFailures.push({
            ticker,
            reason:
              typeof feed.warning === 'string' && feed.warning.trim() !== ''
                ? feed.warning.trim()
                : 'the live price source returned no observed history',
          });
          continue;
        }
        const built = seriesFromBars(ticker, feed.prices, method);
        if (built === null) {
          feedFailures.push({
            ticker,
            reason:
              method === 'parkinson'
                ? 'no complete high/low history over the window'
                : 'fewer than two usable closing prices over the window',
          });
          continue;
        }
        series.push(built);
      }

      // Appended after the fetch loop so the exhibit reads the peers that were
      // tried and failed before the ones that were never reached.
      for (const ticker of overCap) {
        feedFailures.push({
          ticker,
          reason: `outside the ${MAX_SERIES} highest-scoring peers this estimate measures`,
        });
      }

      if (series.length === 0 && (manual_override === null || manual_override === undefined)) {
        throw problems.unprocessable(
          'No comparable in this set had usable price history over the window. Widen the window, or ' +
            'pin a volatility by hand.',
          { excluded: feedFailures },
        );
      }

      let response: VolatilityEngineResponse;
      try {
        response = await postJson<VolatilityEngineResponse>(
          'engine',
          `${deps.engineUrl}/engine/v1/volatility`,
          {
            comparables: series,
            method,
            periods_per_year: 252,
            ...(timeToExit === null ? {} : { time_to_exit_years: timeToExit }),
            ...(manual_override === null || manual_override === undefined ? {} : { manual_override }),
          },
          {
            timeoutMs: ESTIMATE_TIMEOUT_MS,
            record: { valuationId: valuation.id, name: 'engine volatility' },
          },
        );
      } catch (err) {
        if (err instanceof InternalServiceError) {
          req.log.warn({ err, valuationId: valuation.id }, 'volatility estimate failed');
          throw toProblem(err);
        }
        throw err;
      }

      let shaped: ReturnType<typeof shapeEstimate>;
      try {
        shaped = shapeEstimate(response, { series, feedFailures });
      } catch (err) {
        if (err instanceof VolatilityInputError) throw problems.unprocessable(err.message);
        throw err;
      }

      // The engagement as it stands now — see the guard on the compute in
      // `calculations.ts`. This one also leaves the process twice, for the
      // price feed and then the estimate, so the gap is the wider of the set.
      await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting volatility estimates');
      const row = await insertVolatilityEstimate(deps.pool, {
        valuationId: valuation.id,
        method: shaped.method,
        periodsPerYear: 252,
        windowStart: window.start,
        windowEnd: window.end,
        timeToExitYears: timeToExit,
        recommended: shaped.recommended,
        medianVol: shaped.medianVol,
        meanVol: shaped.meanVol,
        minVol: shaped.minVol,
        maxVol: shaped.maxVol,
        coefficientOfVariation: shaped.coefficientOfVariation,
        confidence: shaped.confidence,
        manualOverride: shaped.manualOverride,
        companies: shaped.companies,
        excluded: shaped.excluded,
        createdBy: principal.id,
      });

      await audit(valuation, principal, 'volatility_estimated', {
        estimate_id: row.id,
        method: row.method,
        recommended: row.recommended,
        confidence: row.confidence,
        measured: measuredCount(row),
        excluded: row.excluded.map((e) => e.ticker),
        window: { start: window.start, end: window.end },
      });

      return reply.status(201).send({
        estimate: present(row),
        // Re-read rather than reusing `paramsRow` above: the estimate run
        // leaves the process for a rate-limited third-party feed one ticker at
        // a time, and the figure this answers with is the one the calculation
        // would read *now*.
        applied_volatility: appliedVolatility(await findParams(deps.pool, valuation.id)),
      });
    },
  );

  /**
   * Adopt a run's recommendation as the engagement's expected volatility.
   *
   * Writes through `upsertOverwrite` rather than straight into the params row,
   * so the change lands in the override audit trail with a before/after pair
   * exactly as a hand-typed change would. The reason it records names the run,
   * which is what turns "sigma changed from 0.65 to 0.64" into an entry a
   * reviewer can follow back to eleven tickers and a window.
   */
  app.post(
    '/api/v1/valuations/:id/volatility/:estimateId/apply',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, estimateId } = req.params as { id: string; estimateId: string };
      const valuation = await loadOps(id, principal);
      refuseIfRetired(valuation, 'applying results');
      if (!isUlid(estimateId)) throw problems.notFound();

      const estimate = await findVolatilityEstimate(deps.pool, valuation.id, estimateId);
      if (!estimate) throw problems.notFound();

      const def = VOLATILITY_FIELD;
      /*
       * The check `routes/overwrites.ts` makes on the same cell.
       *
       * This route imposes a figure on `volatility` exactly as a hand-typed
       * override does — `upsertOverwrite` below, then `applyEngineInputs` — and
       * it was the one of the two doors that never asked the field whether the
       * figure was in range. `validateOverwriteValue`'s own note says the range
       * "applies to `value` — the figure the analyst is imposing, which becomes
       * the valuation's input and has to be one the model can stand behind",
       * and this is that figure arriving by the other route.
       *
       * `manual_override` is bounded at the estimate door now, so the reachable
       * case here is a *derived* recommendation: a peer set whose median sigma
       * lands outside the range is a real measurement worth recording and not a
       * figure to price a §409A off, so it is refused at adoption rather than
       * at the run that produced it.
       */
      const outOfRange = validateOverwriteValue(def, estimate.recommended);
      if (outOfRange) {
        throw problems.unprocessable(
          `This estimate recommends a volatility of ${estimate.recommended}, which cannot be ` +
            `applied: ${outOfRange}.`,
        );
      }

      const before = appliedVolatility(await findParams(deps.pool, valuation.id));

      /*
       * THE THREE WRITES OF AN ADOPTION ARE ONE DECISION (R404, methodology
       * M5).
       *
       * They were three statements on the pool, each in its own transaction,
       * run in order with nothing holding them together — and the note below
       * already spells out what any two of them disagreeing looks like:
       * "adopting a derived sigma moved a number on the volatility screen and
       * moved nothing else… The screen said 64.0% was applied; the allocation
       * ran on 65.0%." That was the bug this route was written to close, and a
       * failure part-way re-opened it exactly:
       *
       *   * `upsertOverwrite` alone — the overwrites tab reports 64.0% imposed
       *     with a reason naming this estimate, and `engine_inputs.volatility`
       *     is still 65.0%, so the next calculation concludes the same FMV it
       *     already had;
       *   * that and `applyEngineInputs` — the engine now runs the adopted
       *     figure while `applied_at` still names the previously adopted
       *     estimate, which is the disagreement
       *     `markVolatilityEstimateApplied` documents at length.
       *
       * And the caller is told none of it. A 500 answers "the adoption failed",
       * which is the one thing that is not true of any of these states, and the
       * analyst's obvious next move — press Adopt again — reads `before` from
       * the params the failed attempt already moved, so
       * `recalculation_required` below comes back `false` for an engagement
       * whose stored results were struck on the old sigma.
       *
       * One transaction, so the three land together or not at all and the 500
       * means what it says. The `…_applied` admin event stays outside it, with
       * the other sixty-odd `recordAdminEvent` call sites: no route in this
       * estate contains that failure, and diverging here would be worse than
       * the convention.
       */
      const applied = await withTransaction(deps.pool, async (client) => {
        await upsertOverwriteWithin(client, {
          valuationId: valuation.id,
          def,
          value: estimate.recommended,
          reason:
            estimate.method === 'manual'
              ? `Analyst-selected volatility recorded against the peer set (estimate ${estimate.id})`
              : `Median of ${measuredCount(estimate)} guideline companies, ` +
                `${isoDate(estimate.window_start)} to ` +
                `${isoDate(estimate.window_end)} (estimate ${estimate.id})`,
          originalValue: before,
          actor: { actorType: 'human', actorId: principal.id },
        });

        /*
         * The half of "adopt" that reaches the engine.
         *
         * `upsertOverwrite` above writes the override registry — the audit
         * trail, the "was 0.65, now 0.64" on the overwrites tab, and the
         * `applied_volatility` this route and the panel both answer with. What
         * it does not do is change what the calculation runs on: nothing merges
         * the `overwrites` table into the engine payload. `buildEngineInputs`
         * (routes/calculations.ts) assembles the run from the stored extraction,
         * `valuation_params.engine_inputs`, the peer set and the caller's own
         * body, and never reads an override.
         *
         * So adopting a derived sigma moved a number on the volatility screen
         * and moved nothing else. A recalculation — the one this route's
         * `recalculation_required` tells the analyst to run — re-read
         * `engine_inputs.volatility`, found the figure that was there before the
         * adoption, and concluded the same FMV per share it had already
         * concluded. The screen said 64.0% was applied; the allocation ran on
         * 65.0%, and `results.assumptions.volatility` (what the report summary
         * and Exhibit F actually print) agreed with the allocation. The only
         * surface that carried the adopted figure was the one that recorded it.
         *
         * Written where the engine reads it, with the same `||` merge the
         * extraction auto-apply uses. No `expectedVersion`: like that path, this
         * is applying a figure the caller just derived on this engagement rather
         * than saving a form somebody has been looking at, and the field it
         * touches is the one the adopted estimate is about.
         */
        await applyEngineInputsWithin(
          client,
          valuation.id,
          { volatility: estimate.recommended },
          { actorType: 'human', actorId: principal.id, source: 'api' },
        );

        return markVolatilityEstimateApplied(client, valuation.id, estimateId, principal.id);
      });

      await audit(valuation, principal, 'volatility_applied', {
        estimate_id: estimateId,
        from: before,
        to: estimate.recommended,
      });

      return {
        estimate: applied ? present(applied) : present(estimate),
        applied_volatility: estimate.recommended,
        // The engagement's figures are now stale against the params. Saying so
        // is the route's job; recalculating on its own would be a second,
        // unasked-for change to a valuation somebody may be mid-review on.
        recalculation_required: before === null || Math.abs(before - estimate.recommended) > 1e-9,
      };
    },
  );
}
