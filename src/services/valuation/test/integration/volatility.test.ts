import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Selected volatility — deriving sigma from the peer set.
 *
 * Three behaviours carry the claim this feature makes and are why this file
 * exists:
 *
 *   * estimating never moves the engagement's sigma — adopting does, and it
 *     goes through the ordinary override path so it lands in the audit trail;
 *   * a ticker the price feed cannot serve is reported as considered and not
 *     measured, and the estimate is struck on the rest rather than failing;
 *   * a fallback payload is not an observed price series, and measuring a
 *     volatility off one would put a figure under a peer's name that the peer
 *     never had.
 */

/** Daily closes with enough movement to measure. */
function bars(n: number, seed: number) {
  const out: Array<Record<string, number | string>> = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    // Deterministic, and alternating so the log returns are non-zero.
    price *= 1 + (i % 2 === 0 ? seed : -seed * 0.9);
    out.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: price,
      high: price * 1.02,
      low: price * 0.98,
      close: price,
    });
  }
  return out;
}

/** Stands in for the engine: a price feed and the estimator over it. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  // Per ticker. A ticker with no entry gets the documented fallback payload,
  // which is what an install with no network sees.
  let feed: Record<string, unknown> = {};
  let lastEstimate: Record<string, unknown> = {};
  const feedCalls: string[] = [];

  stub.post('/engine/v1/market-feed', async (req) => {
    const body = req.body as { ticker?: unknown };
    const ticker = String(body?.ticker ?? '');
    feedCalls.push(ticker);
    return (
      feed[ticker] ?? {
        source: 'fallback',
        warning: 'yfinance is not installed; returning the caller fallback',
      }
    );
  });

  // Mirrors engine/volatility.py closely enough for the route's contract: a
  // per-company breakdown, a median recommendation, and a manual override that
  // short-circuits the estimation.
  stub.post('/engine/v1/volatility', async (req) => {
    const body = req.body as {
      comparables?: Array<{ ticker: string; prices: number[] }>;
      manual_override?: number;
      method?: string;
    };
    lastEstimate = body as Record<string, unknown>;
    const comps = body.comparables ?? [];
    if (typeof body.manual_override === 'number') {
      return {
        method: 'manual',
        recommended_volatility: body.manual_override,
        manual_override: body.manual_override,
        confidence: 'manual',
        companies: comps.map((c, i) => ({ ticker: c.ticker, volatility: 0.4 + i * 0.1, used: true })),
        excluded_companies: [],
      };
    }
    const companies = comps.map((c, i) => ({ ticker: c.ticker, volatility: 0.4 + i * 0.2, used: true }));
    const vols = companies.map((c) => c.volatility).sort((a, b) => a - b);
    const median = vols[Math.floor(vols.length / 2)] ?? 0;
    return {
      method: body.method ?? 'historical',
      recommended_volatility: median,
      median_volatility: median,
      mean_volatility: vols.reduce((a, b) => a + b, 0) / vols.length,
      min_volatility: vols[0],
      max_volatility: vols[vols.length - 1],
      coefficient_of_variation: 0.2,
      confidence: vols.length >= 5 ? 'high' : 'medium',
      company_count: vols.length,
      companies,
      excluded_companies: [],
    };
  });

  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setFeed: (next: Record<string, unknown>) => {
      feed = next;
      feedCalls.length = 0;
    },
    lastEstimate: () => lastEstimate,
    feedCalls: () => [...feedCalls],
  };
}

describe.skipIf(!dbUp)('selected volatility', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const get = (token = ops.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/volatility`,
      headers: authHeader(token),
    });

  const estimate = (payload: Record<string, unknown> = {}, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/estimate`,
      headers: authHeader(token),
      payload,
    });

  const adopt = (id: string, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/${id}/apply`,
      headers: authHeader(token),
      payload: {},
    });

  const addPeer = (ticker: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      payload: { ticker, name: `${ticker} Corp` },
    });

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'SigmaCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  it('is invisible to someone who cannot read the engagement', async () => {
    expect((await get(stranger.token)).statusCode).toBe(404);
  });

  it('lets the engagement owner read the derivation but not run one', async () => {
    expect((await get(client.token)).statusCode).toBe(200);
    expect((await estimate({}, client.token)).statusCode).toBe(403);
  });

  it('starts with nothing derived and no ticker to measure', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().estimates).toEqual([]);
    expect(res.json().eligible_tickers).toEqual([]);
    expect(res.json().applied_volatility).toBeNull();
  });

  it('refuses to estimate from a peer set with no tickers in it', async () => {
    const res = await estimate();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('carries a ticker to measure');
  });

  it('reports a ticker the feed cannot serve rather than failing the run', async () => {
    await addPeer('AAA');
    await addPeer('BBB');
    await addPeer('CCC');
    // Only two of the three have observed history. The estimate is struck on
    // those, and CCC is named — the exhibit's "considered and not measured".
    engine.setFeed({
      AAA: { source: 'yfinance', ticker: 'AAA', prices: bars(60, 0.02) },
      BBB: { source: 'yfinance', ticker: 'BBB', prices: bars(60, 0.03) },
    });

    const res = await estimate();
    expect(res.statusCode).toBe(201);
    const est = res.json().estimate;
    expect(est.measured_count).toBe(2);
    expect(est.excluded.map((e: { ticker: string }) => e.ticker)).toEqual(['CCC']);
    // The fallback payload is not an observed series, and the reason says so.
    expect(est.excluded[0].reason).toContain('fallback');
  });

  it('does not touch the engagement’s volatility when it estimates', async () => {
    // The whole reason estimating and adopting are separate calls: pressing
    // "Estimate" must not move the concluded value of a valuation under review.
    const res = await get();
    expect(res.json().applied_volatility).toBeNull();
    expect(res.json().estimates[0].applied_at).toBeNull();
  });

  it('carries the observation count off the series that were sent', async () => {
    const est = (await get()).json().estimates[0];
    expect(est.companies.find((c: { ticker: string }) => c.ticker === 'AAA').observations).toBe(60);
  });

  it('anchors the window on the valuation date', async () => {
    const est = (await get()).json().estimates[0];
    // A year-long default window, and the two dates a year apart.
    const start = new Date(est.window_start).getTime();
    const end = new Date(est.window_end).getTime();
    expect(Math.round((end - start) / 86_400_000)).toBe(365);
  });

  it('adopting writes the derived figure through the override path', async () => {
    const before = (await get()).json().estimates[0];
    const res = await adopt(before.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().recalculation_required).toBe(true);
    expect(res.json().applied_volatility).toBeCloseTo(before.recommended, 6);

    const after = await get();
    expect(after.json().applied_volatility).toBeCloseTo(before.recommended, 6);
    expect(after.json().estimates[0].applied_at).not.toBeNull();

    // The override is a first-class one, so the Overwrites tab shows it with
    // the reason naming the run — that is what makes the change followable.
    const overwrites = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/overwrites`,
      headers: authHeader(ops.token),
    });
    const row = overwrites.json().overwrites.find((o: { field_key: string }) => o.field_key === 'volatility');
    expect(row).toBeTruthy();
    expect(row.reason).toContain('guideline companies');
  });

  it('adopting twice keeps the first adoption’s timestamp', async () => {
    const est = (await get()).json().estimates[0];
    const first = est.applied_at;
    await adopt(est.id);
    expect((await get()).json().estimates[0].applied_at).toBe(first);
  });

  it('records an analyst’s own selection against the same peer measurements', async () => {
    const res = await estimate({ manual_override: 0.55 });
    expect(res.statusCode).toBe(201);
    const est = res.json().estimate;
    expect(est.method).toBe('manual');
    expect(est.recommended).toBeCloseTo(0.55, 6);
    expect(est.confidence).toBe('manual');
    // The judgement is recorded beside the measurements rather than as an
    // unexplained number in a params field.
    expect(est.companies.length).toBeGreaterThan(0);
  });

  it('rejects a pinned figure outside the band the override accepts', async () => {
    expect((await estimate({ manual_override: 0 })).statusCode).toBe(422);
    expect((await estimate({ manual_override: 9 })).statusCode).toBe(422);
  });

  it('rejects a window too short to measure anything', async () => {
    expect((await estimate({ window_days: 5 })).statusCode).toBe(422);
  });

  it('sends the requested estimator through to the engine', async () => {
    await estimate({ method: 'ewma' });
    expect(engine.lastEstimate().method).toBe('ewma');
  });

  it('keeps every run, newest first', async () => {
    const estimates = (await get()).json().estimates;
    expect(estimates.length).toBeGreaterThanOrEqual(3);
    const times = estimates.map((e: { created_at: string }) => new Date(e.created_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('404s on an estimate that belongs to nothing', async () => {
    expect((await adopt('01J000000000000000000000ZZ')).statusCode).toBe(404);
  });
});
