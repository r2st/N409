import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the volatility panel does when the engine, the feed, or the stored data
 * is not what the happy path assumes.
 *
 * `volatility.test.ts` and `volatilityAdopt.test.ts` cover measuring, adopting
 * and the per-ticker exclusion reasons against an engine that always answers.
 * The arms left over are the ones that only fire when something upstream is
 * broken, and they are the ones a reader of the panel most needs to be right:
 * an outage must read as an outage rather than as a peer set with no history in
 * it, because the two suggest opposite next actions — wait, versus go and widen
 * the screen.
 *
 * The other half is disclosure. The valuation date anchors the window and the
 * exit horizon is carried onto the run so a reviewer can see whether a one-year
 * measurement is supporting a five-year option; neither had a test, and both
 * are silent when wrong — the estimate still succeeds and still prints, against
 * the wrong window or with no horizon beside it.
 */

interface StubState {
  /** Per-ticker market-feed answers; anything absent gets the fallback. */
  feed: Record<string, Record<string, unknown>>;
  /** When set, market-feed answers with this status instead of a payload. */
  feedStatus: number | null;
  /** When set, the estimator answers with this status instead of a payload. */
  estimateStatus: number | null;
  /** Overrides the estimator's answer. */
  estimate: Record<string, unknown> | null;
  /** Every body the estimator was called with, newest last. */
  estimateCalls: Array<Record<string, unknown>>;
}

async function startEngineStub(state: StubState) {
  const stub = Fastify({ logger: false });

  stub.post('/engine/v1/market-feed', async (req, reply) => {
    if (state.feedStatus !== null) {
      return reply.status(state.feedStatus).send({ detail: 'the price feed is down' });
    }
    const ticker = String((req.body as { ticker?: unknown })?.ticker ?? '');
    return state.feed[ticker] ?? { source: 'fallback', warning: 'no live source configured' };
  });

  stub.post('/engine/v1/volatility', async (req, reply) => {
    state.estimateCalls.push(req.body as Record<string, unknown>);
    if (state.estimateStatus !== null) {
      return reply.status(state.estimateStatus).send({ detail: 'the estimator is down' });
    }
    if (state.estimate) return state.estimate;
    const body = req.body as {
      comparables?: Array<{ ticker: string }>;
      method?: string;
      manual_override?: number;
    };
    const companies = (body.comparables ?? []).map((c, i) => ({
      ticker: c.ticker,
      volatility: 0.4 + i * 0.2,
      used: true,
    }));
    // Mirrors engine/volatility.py: a pinned figure short-circuits the
    // estimation and comes back as the recommendation.
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
      mean_volatility: vols.reduce((a, b) => a + b, 0) / (vols.length || 1),
      min_volatility: vols[0],
      max_volatility: vols[vols.length - 1],
      coefficient_of_variation: 0.2,
      confidence: 'medium',
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

describe.skipIf(!dbUp)('volatility when something upstream is broken', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state: StubState = {
    feed: {},
    feedStatus: null,
    estimateStatus: null,
    estimate: null,
    estimateCalls: [],
  };

  /** Closing prices with enough movement to measure. */
  const bars = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      close: 100 + (i % 7) * 3 + i * 0.5,
      high: 110 + i * 0.5,
      low: 90 + i * 0.5,
    }));

  const estimate = (payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/estimate`,
      headers: authHeader(ops.token),
      ...(payload === undefined ? {} : { payload }),
    });

  const view = () =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/volatility`,
      headers: authHeader(ops.token),
    });

  beforeAll(async () => {
    engine = await startEngineStub(state);
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'SigmaCo' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;

    for (const ticker of ['AAA', 'BBB']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comparables`,
        headers: authHeader(ops.token),
        payload: { ticker, name: `${ticker} Corp` },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    state.feed = {
      AAA: { source: 'yfinance', ticker: 'AAA', prices: bars(60) },
      BBB: { source: 'yfinance', ticker: 'BBB', prices: bars(60) },
    };
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  // Turned away in `preValidation` (plugins/params.ts) before the handler, and
  // guarded again inside it. Asserted here because the panel is what a client
  // may hold a stale link to, and 404 — not 422 — is the answer that keeps a
  // malformed id indistinguishable from one that is not theirs.
  describe('an id that is not an id', () => {
    it('404s the panel rather than asking the database about it', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/valuations/not-a-ulid/volatility',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s an adopt for an estimate id that is not one', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/volatility/not-an-estimate/apply`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('the defaults', () => {
    it('runs with no body at all, on the historical estimator and a year window', async () => {
      // The panel's own button sends nothing. Requiring a body would make the
      // documented defaults on `EstimateBody` unreachable from the UI.
      const res = await estimate();
      expect(res.statusCode, res.body).toBe(201);
      const est = res.json().estimate;
      expect(est.method).toBe('historical');
      const days = Math.round(
        (new Date(est.window_end).getTime() - new Date(est.window_start).getTime()) / 86_400_000,
      );
      expect(days).toBe(365);
    });
  });

  describe('disclosure carried onto the run', () => {
    it('anchors the window on the valuation date rather than on today', async () => {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/engine-inputs`,
        headers: authHeader(ops.token),
        payload: { valuation_date: '2025-06-30' },
      });
      expect(patched.statusCode, patched.body).toBe(200);

      const res = await estimate({});
      expect(res.statusCode, res.body).toBe(201);
      // A measurement taken through today would be measuring after the date the
      // opinion is as of — the one window a 409A may not use.
      expect(res.json().estimate.window_end).toBe('2025-06-30');
      expect(res.json().estimate.window_start).toBe('2024-06-30');
    });

    it('carries the exit horizon to the estimator and onto the stored run', async () => {
      // Through the engine-inputs document, which is where the horizon lives
      // and where the calculation reads it. It was read off the `overwrites`
      // table until R302, so a horizon set the ordinary way — this PATCH, the
      // financial-model form's own field — reached neither the estimator nor
      // the stored run, and Exhibit F-1 printed a measurement window with no
      // expected term beside it.
      const put = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/engine-inputs`,
        headers: authHeader(ops.token),
        payload: { time_to_exit_years: 4.5 },
      });
      expect(put.statusCode, put.body).toBe(200);

      const res = await estimate({});
      expect(res.statusCode).toBe(201);
      // Disclosure, not arithmetic: the estimator does not use it, and the
      // point of printing it is that a reviewer can see a one-year measurement
      // sitting under a four-and-a-half-year option.
      expect(state.estimateCalls.at(-1)?.time_to_exit_years).toBe(4.5);
      expect(res.json().estimate.time_to_exit_years).toBe(4.5);
    });
  });

  describe('a peer the feed cannot serve', () => {
    it('names the outage as the reason rather than reporting thin history', async () => {
      state.feedStatus = 503;
      try {
        const res = await estimate({ manual_override: 0.6 });
        expect(res.statusCode, res.body).toBe(201);
        const excluded = res.json().estimate.excluded as Array<{ ticker: string; reason: string }>;
        // Both peers considered, neither measured, and the reason distinguishes
        // "we could not ask" from "we asked and there was nothing there".
        expect(excluded.map((e) => e.ticker).sort()).toEqual(['AAA', 'BBB']);
        expect(excluded[0]?.reason).toContain('price feed could not be reached');
      } finally {
        state.feedStatus = null;
      }
    });

    it('refuses the whole run when the feed is down and nothing was pinned', async () => {
      state.feedStatus = 503;
      try {
        const res = await estimate({});
        expect(res.statusCode).toBe(422);
        // The refusal carries the per-ticker reasons, so the panel can say what
        // happened instead of "no usable history" over a healthy peer set.
        expect(res.json().excluded).toHaveLength(2);
      } finally {
        state.feedStatus = null;
      }
    });

    it('falls back to a generic reason when the source gives none', async () => {
      state.feed = { ...state.feed, CCC: { source: 'cache', ticker: 'CCC' } };
      const added = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comparables`,
        headers: authHeader(ops.token),
        payload: { ticker: 'CCC', name: 'CCC Corp' },
      });
      expect(added.statusCode, added.body).toBe(201);

      const res = await estimate({});
      expect(res.statusCode, res.body).toBe(201);
      const ccc = (res.json().estimate.excluded as Array<{ ticker: string; reason: string }>).find(
        (e) => e.ticker === 'CCC',
      );
      // A payload that is not observed history is excluded whether or not the
      // source bothered to explain itself — an unexplained one must not be
      // silently measured.
      expect(ccc?.reason).toBe('the live price source returned no observed history');
    });
  });

  describe('an estimator that will not answer', () => {
    it('reports the outage as an upstream failure, not as a bad request', async () => {
      state.estimateStatus = 503;
      try {
        const res = await estimate({});
        // Whatever the mapping, the one answer it must not give is 2xx: a run
        // that never happened must not be recorded as one.
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        expect((await view()).json().estimates.every((e: { id: string }) => Boolean(e.id))).toBe(true);
      } finally {
        state.estimateStatus = null;
      }
    });

    it('refuses to store a run whose recommendation is unusable', async () => {
      // The estimator can answer 200 with a degenerate result — every series
      // flat, so the median is zero. Storing that would put a 0% volatility
      // into the OPM and quietly collapse the allocation to common.
      state.estimate = {
        method: 'historical',
        recommended_volatility: 0,
        companies: [],
        excluded_companies: [],
      };
      try {
        const before = (await view()).json().estimates.length;
        const res = await estimate({});
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toContain('no usable volatility');
        expect((await view()).json().estimates).toHaveLength(before);
      } finally {
        state.estimate = null;
      }
    });
  });

  describe('a stored sigma that is not a number', () => {
    /**
     * Straight into `engine_inputs`, past the route that would have coerced it.
     *
     * The panel answers with the figure the *calculation* reads, which since
     * R302 is this document rather than the `overwrites` row beside it.
     * `engine_inputs` is jsonb and `PATCH /engine-inputs` is not the only
     * writer of it — the extraction auto-apply and the roll-forward and
     * projection adoptions all merge into the same column — so a value stored
     * as text is a shape the reader has to survive rather than one the schema
     * rules out.
     */
    const writeAppliedSigma = (value: string) =>
      ctx.pool.query(
        `UPDATE valuation_params
            SET engine_inputs = engine_inputs || jsonb_build_object('volatility', $2::jsonb)
          WHERE valuation_id = $1`,
        [valuationId, JSON.stringify(value)],
      );

    it('reads a figure stored as text as the number it says', async () => {
      // A document written by an import — or by hand — can hold "0.62", and the
      // panel comparing it against the recommendation must not read that as
      // "nothing applied" and offer to adopt a figure already in force.
      await writeAppliedSigma('0.62');
      expect((await view()).json().applied_volatility).toBeCloseTo(0.62, 6);
    });

    it('reports nothing applied rather than NaN for a figure that is not one', async () => {
      await writeAppliedSigma('about sixty percent');
      // NaN would serialise to null anyway — but by way of every comparison in
      // the panel answering false first, including the one that decides whether
      // a recalculation is due.
      expect((await view()).json().applied_volatility).toBeNull();
    });
  });
});
