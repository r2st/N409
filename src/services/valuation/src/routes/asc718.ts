import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { todayLocal } from '../domain/calendarDate.js';
import { asc718Portfolio, type Asc718Grant } from '../domain/asc718.js';
import {
  binomialLattice,
  DEFAULT_MC_PATHS,
  esppFairValue,
  historicalExpectedTerm,
  historicalVolatility,
  marketConditionRsuMonteCarlo,
  MC_DRAW_BUDGET,
  monteCarloScale,
  performanceRsuMonteCarlo,
  relativeTsrMonteCarlo,
  rsuMarketFairValue,
  scaleMonteCarloPaths,
  simplifiedExpectedTerm,
} from '../domain/asc718Public.js';
import { findValuationById } from '../repos/valuations.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { concludes409AFmvPerShare, headlineLabels, specialtyRunKind } from '../domain/specialty.js';
import { kindLabel } from '../domain/valuationSelector.js';
import { findAsc718Settings, upsertAsc718Settings } from '../repos/asc718Settings.js';
import { postJson } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { recordMarketFeedAnswer } from '../clients/marketFeedMetrics.js';

/**
 * ASC 718 stock-based-compensation expense (domain/asc718.ts + asc718Public.ts).
 *
 * Private path (default): the concluded 409A FMV is the grant-date underlying,
 * a SAB 107 simplified term, and a peer-derived volatility. Public path
 * (company_type = 'public'): the underlying and expected volatility come from
 * the issuer's own traded price via the market feed, expected term can use a
 * lattice or the issuer's historical exercise data, and the module prices the
 * award types public issuers grant — ESPPs, RSUs, and relative-TSR awards.
 *
 * Ops only; the compute endpoint is stateless (like sensitivity). A small
 * settings row (asc718_settings) persists the public-company configuration.
 */

const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

/**
 * `options` carries the same ceiling as `options_granted` below, and for a
 * sharper reason than tidiness: `historicalExpectedTerm` divides the
 * option-weighted sum of years by the option total, so an unbounded count of
 * `1e999` — Infinity, which `.positive()` alone admits — makes that division
 * `Infinity / Infinity`, and the grant's expected term comes back NaN. NaN then
 * runs the whole way through Black-Scholes and lands in the response as `null`.
 */
const ExerciseHistory = z.object({
  years: z.number().min(0).max(30),
  options: z.number().positive().max(1e12),
});

const GrantBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  options_granted: z.number().positive().max(1e12),
  grant_date: DateStr,
  vesting_months: z.number().int().min(1).max(600),
  exercise_price: z.number().positive().max(1e9),
  expected_term_years: z.number().gt(0).max(30).optional(),
  volatility: z.number().gt(0).max(5).optional(),
  risk_free_rate: z.number().min(0).max(0.25),
  dividend_yield: z.number().min(0).max(0.25).optional(),
  forfeiture_rate: z.number().min(0).max(1).optional(),
  amortization_frequency_months: z
    .union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)])
    .optional(),
  /** Underlying FMV/market price at grant; defaults to the resolved underlying. */
  grant_date_fair_value: z.number().positive().max(1e9).optional(),
  /** Public expected-term method for this grant (overrides settings default). */
  expected_term_method: z.enum(['simplified', 'lattice', 'historical']).optional(),
  contractual_term_years: z.number().gt(0).max(30).optional(),
  exercise_multiple: z.number().gt(1).max(10).optional(),
  exercise_history: z.array(ExerciseHistory).max(200).optional(),
});

const EsppBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  shares_enrolled: z.number().positive().max(1e12),
  grant_date_price: z.number().positive().max(1e9),
  discount_pct: z.number().min(0).max(1),
  lookback_months: z.number().int().min(0).max(60),
  volatility: z.number().gt(0).max(5).optional(),
  risk_free_rate: z.number().min(0).max(0.25),
  dividend_yield: z.number().min(0).max(0.25).optional(),
});

const RsuBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  units: z.number().positive().max(1e12),
  condition: z.enum(['service', 'performance', 'market']).default('service'),
  market_price: z.number().positive().max(1e9).optional(),
  vesting_years: z.number().gt(0).max(30).optional(),
  dividend_yield: z.number().min(0).max(0.25).optional(),
  dividend_protected: z.boolean().optional(),
  // performance condition
  expected_attainment: z.number().min(0).max(5).optional(),
  attainment_volatility: z.number().min(0).max(5).optional(),
  max_payout_ratio: z.number().min(0).max(10).optional(),
  // market condition
  hurdle_price: z.number().positive().max(1e9).optional(),
  volatility: z.number().gt(0).max(5).optional(),
  risk_free_rate: z.number().min(0).max(0.25).optional(),
});

const TsrPeerBody = z.object({
  name: z.string().trim().min(1).max(120),
  volatility: z.number().gt(0).max(5),
  correlation: z.number().min(0).max(0.99).optional(),
  dividend_yield: z.number().min(0).max(0.25).optional(),
});

const TsrPayoutTier = z.object({
  percentile: z.number().min(0).max(100),
  payout_ratio: z.number().min(0).max(10),
});

const TsrBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  target_units: z.number().positive().max(1e12),
  underlying: z.number().positive().max(1e9).optional(),
  volatility: z.number().gt(0).max(5).optional(),
  dividend_yield: z.number().min(0).max(0.25).optional(),
  performance_period_years: z.number().gt(0).max(10),
  risk_free_rate: z.number().min(0).max(0.25),
  peers: z.array(TsrPeerBody).min(1).max(50),
  payout_schedule: z.array(TsrPayoutTier).min(1).max(20),
});

const Body = z
  .object({
    company_type: z.enum(['private', 'public']).default('private'),
    ticker: z.string().trim().min(1).max(12).optional(),
    valuation_date: DateStr.optional(),
    market_lookback_days: z.number().int().min(30).max(2520).optional(),
    grants: z.array(GrantBody).max(100).default([]),
    espp: z.array(EsppBody).max(50).optional(),
    rsu: z.array(RsuBody).max(100).optional(),
    tsr: z.array(TsrBody).max(20).optional(),
    default_grant_date_fair_value: z.number().positive().max(1e9).optional(),
    default_volatility: z.number().gt(0).max(5).optional(),
  })
  .strict();

/** Matches `TsrBody.peers`: a basket the TSR measurement below could actually price. */
const MAX_TSR_PEERS = 50;
/** Matches the `vars` cap in routes/communications.ts — a bounded key-value map. */
const MAX_RSU_CONDITIONS = 200;

const SettingsBody = z.object({
  company_type: z.enum(['private', 'public']),
  ticker: z.string().trim().min(1).max(12).nullish(),
  expected_term_method: z.enum(['simplified', 'lattice', 'historical']).optional(),
  espp_discount_pct: z.number().min(0).max(1).nullish(),
  espp_lookback_months: z.number().int().min(0).max(60).nullish(),
  /**
   * Bounded to exactly what the measurement they configure will accept.
   *
   * `Body` above caps every list it takes — `peers` at 50, `tsr` at 20, `grants`
   * at 100 — because each one costs a lattice or a simulation. These two are the
   * saved form of the same inputs, and they carried no bound at all: a settings
   * row is `jsonb`, so whatever fits inside Fastify's 1 MB body persisted
   * per engagement, was re-read on every ASC 718 tab load, and re-sent on every
   * save. A basket that cannot be measured is not a basket worth storing.
   */
  rsu_performance_conditions: z
    .record(z.unknown())
    .refine((v) => Object.keys(v).length <= MAX_RSU_CONDITIONS, {
      message: `At most ${MAX_RSU_CONDITIONS} performance conditions`,
    })
    .nullish(),
  tsr_peer_basket: z.array(z.unknown()).max(MAX_TSR_PEERS).nullish(),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('ASC 718 is operations-only');
}

interface MarketResolution {
  ticker: string;
  underlying: number | null;
  volatility: number | null;
  source: string;
  as_of: string | null;
  warning?: string;
}

/** Add days to a bare YYYY-MM-DD date (UTC). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the public issuer's underlying market price and own historical
 * volatility from the engine's live market feed. Best-effort: when the feed is
 * unavailable (no yfinance, offline) it returns a fallback resolution so the
 * caller's explicit defaults still drive the measurement.
 */
async function resolveMarket(
  engineUrl: string,
  ticker: string,
  end: string,
  lookbackDays: number,
  onUnavailable: (err: unknown) => void,
): Promise<MarketResolution> {
  const start = addDays(end, -lookbackDays);
  try {
    const res = await postJson<{ source: string; prices?: Array<{ date: string; close: number }> }>(
      'engine',
      `${engineUrl}/engine/v1/market-feed`,
      { kind: 'prices', ticker, start, end },
      { timeoutMs: 15_000 },
    );
    const prices = Array.isArray(res.prices) ? res.prices : [];
    const closes = prices.map((p) => Number(p.close)).filter((c) => Number.isFinite(c) && c > 0);
    // R305, M11. This call is deliberately best-effort and deliberately leaves
    // no `network_items` row, so a fallback here was the least visible of the
    // three: the measurement carries on against the caller's substituted
    // defaults and answers 200. The counter is the one place a feed that has
    // stopped returning observed prices shows up for every caller at once.
    // Tested positively — `=== 'yfinance'`, the way the other two call sites
    // ask it — rather than `!== 'fallback'`. The two spellings agree only while
    // the engine has exactly two words for `source`, and they fail in opposite
    // directions: a third word read as `observed` is an outage this counter
    // cannot see, which is the one thing it exists for.
    recordMarketFeedAnswer('prices', res.source === 'yfinance' ? 'observed' : 'fallback');
    if (res.source === 'yfinance' && closes.length >= 2) {
      /*
       * A sample standard deviation needs two returns, so three closes. Two
       * closes clear the length check and then divide by zero:
       * `historicalVolatility` returns NaN, NaN is not nullish so it survives
       * the `??` defaults below and every `volatility === undefined` refusal,
       * and Black-Scholes lands a `null` fair value in the response — the same
       * silent-NaN failure the exercise-history ceiling above exists to
       * prevent. A flat series is the same shape of problem from the other
       * end: a real 0 that no option can be priced against.
       *
       * Neither is a reason to discard the last close, which is a fact the feed
       * did give us. Report the underlying, withhold the volatility, and let
       * the per-grant refusal name the award it is missing for.
       */
      const computed = closes.length >= 3 ? historicalVolatility(closes, 252) : NaN;
      const usable = Number.isFinite(computed) && computed > 0;
      return {
        ticker,
        underlying: closes[closes.length - 1]!,
        volatility: usable ? computed : null,
        source: res.source,
        as_of: prices[prices.length - 1]?.date ?? end,
        ...(usable ? {} : { warning: 'not enough price history to derive a volatility' }),
      };
    }
    return {
      ticker,
      underlying: null,
      volatility: null,
      source: 'fallback',
      as_of: null,
      warning: 'no live prices for ticker',
    };
  } catch (err) {
    // The caller is told, in one string, and the operator was told nothing at
    // all. 'market feed unavailable' is the same warning for an engine that is
    // down, a ticker the feed does not carry, a 500, and a body that would not
    // parse — and the measurement continues on the caller's own defaults, so
    // the fair values in the response were computed from a substituted
    // volatility with no record anywhere of what was substituted for. Every
    // other engine call in this service leaves a `network_items` row; this one
    // is best-effort and deliberately leaves none, which makes the log line the
    // only place the reason can live.
    onUnavailable(err);
    recordMarketFeedAnswer('prices', 'unreachable');
    return {
      ticker,
      underlying: null,
      volatility: null,
      source: 'fallback',
      as_of: null,
      warning: 'market feed unavailable',
    };
  }
}

/**
 * Resolve a grant's expected term from the elected method.
 *
 * The election is the grant's own, then the engagement's saved ASC 718 setting,
 * then simplified. The middle step is what `GrantBody.expected_term_method`
 * already calls "the settings default": the row was written by PUT
 * .../asc718/settings and read back by GET, and nothing had ever applied it —
 * the browser tab happens to stamp its local copy onto every grant it submits,
 * so the setting worked from the UI and was inert for every other caller.
 */
function resolveExpectedTerm(
  g: z.infer<typeof GrantBody>,
  settingsMethod: 'simplified' | 'lattice' | 'historical' | undefined,
  underlying: number,
  volatility: number,
): number {
  const method = g.expected_term_method ?? settingsMethod ?? 'simplified';
  if (method === 'historical') {
    if (!g.exercise_history || g.exercise_history.length === 0) {
      throw problems.unprocessable(
        `Grant "${g.label ?? 'unnamed'}" uses the historical term method but has no exercise_history`,
      );
    }
    return historicalExpectedTerm(g.exercise_history);
  }
  if (method === 'lattice') {
    const contractual = g.contractual_term_years ?? g.expected_term_years ?? g.vesting_months / 12 + 6;
    const { expectedTermYears } = binomialLattice({
      underlying,
      strike: g.exercise_price,
      contractualTermYears: contractual,
      vestingYears: g.vesting_months / 12,
      volatility,
      riskFreeRate: g.risk_free_rate,
      dividendYield: g.dividend_yield,
      exerciseMultiple: g.exercise_multiple,
    });
    return expectedTermYears;
  }
  // simplified: use the supplied term, else derive it from vesting + contractual.
  if (g.expected_term_years) return g.expected_term_years;
  const contractual = g.contractual_term_years ?? g.vesting_months / 12 + 6;
  return simplifiedExpectedTerm(g.vesting_months / 12, contractual);
}

export function registerAsc718Routes(app: FastifyInstance, deps: { pool: pg.Pool; engineUrl: string }): void {
  const loadValuation = async (id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.get('/api/v1/valuations/:id/asc718/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(id);
    return { settings: await findAsc718Settings(deps.pool, id) };
  });

  app.put('/api/v1/valuations/:id/asc718/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadValuation(id), 'accepting changes');
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid ASC 718 settings', parsed.error);
    const b = parsed.data;
    const settings = await upsertAsc718Settings(
      deps.pool,
      id,
      {
        companyType: b.company_type,
        ticker: b.ticker ?? null,
        expectedTermMethod: b.expected_term_method,
        esppDiscountPct: b.espp_discount_pct ?? null,
        esppLookbackMonths: b.espp_lookback_months ?? null,
        rsuPerformanceConditions: b.rsu_performance_conditions ?? null,
        tsrPeerBasket: b.tsr_peer_basket ?? null,
        updatedBy: principal.id,
      },
      // On the engagement's spine, in the transaction that moves the row —
      // `asc718_settings_updated` names the fields that moved and what they
      // had been. See `upsertAsc718Settings` for why this write had no trace.
      { actorType: 'human', actorId: principal.id, source: 'api' },
    );
    return { settings };
  });

  app.post('/api/v1/valuations/:id/asc718', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);
    refuseIfRetired(valuation, 'accepting changes');

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid ASC 718 request', parsed.error);
    const b = parsed.data;

    if (b.grants.length === 0 && !b.espp?.length && !b.rsu?.length && !b.tsr?.length) {
      throw problems.unprocessable('Provide at least one grant, ESPP, RSU or TSR award');
    }

    // The concluded 409A FMV is the private default underlying; the settings
    // row supplies the expected-term election for grants that omit their own.
    const [calculation, settings] = await Promise.all([
      latestSucceededCalculation(deps.pool, id),
      findAsc718Settings(deps.pool, id),
    ]);
    /*
     * Same column, same trap as `routes/boardApproval.ts`: every engine writes
     * its headline into `calculations.fmv_per_share`, so "the concluded 409A
     * FMV" above is only what that column holds on a 409A run. An EMI or CSOP
     * run leaves the **AMV** there — restricted, below the unrestricted market
     * value by the restriction discount — and an ASC 718 charge computed on a
     * discounted underlying is understated by roughly that same discount, in a
     * figure that lands in the financial statements.
     *
     * Treated as no figure at all, which is a path this route already has and
     * already refuses on. The refusal is the point: the analyst supplies
     * `default_grant_date_fair_value` deliberately rather than inheriting a
     * number that was never this one.
     */
    const runKind = specialtyRunKind(calculation?.results ?? null);
    const fmvIsThisFigure = runKind === null || concludes409AFmvPerShare(runKind);
    const fmv =
      fmvIsThisFigure && calculation?.fmv_per_share != null ? Number(calculation.fmv_per_share) : null;
    // "Run a calculation first" is a false instruction when one ran and
    // succeeded — it concluded something this note cannot price options off.
    const noUnderlyingDetail =
      runKind !== null && !fmvIsThisFigure
        ? `A ${kindLabel(runKind)} does not conclude a §409A fair market value per share` +
          `${headlineLabels(runKind).perShare === null ? '' : ` — it concludes ${headlineLabels(runKind).perShare!.toLowerCase()}`}` +
          '. Supply default_grant_date_fair_value or a per-grant grant_date_fair_value.'
        : 'No grant-date fair value: run a calculation first or supply grant_date_fair_value';

    // Public: resolve the issuer's own market price + historical volatility.
    let market: MarketResolution | null = null;
    if (b.company_type === 'public' && b.ticker) {
      const end = b.valuation_date ?? todayLocal();
      market = await resolveMarket(
        deps.engineUrl,
        b.ticker.toUpperCase(),
        end,
        b.market_lookback_days ?? 504,
        (err) =>
          req.log.warn(
            { err, valuationId: id, ticker: b.ticker?.toUpperCase() ?? null },
            'ASC 718 market feed unavailable — measuring on the supplied defaults',
          ),
      );
    }

    const defaultUnderlying =
      b.default_grant_date_fair_value ??
      (b.company_type === 'public'
        ? (market?.underlying ?? undefined)
        : fmv != null && fmv > 0
          ? fmv
          : undefined);
    const defaultVolatility =
      b.default_volatility ?? (b.company_type === 'public' ? (market?.volatility ?? undefined) : undefined);

    // ── Options ───────────────────────────────────────────────────────────
    const grants: Asc718Grant[] = [];
    for (const g of b.grants) {
      const underlying = g.grant_date_fair_value ?? defaultUnderlying;
      if (underlying === undefined) {
        throw problems.unprocessable(
          b.company_type === 'public'
            ? 'No underlying: supply a ticker with live prices, default_grant_date_fair_value, or a per-grant grant_date_fair_value'
            : noUnderlyingDetail,
        );
      }
      const volatility = g.volatility ?? defaultVolatility;
      if (volatility === undefined) {
        throw problems.unprocessable(
          `Grant "${g.label ?? 'unnamed'}" has no volatility (supply per-grant volatility or default_volatility)`,
        );
      }
      const expectedTermYears = resolveExpectedTerm(
        g,
        settings?.expected_term_method,
        underlying,
        volatility,
      );
      grants.push({
        label: g.label,
        optionsGranted: g.options_granted,
        grantDate: g.grant_date,
        vestingMonths: g.vesting_months,
        forfeitureRate: g.forfeiture_rate,
        amortizationFrequencyMonths: g.amortization_frequency_months,
        assumptions: {
          companyType: b.company_type,
          grantDateFairValue: underlying,
          exercisePrice: g.exercise_price,
          expectedTermYears,
          volatility,
          riskFreeRate: g.risk_free_rate,
          dividendYield: g.dividend_yield,
        },
      });
    }
    const options = grants.length > 0 ? asc718Portfolio(grants) : null;

    // ── ESPP ──────────────────────────────────────────────────────────────
    const espp = (b.espp ?? []).map((e) => {
      const volatility = e.volatility ?? defaultVolatility;
      if (volatility === undefined) {
        throw problems.unprocessable(
          `ESPP "${e.label ?? 'unnamed'}" has no volatility (supply volatility or default_volatility)`,
        );
      }
      const fv = esppFairValue({
        grantDatePrice: e.grant_date_price,
        discountPct: e.discount_pct,
        lookbackMonths: e.lookback_months,
        volatility,
        riskFreeRate: e.risk_free_rate,
        dividendYield: e.dividend_yield,
      });
      return {
        label: e.label ?? null,
        shares_enrolled: e.shares_enrolled,
        fair_value_per_share: fv.fairValuePerShare,
        total_fair_value: Math.round(fv.fairValuePerShare * e.shares_enrolled * 100) / 100,
        components: fv.components,
      };
    });

    // ── Monte-Carlo budget for this request ───────────────────────────────
    //
    // The three estimators below are synchronous loops, so their cost lands on
    // the event loop of the whole process. Each award's own path count is
    // sensible; twenty of them at once is not, and no per-award cap can see the
    // others. Price the whole request first, then scale every award by the same
    // factor so the batch fits — see monteCarloScale.
    const mcAwards = {
      performanceRsu: (b.rsu ?? []).filter((r) => r.condition === 'performance').length,
      marketRsu: (b.rsu ?? []).filter((r) => r.condition === 'market').length,
      // A TSR path draws the common factor, the subject's idiosyncratic shock,
      // and one per peer.
      tsrDraws: (b.tsr ?? []).reduce((n, t) => n + DEFAULT_MC_PATHS.relativeTsr * (t.peers.length + 2), 0),
    };
    const requestedDraws =
      mcAwards.performanceRsu * DEFAULT_MC_PATHS.performanceRsu +
      mcAwards.marketRsu * DEFAULT_MC_PATHS.marketConditionRsu +
      mcAwards.tsrDraws;
    const mcScale = monteCarloScale(requestedDraws);
    const mcPaths = {
      performanceRsu: scaleMonteCarloPaths(DEFAULT_MC_PATHS.performanceRsu, mcScale),
      marketConditionRsu: scaleMonteCarloPaths(DEFAULT_MC_PATHS.marketConditionRsu, mcScale),
      relativeTsr: scaleMonteCarloPaths(DEFAULT_MC_PATHS.relativeTsr, mcScale),
    };

    // ── RSUs ──────────────────────────────────────────────────────────────
    const rsu = (b.rsu ?? []).map((rItem, idx) => {
      const price = rItem.market_price ?? defaultUnderlying;
      if (price === undefined)
        throw problems.unprocessable(`RSU "${rItem.label ?? 'unnamed'}" has no market price`);
      if (rItem.condition === 'performance') {
        const res = performanceRsuMonteCarlo({
          marketPrice: price,
          targetUnits: rItem.units,
          expectedAttainment: rItem.expected_attainment ?? 1,
          attainmentVolatility: rItem.attainment_volatility ?? 0.25,
          maxPayoutRatio: rItem.max_payout_ratio,
          paths: mcPaths.performanceRsu,
          seed: 0x51ed270b + idx,
        });
        return { label: rItem.label ?? null, condition: 'performance' as const, units: rItem.units, ...res };
      }
      if (rItem.condition === 'market') {
        const volatility = rItem.volatility ?? defaultVolatility;
        if (
          volatility === undefined ||
          rItem.hurdle_price === undefined ||
          rItem.vesting_years === undefined
        ) {
          throw problems.unprocessable(
            `Market-condition RSU "${rItem.label ?? 'unnamed'}" needs hurdle_price, vesting_years and volatility`,
          );
        }
        const res = marketConditionRsuMonteCarlo({
          underlying: price,
          hurdlePrice: rItem.hurdle_price,
          vestingYears: rItem.vesting_years,
          volatility,
          riskFreeRate: rItem.risk_free_rate ?? 0.03,
          dividendYield: rItem.dividend_yield,
          paths: mcPaths.marketConditionRsu,
          seed: 0x2f8b1c33 + idx,
        });
        return {
          label: rItem.label ?? null,
          condition: 'market' as const,
          units: rItem.units,
          fairValuePerUnit: res.fairValuePerUnit,
          probabilityMet: res.probabilityMet,
          totalFairValue: Math.round(res.fairValuePerUnit * rItem.units * 100) / 100,
        };
      }
      const fv = rsuMarketFairValue(price, {
        vestingYears: rItem.vesting_years,
        dividendYield: rItem.dividend_yield,
        dividendProtected: rItem.dividend_protected,
      });
      return {
        label: rItem.label ?? null,
        condition: 'service' as const,
        units: rItem.units,
        fairValuePerUnit: fv,
        totalFairValue: Math.round(fv * rItem.units * 100) / 100,
      };
    });

    // ── Relative TSR ──────────────────────────────────────────────────────
    const tsr = (b.tsr ?? []).map((tItem, idx) => {
      const underlying = tItem.underlying ?? defaultUnderlying;
      const volatility = tItem.volatility ?? defaultVolatility;
      if (underlying === undefined || volatility === undefined) {
        throw problems.unprocessable(`TSR "${tItem.label ?? 'unnamed'}" needs an underlying and volatility`);
      }
      const res = relativeTsrMonteCarlo({
        subject: { underlying, volatility, dividendYield: tItem.dividend_yield },
        peers: tItem.peers.map((p) => ({
          name: p.name,
          volatility: p.volatility,
          correlation: p.correlation,
          dividendYield: p.dividend_yield,
        })),
        performancePeriodYears: tItem.performance_period_years,
        riskFreeRate: tItem.risk_free_rate,
        payoutSchedule: tItem.payout_schedule.map((t) => ({
          percentile: t.percentile,
          payoutRatio: t.payout_ratio,
        })),
        paths: mcPaths.relativeTsr,
        seed: 0x6d2b79f5 + idx,
      });
      return {
        label: tItem.label ?? null,
        target_units: tItem.target_units,
        fairValuePerUnit: res.fairValuePerUnit,
        expectedPayoutRatio: res.expectedPayoutRatio,
        expectedPercentile: res.expectedPercentile,
        totalFairValue: Math.round(res.fairValuePerUnit * tItem.target_units * 100) / 100,
      };
    });

    return {
      asc718: {
        company_type: b.company_type,
        ticker: b.ticker ?? null,
        market,
        options,
        espp,
        rsu,
        tsr,
        // What the Monte-Carlo figures above actually rest on. Reported rather
        // than silently applied: a scaled-down batch is a wider confidence
        // interval, and a reviewer signing the ASC 718 note should be able to
        // see that without re-deriving it.
        monte_carlo: {
          requested_draws: requestedDraws,
          draw_budget: MC_DRAW_BUDGET,
          scale: Math.round(mcScale * 1e4) / 1e4,
          paths: mcPaths,
        },
        valuation_fmv_per_share: fmv,
        currency: valuation.currency,
      },
    };
  });
}
