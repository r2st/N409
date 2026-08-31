import Fastify, { type FastifyInstance } from 'fastify';
import { newUlid } from '@n409/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The peer set when the request, or the engine, is not the shape the happy path
 * assumes.
 *
 * `comparables.test.ts` covers screening, refreshing and the provenance rules
 * against an engine that always answers with a well-formed universe. What it
 * leaves untested is every arm on the other side of that: a screen the engine
 * refuses, a screen whose answer is missing the keys the route reads, a
 * candidate with no name, a refresh the feed cannot serve.
 *
 * The pattern worth stating is that none of these may fail *silently*. A screen
 * that quietly wrote zero rows, or a refresh that skipped a ticker without
 * saying so, leaves an analyst reading a set that looks finished — and the
 * multiples struck from it go into a filed 409A. So each arm here is asserted
 * for what it *says*, not only for the status code.
 */

interface StubState {
  /** Overrides the screen's answer entirely. */
  screen: Record<string, unknown> | null;
  /** When set, the screen answers with this status instead of a payload. */
  screenStatus: number | null;
  /** Per-ticker market-feed answers; anything absent gets a bare fallback. */
  feed: Record<string, Record<string, unknown>>;
  /** When set, market-feed answers with this status instead of a payload. */
  feedStatus: number | null;
  /** The `inputs` object of the last screen call. */
  lastInputs: Record<string, unknown>;
  /** Every ticker the market feed was asked about, in order. */
  feedCalls: string[];
}

async function startEngineStub(state: StubState) {
  const stub = Fastify({ logger: false });

  stub.post('/engine/v1/comparables', async (req, reply) => {
    state.lastInputs = ((req.body as { inputs?: Record<string, unknown> })?.inputs ?? {}) as Record<
      string,
      unknown
    >;
    if (state.screenStatus !== null) {
      return reply.status(state.screenStatus).send({ detail: 'the screener is down' });
    }
    if (state.screen !== null) return state.screen;
    return {
      selected: [
        { ticker: 'AAA', name: 'Alpha Analytics', sic_code: '7372', market_cap: 1_000, revenue: 100 },
      ],
      screened_out: [{ ticker: 'ZZZ', name: 'Zeta Mining', score: 0.05, reason: 'different industry' }],
      universe_size: 40,
    };
  });

  stub.post('/engine/v1/market-feed', async (req, reply) => {
    if (state.feedStatus !== null) {
      return reply.status(state.feedStatus).send({ detail: 'the market feed is down' });
    }
    const ticker = String((req.body as { ticker?: unknown })?.ticker ?? '');
    state.feedCalls.push(ticker);
    // No `warning` on purpose: the engine is not obliged to explain itself, and
    // the route has to have something to say when it does not.
    return state.feed[ticker] ?? { source: 'fallback' };
  });

  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('the peer set on the unhappy paths', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state: StubState = {
    screen: null,
    screenStatus: null,
    feed: {},
    feedStatus: null,
    lastInputs: {},
    feedCalls: [],
  };

  const ABSENT_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  const list = () =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
    });

  const add = (payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      ...(payload === undefined ? {} : { payload }),
    });

  const screen = (payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables/screen`,
      headers: authHeader(ops.token),
      ...(payload === undefined ? {} : { payload }),
    });

  const refresh = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables/refresh`,
      headers: authHeader(ops.token),
      payload: {},
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
      payload: { kind: '409a', company_name: 'PeerCo' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;

    // A target attribute, so the screen has something to screen on.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/overwrites/industry_id`,
      headers: authHeader(ops.token),
      payload: { value: 7372 },
    });
    expect(put.statusCode, put.body).toBe(200);
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  describe('adding a peer by hand', () => {
    it('stores every figure the form offers, and derives the multiples from them', async () => {
      // The four quotients are the whole point of the row, and each one comes
      // from a different pair of columns — a create that dropped one of the
      // five figures would leave a multiple silently absent from the exhibit.
      const res = await add({
        ticker: 'HAND',
        name: 'Hand Entered Co',
        sic: '7372',
        revenue_ltm: 200,
        revenue_ntm: 260,
        ebitda_ltm: 50,
        ebitda_ntm: 70,
        ev: 1_000,
      });
      expect(res.statusCode, res.body).toBe(201);
      const c = res.json().comparable;
      expect(Number(c.revenue_ltm)).toBe(200);
      expect(Number(c.ev)).toBe(1_000);
      // Rounded to four places on the way out — the tolerance is that, not the
      // arithmetic.
      expect(c.multiples.ev_revenue_ltm).toBeCloseTo(5, 4);
      expect(c.multiples.ev_ebitda_ltm).toBeCloseTo(20, 4);
      expect(c.multiples.ev_revenue_ntm).toBeCloseTo(1_000 / 260, 4);
      expect(c.multiples.ev_ebitda_ntm).toBeCloseTo(1_000 / 70, 4);
    });

    it('refuses a body with no name in it', async () => {
      const res = await add({ ticker: 'NONAME' });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors?.length).toBeGreaterThan(0);
    });

    it('refuses a request with no body at all rather than inventing a peer', async () => {
      const res = await add();
      expect(res.statusCode).toBe(422);
    });

    it('leaves a peer alone for a patch that asks for nothing', async () => {
      // Every field on the patch body is optional, so an empty one is legal and
      // has to be a no-op rather than a set of nulls written over the row.
      const created = await add({ ticker: 'NOOP', name: 'No Op Co', revenue_ltm: 40, ev: 400 });
      expect(created.statusCode, created.body).toBe(201);
      const itemId = created.json().comparable.id as string;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/comparables/${itemId}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      const c = res.json().comparable;
      expect(c.name).toBe('No Op Co');
      expect(Number(c.revenue_ltm)).toBe(40);
      expect(Number(c.ev)).toBe(400);
      // And it stays an analyst row: no figure was edited, so the provenance
      // has no reason to move.
      expect(c.figures_source).toBe('analyst');
    });

    it('404s a patch of an item that is not in this set', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/comparables/${ABSENT_ULID}`,
        headers: authHeader(ops.token),
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s a delete of an item that is not in this set', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/comparables/${ABSENT_ULID}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('screening', () => {
    it('refuses a screen whose knobs are out of range', async () => {
      // `limit` caps what one press can write into the set, and `min_score` is
      // the threshold the screened-out reasons are stated against. A request
      // past either is refused rather than clamped, because a set silently
      // capped at twelve when thirty were asked for reads as the universe.
      expect((await screen({ limit: 500 })).statusCode).toBe(422);
      expect((await screen({ min_score: 4 })).statusCode).toBe(422);
      expect((await screen({ unknown_knob: true })).statusCode).toBe(422);
    });

    it('passes the knobs through to the engine when they are given', async () => {
      const res = await screen({ min_score: 0.4, limit: 5 });
      expect(res.statusCode, res.body).toBe(201);
      expect(state.lastInputs.min_score).toBe(0.4);
      expect(state.lastInputs.limit).toBe(5);
    });

    it('omits them entirely when they are not, leaving the engine its defaults', async () => {
      const res = await screen();
      expect(res.statusCode, res.body).toBe(201);
      expect('min_score' in state.lastInputs).toBe(false);
      expect('limit' in state.lastInputs).toBe(false);
    });

    it('reports a screener outage rather than writing an empty set', async () => {
      const before = (await list()).json().comparables.length;
      state.screenStatus = 503;
      try {
        const res = await screen({});
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        state.screenStatus = null;
      }
      // The failure mode this guards: a screen that answered 201 with nothing
      // in it would replace the machine half of the set with emptiness, and
      // the analyst's next look at the tab would show a set that had been
      // curated down to nothing.
      expect((await list()).json().comparables.length).toBe(before);
    });

    it('treats an answer missing both lists as a screen that selected nothing', async () => {
      // A well-formed engine always sends both keys. One that does not is an
      // older build or a proxy, and reading `undefined.map` would be a 500 on
      // a button an analyst pressed — the honest answer is an empty screen.
      state.screen = { universe_size: 40 };
      try {
        const res = await screen({});
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json().screened).toBe(0);
        // The analyst's own rows survive a screen that returned nothing.
        expect((res.json().comparables as Array<{ ticker: string }>).some((c) => c.ticker === 'HAND')).toBe(
          true,
        );
      } finally {
        state.screen = null;
      }
    });

    it('names a candidate the engine did not name', async () => {
      state.screen = {
        selected: [{ ticker: 'NMD', market_cap: 900, revenue: 90, figures_source: 'live' }],
        screened_out: [{ score: 0.02, reason: 'too small' }],
        universe_size: 12,
      };
      try {
        const res = await screen({});
        expect(res.statusCode, res.body).toBe(201);
        const rows = res.json().comparables as Array<{ ticker: string | null; name: string }>;
        // A row with no name is a row nobody can discuss in a review. Falling
        // back to the ticker keeps it identifiable; the placeholder is for the
        // screened-out row that has neither.
        expect(rows.find((r) => r.ticker === 'NMD')?.name).toBe('NMD');
        expect(rows.some((r) => r.name === 'Unnamed comparable')).toBe(true);
      } finally {
        state.screen = null;
      }
    });

    it('stamps a live row with the screen clock when the engine gives no date', async () => {
      // `figures_source: live` without `figures_as_of` is the engine claiming
      // an observation with no time on it. The row still needs a date — the
      // exhibit prints one — and the screen's own clock is the honest fallback.
      const before = Date.now();
      state.screen = {
        selected: [{ ticker: 'LIV', name: 'Live Co', market_cap: 500, revenue: 50, figures_source: 'live' }],
        screened_out: [],
        universe_size: 3,
      };
      try {
        expect((await screen({})).statusCode).toBe(201);
        const row = (
          (await list()).json().comparables as Array<{
            ticker: string;
            figures_source: string;
            figures_as_of: string;
          }>
        ).find((r) => r.ticker === 'LIV');
        expect(row?.figures_source).toBe('live');
        expect(new Date(row!.figures_as_of).getTime()).toBeGreaterThanOrEqual(before - 1_000);
      } finally {
        state.screen = null;
      }
    });
  });

  describe('refreshing from the feed', () => {
    it('reports the ticker the feed could not be reached for, and keeps the row', async () => {
      const seeded = await add({ ticker: 'FEED', name: 'Feed Co', revenue_ltm: 10, ev: 100 });
      expect(seeded.statusCode, seeded.body).toBe(201);
      // An analyst row is never refreshed, so move it onto the machine side the
      // way a screen would — the refresh only ever considers those.
      await ctx.pool.query(
        `UPDATE comparable_items SET figures_source = 'snapshot' WHERE valuation_id = $1 AND ticker = 'FEED'`,
        [valuationId],
      );

      state.feedStatus = 502;
      try {
        const res = await refresh();
        // One unreachable ticker is not a failed refresh: the loop is the unit
        // of work the analyst pressed the button for, and naming the ticker is
        // more use than a 502 that leaves them guessing which one.
        expect(res.statusCode, res.body).toBe(200);
        const unavailable = res.json().unavailable as Array<{ ticker: string; warning: string }>;
        expect(unavailable.some((u) => u.ticker === 'FEED')).toBe(true);
        expect(unavailable.find((u) => u.ticker === 'FEED')?.warning).toBeTruthy();
      } finally {
        state.feedStatus = null;
      }

      const row = ((await list()).json().comparables as Array<{ ticker: string; ev: string }>).find(
        (c) => c.ticker === 'FEED',
      );
      // Left exactly as it was: a half-updated row would pair an EV from today
      // with a revenue from the snapshot, and imply a multiple that never was.
      expect(Number(row?.ev)).toBe(100);
    });

    it('says something even when the fallback payload explains nothing', async () => {
      const res = await refresh();
      expect(res.statusCode, res.body).toBe(200);
      const unavailable = res.json().unavailable as Array<{ ticker: string; warning: string }>;
      expect(unavailable.find((u) => u.ticker === 'FEED')?.warning).toBe(
        'the live source returned no usable figures',
      );
    });
  });

  /**
   * The refresh loop is sequential and leaves the process once per ticker, so
   * the size of the set is the length of the request.
   *
   * `FEED_TIMEOUT_MS` bounds one fetch and its comment states the rule — "a
   * refresh of a dozen comps must not be able to hold a request open for
   * minutes" — but nothing bounded the loop. The only ceiling was
   * `COMPARABLE_PAGE_LIMIT`, which is 500: five hundred tickers at eight
   * seconds each is sixty-six minutes, and Node destroys the socket at five,
   * with every row already committed invisible to the analyst who pressed it.
   *
   * The batch has to be taken oldest-first, not off the display order
   * (`included DESC, score DESC, name ASC`), or a second press refetches the
   * same rows and the tail is unreachable for ever.
   */
  describe('a peer set larger than one request should fetch', () => {
    let bigId: string;
    const SET = 30;

    const refreshBig = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${bigId}/comparables/refresh`,
        headers: authHeader(ops.token),
        payload: {},
      });

    beforeAll(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'WideSet Inc' },
      });
      expect(created.statusCode, created.body).toBe(201);
      bigId = created.json().valuation.id as string;

      for (let i = 0; i < SET; i += 1) {
        const ticker = `T${String(i).padStart(3, '0')}`;
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${bigId}/comparables`,
          headers: authHeader(ops.token),
          payload: { ticker, name: `Wide ${ticker}`, revenue_ltm: 10, ev: 100 },
        });
        expect(res.statusCode, res.body).toBe(201);
        // Analyst-entered rows are never refreshed; a screened set is what the
        // loop actually walks, so put them on that side.
        state.feed[ticker] = { source: 'yfinance', market_cap: 1_000, total_revenue: 100 };
      }
      await ctx.pool.query(
        `UPDATE comparable_items SET figures_source = 'snapshot' WHERE valuation_id = $1`,
        [bigId],
      );
    }, 60_000);

    it('fetches a bounded batch and says how many it did not reach', async () => {
      state.feedCalls = [];
      const res = await refreshBig();
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as {
        refreshed: Array<{ ticker: string }>;
        remaining: number;
        refresh_batch: number;
      };
      expect(state.feedCalls).toHaveLength(body.refresh_batch);
      expect(body.refreshed).toHaveLength(body.refresh_batch);
      expect(body.remaining).toBe(SET - body.refresh_batch);
      expect(body.refresh_batch).toBeLessThan(SET);
    });

    it('reaches the tail on a second press rather than refetching only the head', async () => {
      const first = new Set(state.feedCalls);
      expect(first.size).toBeGreaterThan(0);
      // What the first press never got to. Ordering by staleness is what makes
      // this set shrink; the display order would leave it untouched for ever.
      const untouched = Array.from({ length: SET }, (_, i) => `T${String(i).padStart(3, '0')}`).filter(
        (t) => !first.has(t),
      );
      expect(untouched.length).toBeGreaterThan(0);

      state.feedCalls = [];
      const res = await refreshBig();
      expect(res.statusCode, res.body).toBe(200);
      // Never-fetched rows sort ahead of every row the first press stamped, so
      // the whole tail is inside this batch.
      expect(untouched.every((t) => state.feedCalls.includes(t))).toBe(true);
      // Still five, because `remaining` counts what *this press* did not reach
      // and the set is still thirty. It is a statement about the press, not a
      // staleness backlog — a set larger than the batch never reports zero.
      expect(res.json().remaining).toBe(SET - (res.json().refresh_batch as number));
    });
  });

  describe('reading it as someone else', () => {
    it('is invisible to a caller who cannot read the engagement', async () => {
      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comparables`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s an engagement that does not exist rather than saying so', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${newUlid()}/comparables`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
