import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { listComparableItems } from '../repos/comparableItems.js';
import { listOverwrites, upsertOverwrite } from '../repos/overwrites.js';
import { OVERWRITE_FIELDS_BY_KEY } from '../domain/overwrites.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  findVolatilityEstimate,
  insertVolatilityEstimate,
  listVolatilityEstimates,
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
import { refuseIfRetired } from '../domain/retiredEngagement.js';

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
    manual_override: z.number().gt(0).lt(5).nullish(),
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

/** One numeric `valuation_params` override, as the calculation would read it. */
function overrideNumber(
  overwrites: Array<{ field_key: string; value: unknown }>,
  key: string,
): number | null {
  const row = overwrites.find((o) => o.field_key === key);
  if (!row) return null;
  const n = typeof row.value === 'number' ? row.value : Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/** The engagement's sigma as the calculation would read it today. */
function appliedVolatility(overwrites: Array<{ field_key: string; value: unknown }>): number | null {
  return overrideNumber(overwrites, 'volatility');
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

    const [estimates, overwrites, peers] = await Promise.all([
      listVolatilityEstimates(deps.pool, valuation.id),
      listOverwrites(deps.pool, valuation.id),
      listComparableItems(deps.pool, valuation.id),
    ]);

    return {
      estimates: estimates.map(present),
      applied_volatility: appliedVolatility(overwrites),
      // What an estimate would be struck on if one were run now. A set with no
      // tickers in it is the reason the button cannot work, and saying so here
      // is cheaper than a 422 after the press.
      eligible_tickers: peers.filter((p) => p.included && p.ticker !== null).map((p) => p.ticker!),
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
        throw problems.unprocessable('Invalid volatility request', { errors: parsed.error.issues });
      }
      const { method, window_days, manual_override } = parsed.data;

      const peers = await listComparableItems(deps.pool, valuation.id);
      const tickers = peers.filter((p) => p.included && p.ticker !== null).map((p) => p.ticker!);
      if (tickers.length === 0 && (manual_override === null || manual_override === undefined)) {
        throw problems.unprocessable(
          'No included comparable in this peer set carries a ticker to measure — screen the set on the ' +
            'Network Items tab first, or pin a volatility by hand',
        );
      }

      const [paramsRow, currentOverwrites] = await Promise.all([
        findParams(deps.pool, valuation.id),
        listOverwrites(deps.pool, valuation.id),
      ]);
      const rawDate = (paramsRow?.engine_inputs as { valuation_date?: unknown } | null | undefined)
        ?.valuation_date;
      const valuationDate = typeof rawDate === 'string' && rawDate ? rawDate : null;
      // Carried through to the engine and onto the row so the exhibit can print
      // the horizon beside the window. The estimator does not use it to compute
      // anything — it is disclosure, and the point of the disclosure is to let a
      // reviewer see whether a one-year measurement is supporting a five-year
      // option.
      const timeToExit = overrideNumber(currentOverwrites, 'time_to_exit_years');

      let window: { start: string; end: string };
      try {
        window = resolveWindow(valuationDate, window_days, new Date());
      } catch (err) {
        if (err instanceof VolatilityInputError) throw problems.unprocessable(err.message);
        throw err;
      }

      const series: VolatilitySeries[] = [];
      const feedFailures: VolatilityExclusion[] = [];
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
            feedFailures.push({ ticker, reason: 'the price feed could not be reached' });
            continue;
          }
          throw err;
        }

        // A fallback payload is the engine's caller-supplied estimate, not an
        // observed price series. Measuring a volatility off it would produce a
        // figure with a peer's name on it that the peer never had.
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
          req.log.warn({ err }, 'volatility estimate failed');
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

      const overwrites = await listOverwrites(deps.pool, valuation.id);
      return reply.status(201).send({
        estimate: present(row),
        applied_volatility: appliedVolatility(overwrites),
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

      const def = OVERWRITE_FIELDS_BY_KEY.get('volatility');
      // The field is a constant of domain/overwrites.ts, so this is a
      // programming error rather than a request the caller can fix. Thrown
      // rather than answered, so it reaches the error handler as a 500 and the
      // logs as a stack — a route that quietly wrote nothing would be worse.
      if (!def) throw new Error('The volatility override field is not defined');

      const before = appliedVolatility(await listOverwrites(deps.pool, valuation.id));
      await upsertOverwrite(deps.pool, {
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

      const applied = await markVolatilityEstimateApplied(deps.pool, valuation.id, estimateId, principal.id);
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
