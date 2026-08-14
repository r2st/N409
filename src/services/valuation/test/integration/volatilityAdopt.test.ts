import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Adopting a volatility estimate, and the arms of the estimator that fire when
 * a peer's price history is not what was hoped for.
 *
 * `volatility.test.ts` covers measuring and adopting on the happy path. What it
 * does not cover is the per-ticker exclusion reasons, the manual-override path
 * that runs with no usable series at all, or the adopt route's own refusals —
 * most of what left `routes/volatility.ts` at 72.5% branch coverage.
 *
 * The exclusion reasons are the ones with teeth. A peer dropped from a
 * measurement has to say *why* it was dropped: a fallback payload is the
 * engine's caller-supplied estimate, not an observed price series, and measuring
 * a volatility off it would produce a figure carrying a peer's name that the
 * peer never had.
 */
interface StubState {
  /** Per-ticker market-feed answers; anything absent gets the fallback. */
  feed: Record<string, Record<string, unknown>>;
  /** Overrides the volatility engine's answer. */
  estimate: Record<string, unknown> | null;
}

async function startEngineStub(state: StubState) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/market-feed', async (req) => {
    const ticker = String((req.body as { ticker?: unknown })?.ticker ?? '');
    return (
      state.feed[ticker] ?? {
        source: 'fallback',
        warning: 'yfinance is not installed; returning the caller fallback',
      }
    );
  });
  // Mirrors engine/volatility.py's response keys — `recommended_volatility`,
  // not `recommended`; the route's `shapeEstimate` refuses anything else.
  stub.post('/engine/v1/volatility', async (req) => {
    if (state.estimate) return state.estimate;
    const body = req.body as {
      comparables?: Array<{ ticker: string }>;
      manual_override?: number;
      method?: string;
    };
    const comps = body.comparables ?? [];
    const companies = comps.map((c, i) => ({ ticker: c.ticker, volatility: 0.4 + i * 0.2, used: true }));
    if (typeof body.manual_override === 'number') {
      return {
        method: 'manual',
        recommended_volatility: body.manual_override,
        manual_override: body.manual_override,
        confidence: 'manual',
        companies,
        excluded_companies: [],
      };
    }
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
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('volatility — adopting an estimate, and thin price history', () => {
  let ctx: TestApp;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  const state: StubState = { feed: {}, estimate: null };

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    engine = await startEngineStub(state);
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'SigmaCo' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  const estimate = (payload: Record<string, unknown> = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/estimate`,
      headers: authHeader(ops.token),
      payload,
    });

  const view = (token = ops.token) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/volatility`,
      headers: authHeader(token),
    });

  const apply = (estimateId: string, token = ops.token) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/${estimateId}/apply`,
      headers: authHeader(token),
      payload: {},
    });

  let seq = 0;
  async function addPeer(ticker: string): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      payload: { ticker, name: `Peer ${(seq += 1)}` },
    });
    expect(res.statusCode, res.body).toBe(201);
  }

  /** Closing prices the estimator can measure. */
  const bars = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
      close: 100 + i,
      high: 105 + i,
      low: 95 + i,
    }));

  // ── The panel ─────────────────────────────────────────────────────────────
  describe('the panel', () => {
    it('reports an empty set with no estimate and nothing eligible', async () => {
      const res = await view();
      expect(res.statusCode).toBe(200);
      expect(res.json().estimates).toEqual([]);
      expect(res.json().applied_volatility).toBeNull();
      expect(res.json().eligible_tickers).toEqual([]);
      expect(res.json().can_edit).toBe(true);
    });

    it('tells a reader they cannot run one', async () => {
      const res = await view(client.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().can_edit).toBe(false);
    });

    it('lists the tickers a run would measure, so the button can explain itself', async () => {
      // Cheaper than a 422 after the press.
      await addPeer('AAA');
      const res = await view();
      expect(res.json().eligible_tickers).toContain('AAA');
    });
  });

  // ── Why a peer was dropped ────────────────────────────────────────────────
  describe('the reason a peer was excluded', () => {
    it('refuses the run when no peer has usable history and none was pinned', async () => {
      // AAA is on the set from the panel test above and answers with the
      // fallback, so there is nothing to measure.
      const res = await estimate({});
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/usable price history/i);
      // The per-ticker reasons ride along — "no usable history" without saying
      // which peer, and why, is not actionable against an eleven-name set.
      expect(res.json().excluded).toBeTruthy();
    });

    it('names a fallback payload as such rather than measuring off it', async () => {
      // The engine's caller-supplied estimate is not an observed price series;
      // a volatility measured off it would carry a peer's name the peer never
      // had.
      state.feed = {};
      await addPeer('BBB');
      const res = await estimate({ manual_override: 0.55 });
      expect(res.statusCode).toBe(201);
      const excluded = res.json().estimate.excluded as Array<{ ticker: string; reason: string }>;
      expect(excluded.map((e) => e.ticker)).toContain('BBB');
      expect(excluded.find((e) => e.ticker === 'BBB')!.reason).toMatch(/yfinance|observed history/i);
    });

    it('names a series too short to measure, and says so differently per estimator', async () => {
      state.feed = { CCC: { source: 'yfinance', prices: [{ date: '2026-01-01', close: 100 }] } };
      await addPeer('CCC');

      const historical = await estimate({ manual_override: 0.5, method: 'historical' });
      expect(historical.statusCode, historical.body).toBe(201);
      const ctc = (historical.json().estimate.excluded as Array<{ ticker: string; reason: string }>).find(
        (e) => e.ticker === 'CCC',
      )!;
      expect(ctc.reason).toMatch(/closing prices/i);

      // Parkinson needs highs and lows, so its complaint is a different one.
      const parkinson = await estimate({ manual_override: 0.5, method: 'parkinson' });
      expect(parkinson.statusCode).toBe(201);
      const pk = (parkinson.json().estimate.excluded as Array<{ ticker: string; reason: string }>).find(
        (e) => e.ticker === 'CCC',
      )!;
      expect(pk.reason).toMatch(/high\/low/i);
    });

    it('measures a peer whose history is complete', async () => {
      state.feed = { DDD: { source: 'yfinance', prices: bars(60) } };
      await addPeer('DDD');
      const res = await estimate({});
      expect(res.statusCode).toBe(201);
      expect(res.json().estimate.recommended).toBeGreaterThan(0);
      expect(res.json().estimate.measured_count).toBeGreaterThan(0);
    });
  });

  // ── Adopting ──────────────────────────────────────────────────────────────
  describe('adopting an estimate', () => {
    async function freshEstimate(): Promise<string> {
      state.feed = { DDD: { source: 'yfinance', prices: bars(60) } };
      const res = await estimate({});
      expect(res.statusCode, res.body).toBe(201);
      return res.json().estimate.id as string;
    }

    it('404s an estimate id that is malformed or belongs to nothing', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        expect((await apply(id)).statusCode, id).toBe(404);
      }
    });

    it('writes the figure through the override trail and says a recalculation is due', async () => {
      // Through `upsertOverwrite` rather than into the params row, so the
      // change carries a before/after pair exactly as a hand-typed one would.
      const estimateId = await freshEstimate();
      const res = await apply(estimateId);
      expect(res.statusCode).toBe(200);
      expect(res.json().applied_volatility).toBeGreaterThan(0);
      expect(res.json().recalculation_required).toBe(true);

      const panel = await view();
      expect(Number(panel.json().applied_volatility)).toBe(res.json().applied_volatility);
    });

    it('reports no recalculation when the adopted figure is the one already there', async () => {
      // Adopting the same estimate twice moves nothing, and saying it did would
      // send somebody to re-run a calculation for no reason.
      const estimateId = await freshEstimate();
      expect((await apply(estimateId)).statusCode).toBe(200);
      const again = await apply(estimateId);
      expect(again.statusCode).toBe(200);
      expect(again.json().recalculation_required).toBe(false);
    });

    it('names the run in the override reason, differently for a measurement and a pin', async () => {
      // "sigma changed from 0.65 to 0.64" is only followable back to eleven
      // tickers and a window if the reason says so.
      const measured = await freshEstimate();
      expect((await apply(measured)).statusCode).toBe(200);
      const { rows: afterMeasured } = await ctx.pool.query<{ reason: string }>(
        `SELECT reason FROM overwrites WHERE valuation_id = $1 AND field_key = 'volatility'`,
        [valuationId],
      );
      expect(afterMeasured[0]!.reason).toMatch(/guideline companies/i);
      expect(afterMeasured[0]!.reason).toContain(measured);

      state.feed = {};
      const pinned = await estimate({ manual_override: 0.77 });
      expect(pinned.statusCode).toBe(201);
      expect((await apply(pinned.json().estimate.id as string)).statusCode).toBe(200);
      const { rows: afterPin } = await ctx.pool.query<{ reason: string }>(
        `SELECT reason FROM overwrites WHERE valuation_id = $1 AND field_key = 'volatility'`,
        [valuationId],
      );
      expect(afterPin[0]!.reason).toMatch(/analyst-selected/i);
    });

    it('is operations-only to run and to adopt', async () => {
      const estimateId = await freshEstimate();
      expect((await apply(estimateId, client.token)).statusCode).toBe(403);
      const run = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/volatility/estimate`,
        headers: authHeader(client.token),
        payload: {},
      });
      expect(run.statusCode).toBe(403);
    });
  });
});
