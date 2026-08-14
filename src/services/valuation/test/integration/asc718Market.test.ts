import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { historicalVolatility } from '../../src/domain/asc718Public.js';

const dbUp = await isDbAvailable();

/**
 * How the ASC 718 route resolves a public issuer's own underlying price and
 * historical volatility from the engine's market feed.
 *
 * `asc718.test.ts` and `asc718Refusals.test.ts` between them never send a
 * `company_type: 'public'` request with a ticker on it, so `resolveMarket` —
 * the feed call, the window it asks for, the usable-price filter and all three
 * of its fallbacks — had no test at all. It is the one part of the module that
 * depends on something outside the process, which makes its failure arms the
 * ones most likely to fire in production and the least likely to have been
 * tried by hand.
 *
 * The distinction the whole file turns on: a feed that answers with nothing
 * usable must leave the assumption *absent*, so the per-award refusal names the
 * field, rather than *present and wrong*. A volatility nobody chose is worse
 * than no volatility, because only one of the two stops the filing.
 */

/** A deterministic close series; five closes is enough for a real sample stdev. */
const SERIES = [
  { date: '2026-01-02', close: 100 },
  { date: '2026-01-05', close: 101.5 },
  { date: '2026-01-06', close: 99.8 },
  { date: '2026-01-07', close: 102.3 },
  { date: '2026-01-08', close: 103.1 },
];

type FeedMode =
  'live' | 'fallback_source' | 'two_closes' | 'flat' | 'one_usable' | 'no_prices' | 'undated' | 'error';

describe.runIf(dbUp)('ASC 718 — public market feed', () => {
  let ctx: TestApp;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let feedMode: FeedMode = 'live';
  /** What the route actually asked the feed for, for the window assertions. */
  let lastFeedBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/market-feed', async (req, reply) => {
      lastFeedBody = req.body as Record<string, unknown>;
      switch (feedMode) {
        case 'error':
          return reply.status(503).send({ detail: 'yfinance unavailable' });
        case 'fallback_source':
          // The feed answering honestly that it made the numbers up.
          return { source: 'fallback', prices: SERIES };
        case 'two_closes':
          return { source: 'yfinance', prices: SERIES.slice(0, 2) };
        case 'flat':
          return { source: 'yfinance', prices: SERIES.map((p) => ({ ...p, close: 42 })) };
        case 'one_usable':
          // Junk the filter has to drop: a zero, a negative and a non-number.
          return {
            source: 'yfinance',
            prices: [
              { date: '2026-01-02', close: 0 },
              { date: '2026-01-05', close: -3 },
              { date: '2026-01-06', close: 'n/a' },
              { date: '2026-01-07', close: 88 },
            ],
          };
        case 'no_prices':
          return { source: 'yfinance' };
        case 'undated':
          return { source: 'yfinance', prices: SERIES.map(({ close }) => ({ close })) };
        default:
          return { source: 'yfinance', prices: SERIES };
      }
    });
    await engineStub.listen({ port: 0, host: '127.0.0.1' });
    const address = engineStub.server.address();
    const enginePort = typeof address === 'object' && address ? address.port : 0;

    ctx = await setupTestApp({ ENGINE_URL: `http://127.0.0.1:${enginePort}` });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engineStub?.close();
  });

  beforeEach(() => {
    feedMode = 'live';
    lastFeedBody = null;
  });

  const auth = () => authHeader(ops.token);

  async function seedValuation(company = 'PublicCo'): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: auth(),
      payload: { kind: '718', company_name: company },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  const price = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1/valuations/${id}/asc718`, headers: auth(), payload });

  /** A grant that supplies neither an underlying nor a volatility of its own. */
  const BARE_GRANT = {
    label: 'PSU-1',
    options_granted: 10_000,
    grant_date: '2026-01-08',
    vesting_months: 48,
    exercise_price: 100,
    risk_free_rate: 0.04,
  };

  const publicBody = (extra: Record<string, unknown> = {}) => ({
    company_type: 'public',
    ticker: 'ACME',
    valuation_date: '2026-01-08',
    grants: [BARE_GRANT],
    ...extra,
  });

  // ── The resolution that works ─────────────────────────────────────────────

  it('prices a grant off the issuer’s own last close and its own return history', async () => {
    const id = await seedValuation();
    const res = await price(id, publicBody());
    expect(res.statusCode).toBe(200);

    const { market, options } = res.json().asc718;
    expect(market).toMatchObject({ ticker: 'ACME', source: 'yfinance', as_of: '2026-01-08' });
    expect(market.underlying).toBe(103.1);
    // Derived here rather than hardcoded: the assertion is that the route uses
    // the same estimator on the same closes, not that 0.3-something is right.
    expect(market.volatility).toBe(
      historicalVolatility(
        SERIES.map((p) => p.close),
        252,
      ),
    );
    expect(market.warning).toBeUndefined();

    // …and that the resolved pair is what actually reached Black-Scholes.
    const assumptions = options.grants[0].assumptions;
    expect(assumptions.grantDateFairValue).toBe(103.1);
    expect(assumptions.volatility).toBe(market.volatility);
    expect(options.grants[0].fairValuePerOption).toBeGreaterThan(0);
  });

  it('asks the feed for a two-year window ending at the valuation date, ticker upcased', async () => {
    const id = await seedValuation();
    const res = await price(id, publicBody({ ticker: 'acme' }));
    expect(res.statusCode).toBe(200);

    // 504 calendar days back from 2026-01-08 — the default lookback.
    expect(lastFeedBody).toMatchObject({
      kind: 'prices',
      ticker: 'ACME',
      start: '2024-08-22',
      end: '2026-01-08',
    });
    // The echoed ticker is what the caller typed; only the feed sees it upcased.
    expect(res.json().asc718.ticker).toBe('acme');
    expect(res.json().asc718.market.ticker).toBe('ACME');
  });

  it('narrows the window when the caller names a lookback', async () => {
    const id = await seedValuation();
    const res = await price(id, publicBody({ market_lookback_days: 30 }));
    expect(res.statusCode).toBe(200);
    expect(lastFeedBody).toMatchObject({ start: '2025-12-09', end: '2026-01-08' });
  });

  it('ends the window today when the request carries no valuation date', async () => {
    const id = await seedValuation();
    const res = await price(id, {
      company_type: 'public',
      ticker: 'ACME',
      grants: [BARE_GRANT],
    });
    expect(res.statusCode).toBe(200);
    expect(lastFeedBody?.end).toBe(new Date().toISOString().slice(0, 10));
  });

  it('drops zero, negative and non-numeric closes before measuring', async () => {
    feedMode = 'one_usable';
    const id = await seedValuation();
    const res = await price(id, publicBody({ default_grant_date_fair_value: 90, default_volatility: 0.5 }));
    expect(res.statusCode).toBe(200);

    const { market } = res.json().asc718;
    // One usable close survives the filter, which is below the two the
    // resolution needs — so the feed's junk cannot become an underlying.
    expect(market.underlying).toBeNull();
    expect(market.source).toBe('fallback');
    expect(market.warning).toBe('no live prices for ticker');
  });

  it('falls back to the window end when the last price carries no date', async () => {
    feedMode = 'undated';
    const id = await seedValuation();
    const res = await price(id, publicBody());
    expect(res.statusCode).toBe(200);
    expect(res.json().asc718.market.as_of).toBe('2026-01-08');
  });

  // ── Not enough history to measure a volatility ────────────────────────────

  it('keeps the last close but withholds a volatility it cannot measure from two closes', async () => {
    feedMode = 'two_closes';
    const id = await seedValuation();
    const res = await price(id, publicBody());

    // Two closes is one return, and a sample stdev over one return is a
    // division by zero. Before the guard this answered 200 with a NaN
    // volatility and a null fairValuePerOption — a filing-grade number that
    // silently was not one.
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/Grant "PSU-1" has no volatility/);
  });

  it('withholds a volatility of zero from a flat series for the same reason', async () => {
    feedMode = 'flat';
    const id = await seedValuation();
    const res = await price(id, publicBody());
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/has no volatility/);
  });

  it('still reports the underlying it did resolve, so only the missing half is missing', async () => {
    feedMode = 'two_closes';
    const id = await seedValuation();
    // Supplying the volatility the feed could not derive is enough to price.
    const res = await price(id, publicBody({ default_volatility: 0.55 }));
    expect(res.statusCode).toBe(200);

    const { market, options } = res.json().asc718;
    expect(market.underlying).toBe(101.5);
    expect(market.volatility).toBeNull();
    expect(market.warning).toBe('not enough price history to derive a volatility');
    expect(options.grants[0].assumptions.grantDateFairValue).toBe(101.5);
    expect(options.grants[0].assumptions.volatility).toBe(0.55);
    expect(options.grants[0].fairValuePerOption).toBeGreaterThan(0);
  });

  // ── The three ways the feed gives us nothing ──────────────────────────────

  it('treats the feed’s own fallback source as no prices at all', async () => {
    feedMode = 'fallback_source';
    const id = await seedValuation();
    const res = await price(id, publicBody({ default_grant_date_fair_value: 90, default_volatility: 0.4 }));
    expect(res.statusCode).toBe(200);

    const { market, options } = res.json().asc718;
    expect(market).toMatchObject({
      ticker: 'ACME',
      underlying: null,
      volatility: null,
      source: 'fallback',
      as_of: null,
      warning: 'no live prices for ticker',
    });
    // Synthetic prices are never quietly promoted into the measurement.
    expect(options.grants[0].assumptions.grantDateFairValue).toBe(90);
  });

  it('treats a feed answering without a prices array as no prices at all', async () => {
    feedMode = 'no_prices';
    const id = await seedValuation();
    const res = await price(id, publicBody({ default_grant_date_fair_value: 90, default_volatility: 0.4 }));
    expect(res.statusCode).toBe(200);
    expect(res.json().asc718.market.warning).toBe('no live prices for ticker');
  });

  it('survives a feed that is down, and says which of the two it was', async () => {
    feedMode = 'error';
    const id = await seedValuation();
    const res = await price(id, publicBody({ default_grant_date_fair_value: 90, default_volatility: 0.4 }));
    // Best-effort: a market feed outage must not take the whole measurement
    // down when the caller supplied the assumptions anyway.
    expect(res.statusCode).toBe(200);
    expect(res.json().asc718.market).toMatchObject({
      underlying: null,
      volatility: null,
      source: 'fallback',
      warning: 'market feed unavailable',
    });
  });

  it('refuses rather than guesses when the feed is down and nothing was supplied', async () => {
    feedMode = 'error';
    const id = await seedValuation();
    const res = await price(id, publicBody());
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/supply a ticker with live prices/);
  });

  // ── The caller's own numbers outrank the feed ─────────────────────────────

  it('prefers the caller’s explicit defaults over a live quote', async () => {
    const id = await seedValuation();
    const res = await price(id, publicBody({ default_grant_date_fair_value: 250, default_volatility: 0.9 }));
    expect(res.statusCode).toBe(200);

    const { market, options } = res.json().asc718;
    // The resolution is still reported — a reviewer can see what was overridden.
    expect(market.underlying).toBe(103.1);
    expect(options.grants[0].assumptions.grantDateFairValue).toBe(250);
    expect(options.grants[0].assumptions.volatility).toBe(0.9);
  });

  it('lets a per-grant assumption outrank both the defaults and the feed', async () => {
    const id = await seedValuation();
    const res = await price(
      id,
      publicBody({
        default_grant_date_fair_value: 250,
        default_volatility: 0.9,
        grants: [{ ...BARE_GRANT, grant_date_fair_value: 111, volatility: 0.31 }],
      }),
    );
    expect(res.statusCode).toBe(200);
    const assumptions = res.json().asc718.options.grants[0].assumptions;
    expect(assumptions.grantDateFairValue).toBe(111);
    expect(assumptions.volatility).toBe(0.31);
  });

  it('does not call the feed at all for a private company carrying a ticker', async () => {
    const id = await seedValuation();
    const res = await price(id, {
      company_type: 'private',
      ticker: 'ACME',
      grants: [{ ...BARE_GRANT, grant_date_fair_value: 12, volatility: 0.6 }],
    });
    expect(res.statusCode).toBe(200);
    expect(lastFeedBody).toBeNull();
    expect(res.json().asc718.market).toBeNull();
  });

  // ── The saved expected-term election ──────────────────────────────────────
  //
  // `GrantBody.expected_term_method` documents itself as overriding "the
  // settings default", and until now there was no settings default to override:
  // the row was written by PUT and read back by GET, and the pricing route
  // never loaded it. The browser tab hid this by stamping its own copy of the
  // election onto every grant it submits, so the setting worked from the UI and
  // was inert for the partner API and every other client.

  const saveSettings = (id: string, body: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/asc718/settings`,
      headers: auth(),
      payload: body,
    });

  /** The three methods disagree, so the term alone identifies which one ran. */
  const LATTICE_GRANT = {
    ...BARE_GRANT,
    contractual_term_years: 10,
    exercise_multiple: 2,
    exercise_history: [
      { years: 3, options: 6_000 },
      { years: 7, options: 4_000 },
    ],
  };

  it('applies the saved election to a grant that names no method of its own', async () => {
    const id = await seedValuation();
    expect((await saveSettings(id, { company_type: 'public', ticker: 'ACME' })).statusCode).toBe(200);

    const simplified = await price(id, publicBody({ grants: [LATTICE_GRANT] }));
    expect(simplified.statusCode).toBe(200);
    const simplifiedTerm = simplified.json().asc718.options.grants[0].assumptions.expectedTermYears;

    // Same request, same grant — only the stored election changes.
    expect(
      (await saveSettings(id, { company_type: 'public', ticker: 'ACME', expected_term_method: 'historical' }))
        .statusCode,
    ).toBe(200);
    const historical = await price(id, publicBody({ grants: [LATTICE_GRANT] }));
    expect(historical.statusCode).toBe(200);
    // 3y × 6000 + 7y × 4000, over 10000 options.
    expect(historical.json().asc718.options.grants[0].assumptions.expectedTermYears).toBe(4.6);
    expect(simplifiedTerm).not.toBe(4.6);
  });

  it('still lets a grant override the saved election', async () => {
    const id = await seedValuation();
    await saveSettings(id, { company_type: 'public', ticker: 'ACME', expected_term_method: 'historical' });

    const res = await price(id, {
      ...publicBody({ grants: [{ ...LATTICE_GRANT, expected_term_method: 'lattice' }] }),
    });
    expect(res.statusCode).toBe(200);
    const term = res.json().asc718.options.grants[0].assumptions.expectedTermYears;
    // The lattice is solved against the resolved market inputs, so it lands
    // somewhere inside the contractual life rather than on the historical 4.6.
    expect(term).not.toBe(4.6);
    expect(term).toBeGreaterThan(0);
    expect(term).toBeLessThanOrEqual(10);
  });

  it('refuses when the saved election needs an input the grant does not carry', async () => {
    const id = await seedValuation();
    await saveSettings(id, { company_type: 'public', ticker: 'ACME', expected_term_method: 'historical' });

    // The refusal now reaches a caller who never mentioned a term method — so
    // it has to name the method as well as the grant to be actionable.
    const res = await price(id, publicBody());
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/uses the historical term method but has no exercise_history/);
  });

  it('falls back to simplified for an engagement with no settings row at all', async () => {
    const id = await seedValuation();
    const res = await price(id, publicBody({ grants: [LATTICE_GRANT] }));
    expect(res.statusCode).toBe(200);
    const term = res.json().asc718.options.grants[0].assumptions.expectedTermYears;
    // Simplified over a 4-year vest and a 10-year contractual life: (4 + 10) / 2.
    expect(term).toBe(7);
  });
});
