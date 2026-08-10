import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Network Items — the persisted peer set (design §4.5).
 *
 * Two behaviours carry the defensibility claim and are the reason this file
 * exists: a machine-screened comp can be excluded but never deleted, and an
 * exclusion cannot be recorded without a reason. Everything else here is the
 * plumbing that makes those two reachable.
 */

/** What the market-feed stub answers for one ticker, keyed by ticker. */
type FeedReply = Record<string, Record<string, unknown>>;

/** Stands in for `engine/v1/comparables`: two ranked comps and one screened out. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let lastInputs: Record<string, unknown> = {};
  // The live feed's answers, per ticker. Default is the documented fallback —
  // no live source — because that is what an install with no network gets, and
  // a test suite that only ever exercises the happy path would not have caught
  // a refresh that wrote fallback estimates as observed market data.
  let feed: FeedReply = {};
  const feedCalls: string[] = [];
  stub.post('/engine/v1/market-feed', async (req) => {
    const ticker = String((req.body as { ticker?: unknown })?.ticker ?? '');
    feedCalls.push(ticker);
    return (
      feed[ticker] ?? {
        source: 'fallback',
        warning: 'yfinance is not installed; returning the caller fallback',
      }
    );
  });
  // The screen's answer, overridable per test. The default is an all-snapshot
  // universe, which is what an engine with no live feed returns; a test that
  // wants observed figures says so, because "live" and "snapshot" are stamped
  // onto the stored rows differently and the difference reaches the exhibit.
  let screenReply: Record<string, unknown> | null = null;
  stub.post('/engine/v1/comparables', async (req) => {
    lastInputs = ((req.body as { inputs?: Record<string, unknown> })?.inputs ?? {}) as Record<
      string,
      unknown
    >;
    if (screenReply !== null) return screenReply;
    return {
      selected: [
        {
          ticker: 'AAA',
          name: 'Alpha Analytics',
          sic_code: '7372',
          market_cap: 1_000,
          revenue: 100,
          ebitda_margin: 0.5,
          score: 0.82,
          breakdown: { industry: 1, size: 0.7 },
        },
        {
          ticker: 'BBB',
          name: 'Beta Systems',
          sic_code: '7372',
          market_cap: 1_400,
          revenue: 100,
          ebitda_margin: 0.5,
          score: 0.61,
          breakdown: { industry: 1, size: 0.4 },
        },
      ],
      screened_out: [{ ticker: 'ZZZ', name: 'Zeta Mining', score: 0.05, reason: 'different industry' }],
      universe_size: 40,
      target: { sic_code: '7372' },
    };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    inputs: () => lastInputs,
    setFeed: (next: FeedReply) => {
      feed = next;
      feedCalls.length = 0;
    },
    setScreen: (next: Record<string, unknown> | null) => {
      screenReply = next;
    },
    feedCalls: () => [...feedCalls],
  };
}

describe.skipIf(!dbUp)('comparable items', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const list = (token = ops.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(token),
    });

  const add = (payload: Record<string, unknown>, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(token),
      payload,
    });

  const patch = (itemId: string, payload: Record<string, unknown>, token = ops.token) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/comparables/${itemId}`,
      headers: authHeader(token),
      payload,
    });

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'PeerCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  it('starts empty, with the multiple the params would strike named', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().comparables).toEqual([]);
    // Params default to a revenue method and an LTM horizon; the tab has to be
    // able to say which of the four multiples it is previewing.
    expect(res.json().primary_multiple).toBe('ev_revenue_ltm');
    expect(res.json().statistics.ev_revenue_ltm.count).toBe(0);
  });

  it('is invisible to someone who cannot read the engagement', async () => {
    const res = await list(stranger.token);
    expect(res.statusCode).toBe(404);
  });

  it('lets the engagement owner read the set but not edit it', async () => {
    expect((await list(client.token)).statusCode).toBe(200);
    expect((await list(client.token)).json().can_edit).toBe(false);
    const res = await add({ name: 'Client Pick', ev: 100, revenue_ltm: 10 }, client.token);
    expect(res.statusCode).toBe(403);
  });

  it('adds an analyst peer and derives its multiples', async () => {
    const res = await add({
      ticker: 'aaa',
      name: 'Alpha Analytics',
      sic: '7372',
      ev: 1_000,
      revenue_ltm: 100,
      ebitda_ltm: 50,
    });
    expect(res.statusCode).toBe(201);
    const item = res.json().comparable;
    expect(item.source).toBe('analyst');
    expect(item.ticker).toBe('AAA'); // normalised on the way in
    expect(item.multiples).toMatchObject({ ev_revenue_ltm: 10, ev_ebitda_ltm: 20 });
  });

  it('rejects a duplicate ticker in the same set', async () => {
    const res = await add({ ticker: 'AAA', name: 'Alpha again', ev: 900, revenue_ltm: 90 });
    expect(res.statusCode).toBe(409);
  });

  it('refuses to exclude a comparable without a reason', async () => {
    const created = await add({ ticker: 'CCC', name: 'Gamma Corp', ev: 800, revenue_ltm: 100 });
    const id = created.json().comparable.id;
    const res = await patch(id, { included: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/requires a reason/i);

    const ok = await patch(id, { included: false, exclude_reason: 'pre-revenue, not comparable' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().comparable.exclude_reason).toBe('pre-revenue, not comparable');
  });

  it('clears the reason when a comparable is put back in', async () => {
    const created = await add({ ticker: 'DDD', name: 'Delta Ltd', ev: 800, revenue_ltm: 100 });
    const id = created.json().comparable.id;
    await patch(id, { included: false, exclude_reason: 'wrong geography' });
    const back = await patch(id, { included: true });
    expect(back.json().comparable.included).toBe(true);
    expect(back.json().comparable.exclude_reason).toBeNull();
  });

  it('excludes a comparable from the derived statistics rather than hiding it', async () => {
    const res = await list();
    const rows = res.json().comparables as Array<{ ticker: string; included: boolean }>;
    // Gamma is excluded above; it is still listed…
    expect(rows.find((r) => r.ticker === 'CCC')?.included).toBe(false);
    // …and contributes nothing to the multiple the engine would be handed.
    const included = rows.filter((r) => r.included).length;
    expect(res.json().statistics.ev_revenue_ltm.count).toBe(included);
  });

  it('deletes an analyst row', async () => {
    const created = await add({ name: 'Typo Co', ev: 1, revenue_ltm: 1 });
    const id = created.json().comparable.id;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/comparables/${id}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(204);
    expect((await list()).json().comparables.some((r: { id: string }) => r.id === id)).toBe(false);
  });

  describe('screening', () => {
    let screenValuationId: string;

    const screen = (token = ops.token) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${screenValuationId}/comparables/screen`,
        headers: authHeader(token),
        payload: {},
      });

    beforeAll(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'ScreenCo' },
      });
      screenValuationId = created.json().valuation.id;
    });

    it('refuses to screen with no target attribute to screen on', async () => {
      const res = await screen();
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/at least one target attribute/i);
    });

    it('persists the selected set and the screened-out rows with their reasons', async () => {
      for (const [key, value] of [
        ['industry_id', 7372],
        ['ltm_revenue', 4_000_000],
        ['ltm_ebitda', 800_000],
      ] as const) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${screenValuationId}/overwrites/${key}`,
          headers: authHeader(ops.token),
          payload: { value, reason: 'test fixture' },
        });
        expect(res.statusCode).toBeLessThan(300);
      }

      const res = await screen();
      expect(res.statusCode).toBe(201);
      const rows = res.json().comparables as Array<{
        ticker: string;
        source: string;
        included: boolean;
        exclude_reason: string | null;
        multiples: Record<string, number | null>;
      }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.source === 'market_feed')).toBe(true);

      // The engine reports market cap and the derived revenue; the stored EV and
      // metric legs have to reproduce the engine's own EV/Revenue exactly, or the
      // exhibit and the calculation disagree about the same comp.
      expect(rows.find((r) => r.ticker === 'AAA')?.multiples.ev_revenue_ltm).toBe(10);
      expect(rows.find((r) => r.ticker === 'BBB')?.multiples.ev_ebitda_ltm).toBe(28);

      const out = rows.find((r) => r.ticker === 'ZZZ');
      expect(out?.included).toBe(false);
      expect(out?.exclude_reason).toBe('different industry');

      // The median of the included set — the figure the engine will select.
      expect(res.json().statistics.ev_revenue_ltm.median).toBe(12);
    });

    it('will not delete a screened row, and says why', async () => {
      const rows = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${screenValuationId}/comparables`,
          headers: authHeader(ops.token),
        })
      ).json().comparables as Array<{ id: string; ticker: string }>;
      const machineRow = rows.find((r) => r.ticker === 'AAA')!;
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${screenValuationId}/comparables/${machineRow.id}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/excluded with a reason, not deleted/i);
    });

    it('carries an analyst exclusion through a re-screen', async () => {
      const before = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${screenValuationId}/comparables`,
          headers: authHeader(ops.token),
        })
      ).json().comparables as Array<{ id: string; ticker: string }>;
      const beta = before.find((r) => r.ticker === 'BBB')!;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${screenValuationId}/comparables/${beta.id}`,
        headers: authHeader(ops.token),
        payload: { included: false, exclude_reason: 'acquired mid-period' },
      });

      const res = await screen();
      expect(res.statusCode).toBe(201);
      const after = res.json().comparables as Array<{
        ticker: string;
        included: boolean;
        exclude_reason: string | null;
      }>;
      // The screen refreshes the data; it does not overrule the analyst. An
      // exclusion that has to be re-applied after every run is an exclusion
      // nobody will bother to make.
      const refreshed = after.find((r) => r.ticker === 'BBB');
      expect(refreshed?.included).toBe(false);
      expect(refreshed?.exclude_reason).toBe('acquired mid-period');
      // And the excluded ticker is fed back to the engine as one to leave out.
      expect(engine.inputs().exclude_tickers).toContain('BBB');
    });

    it('leaves analyst rows alone through a re-screen', async () => {
      const added = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${screenValuationId}/comparables`,
        headers: authHeader(ops.token),
        payload: { ticker: 'MMM', name: 'Manual Pick', ev: 500, revenue_ltm: 50 },
      });
      expect(added.statusCode).toBe(201);

      const res = await screen();
      const rows = res.json().comparables as Array<{ ticker: string; source: string }>;
      expect(rows.find((r) => r.ticker === 'MMM')?.source).toBe('analyst');
      // …and the analyst's kept comp steers the screen rather than being ignored.
      expect(engine.inputs().include_tickers).toContain('MMM');
    });

    it('records the screen on the admin event spine', async () => {
      const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM admin_events
          WHERE subject_id = $1 AND type = 'comparables_screened'
          ORDER BY occurred_at DESC LIMIT 1`,
        [screenValuationId],
      );
      expect(rows[0]?.payload).toMatchObject({ selected: 2, screened_out: 1 });
    });

    it('stamps screened figures as coming from the reference snapshot', async () => {
      // The screen reads `market_data.py`, which calls itself illustrative.
      // Before migration 0133 nothing recorded that, so a reference figure and
      // an observed quote were indistinguishable everywhere downstream.
      const rows = (await screen()).json().comparables as Array<{
        ticker: string;
        figures_source: string | null;
        figures_as_of: string | null;
      }>;
      const alpha = rows.find((r) => r.ticker === 'AAA');
      expect(alpha?.figures_source).toBe('snapshot');
      expect(alpha?.figures_as_of).toBeTruthy();
    });

    /**
     * Every ticker the screen returns is already an analyst's, so the batch
     * admits nothing. The set is written in one statement now, and a statement
     * with no rows is not a statement — the write has to be skipped rather than
     * issued with an empty VALUES list, and the analyst's rows have to survive
     * the delete-then-insert either way.
     */
    it('writes nothing when the analyst already holds every screened ticker', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'AllMineCo' },
      });
      const id = created.json().valuation.id as string;
      for (const [key, value] of [
        ['industry_id', 7372],
        ['ltm_revenue', 4_000_000],
        ['ltm_ebitda', 800_000],
      ] as const) {
        await app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${id}/overwrites/${key}`,
          headers: authHeader(ops.token),
          payload: { value, reason: 'test fixture' },
        });
      }
      // The three tickers the default screen fixture returns.
      for (const ticker of ['AAA', 'BBB', 'ZZZ']) {
        const added = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/comparables`,
          headers: authHeader(ops.token),
          payload: { ticker, name: `Hand-picked ${ticker}`, ev: 500, revenue_ltm: 50 },
        });
        expect(added.statusCode).toBe(201);
      }

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/comparables/screen`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().screened).toBe(0);

      const rows = res.json().comparables as Array<{ ticker: string; source: string; name: string }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.source === 'analyst')).toBe(true);
      expect(rows.map((r) => r.name).sort()).toEqual([
        'Hand-picked AAA',
        'Hand-picked BBB',
        'Hand-picked ZZZ',
      ]);
    });

    /**
     * The engine screens against observed market data where its feed answered
     * and the curated snapshot where it did not, so a single screen can return
     * both. This route used to hard-code `snapshot` for every row, which was
     * true while the engine had no live universe and is a lie now.
     */
    describe('provenance from the engine screen', () => {
      const LIVE_AS_OF = '2026-08-09T12:00:00Z';

      const liveScreen = (rows: Array<Record<string, unknown>>, universe: Record<string, unknown>) => ({
        selected: rows,
        screened_out: [],
        universe_size: 40,
        universe,
      });

      afterEach(() => engine.setScreen(null));

      it('stamps a live row as observed, at the moment the engine observed it', async () => {
        engine.setScreen(
          liveScreen(
            [
              {
                ticker: 'AAA',
                name: 'Alpha Analytics',
                sic_code: '7372',
                market_cap: 1_000,
                enterprise_value: 1_200,
                revenue: 100,
                ebitda_margin: 0.5,
                score: 0.82,
                breakdown: { industry: 1 },
                figures_source: 'live',
                figures_as_of: LIVE_AS_OF,
              },
            ],
            { source: 'live', as_of: LIVE_AS_OF, live_count: 40, snapshot_count: 0, warning_count: 0 },
          ),
        );
        const rows = (await screen()).json().comparables as Array<{
          ticker: string;
          figures_source: string | null;
          figures_as_of: string | null;
        }>;
        const alpha = rows.find((r) => r.ticker === 'AAA');
        expect(alpha?.figures_source).toBe('live');
        // The engine's stamp, not the screen's clock: a live figure is only
        // live at the moment it was observed.
        expect(new Date(alpha!.figures_as_of!).toISOString()).toBe('2026-08-09T12:00:00.000Z');
      });

      it('stamps each row from its own figures, not the set from one of them', async () => {
        engine.setScreen(
          liveScreen(
            [
              {
                ticker: 'AAA',
                name: 'Alpha Analytics',
                sic_code: '7372',
                enterprise_value: 1_200,
                revenue: 100,
                ebitda_margin: 0.5,
                score: 0.82,
                figures_source: 'live',
                figures_as_of: LIVE_AS_OF,
              },
              {
                ticker: 'BBB',
                name: 'Beta Systems',
                sic_code: '7372',
                market_cap: 1_400,
                enterprise_value: 1_400,
                revenue: 100,
                ebitda_margin: 0.5,
                score: 0.61,
                figures_source: 'snapshot',
                figures_as_of: null,
              },
            ],
            { source: 'mixed', as_of: LIVE_AS_OF, live_count: 38, snapshot_count: 2, warning_count: 2 },
          ),
        );
        const rows = (await screen()).json().comparables as Array<{
          ticker: string;
          figures_source: string | null;
        }>;
        expect(rows.find((r) => r.ticker === 'AAA')?.figures_source).toBe('live');
        expect(rows.find((r) => r.ticker === 'BBB')?.figures_source).toBe('snapshot');
      });

      it('stores the enterprise value the multiples were struck on', async () => {
        // Market cap is not EV for a live row — the gap is the net debt — and
        // storing it would understate every multiple implied from the set by
        // exactly that gap.
        engine.setScreen(
          liveScreen(
            [
              {
                ticker: 'AAA',
                name: 'Alpha Analytics',
                sic_code: '7372',
                market_cap: 1_000,
                enterprise_value: 1_200,
                revenue: 100,
                ebitda_margin: 0.5,
                score: 0.82,
                figures_source: 'live',
                figures_as_of: LIVE_AS_OF,
              },
            ],
            { source: 'live', as_of: LIVE_AS_OF, live_count: 40, snapshot_count: 0, warning_count: 0 },
          ),
        );
        const rows = (await screen()).json().comparables as Array<{
          ticker: string;
          ev: number | null;
          multiples: { ev_revenue_ltm: number | null };
        }>;
        const alpha = rows.find((r) => r.ticker === 'AAA');
        expect(alpha?.ev).toBe(1_200);
        // 1,200 / 100 — struck on the engine's enterprise value, so it
        // reproduces the engine's own EV/Revenue. Had the row stored market cap
        // (1,000) instead, this would read 10 and understate the multiple by
        // exactly the net debt.
        expect(alpha?.multiples.ev_revenue_ltm).toBe(12);
      });

      it('falls back to market cap for an engine that reports no enterprise value', async () => {
        // The engine before this change, and any older one still deployed.
        const rows = (await screen()).json().comparables as Array<{ ticker: string; ev: number | null }>;
        expect(rows.find((r) => r.ticker === 'BBB')?.ev).toBe(1_400);
      });

      it('reports which universe was screened, and records it on the event spine', async () => {
        engine.setScreen(
          liveScreen(
            [
              {
                ticker: 'AAA',
                name: 'Alpha Analytics',
                sic_code: '7372',
                enterprise_value: 1_200,
                revenue: 100,
                score: 0.82,
                figures_source: 'live',
                figures_as_of: LIVE_AS_OF,
              },
            ],
            { source: 'mixed', as_of: LIVE_AS_OF, live_count: 38, snapshot_count: 2, warning_count: 2 },
          ),
        );
        const body = (await screen()).json() as { universe: Record<string, unknown> };
        expect(body.universe).toMatchObject({ source: 'mixed', live_count: 38, snapshot_count: 2 });

        // On the event too: the row stamps get overwritten by whoever edits the
        // set next, and "what was this screened against" is asked months later.
        const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM admin_events
            WHERE subject_id = $1 AND type = 'comparables_screened'
            ORDER BY occurred_at DESC LIMIT 1`,
          [screenValuationId],
        );
        expect(rows[0]?.payload.universe).toMatchObject({ source: 'mixed', live_count: 38 });
      });

      it('treats an engine that says nothing about its universe as the snapshot', async () => {
        const body = (await screen()).json() as { universe: { source: string } };
        expect(body.universe.source).toBe('snapshot');
      });
    });

    /**
     * The live market feed — `engine/v1/market-feed`, which had no caller at
     * all until this route, so every multiple the platform had ever reported
     * traced back to the static reference set however old it was.
     */
    describe('refresh from observed market data', () => {
      // Its own engagement, not the one above: the screening tests deliberately
      // leave an analyst exclusion standing on BBB, and a refresh that skips
      // excluded rows would then be tested against a one-row set by accident.
      let feedValuationId: string;

      beforeAll(async () => {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(ops.token),
          payload: { kind: '409a', company_name: 'FeedCo' },
        });
        feedValuationId = created.json().valuation.id;
        for (const [key, value] of [
          ['industry_id', 7372],
          ['ltm_revenue', 4_000_000],
          ['ltm_ebitda', 800_000],
        ] as const) {
          await app.inject({
            method: 'PUT',
            url: `/api/v1/valuations/${feedValuationId}/overwrites/${key}`,
            headers: authHeader(ops.token),
            payload: { value, reason: 'test fixture' },
          });
        }
      });

      const screenFeed = () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${feedValuationId}/comparables/screen`,
          headers: authHeader(ops.token),
          payload: {},
        });

      const refresh = (token = ops.token) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${feedValuationId}/comparables/refresh`,
          headers: authHeader(token),
          payload: {},
        });

      const rowsNow = async () =>
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/valuations/${feedValuationId}/comparables`,
            headers: authHeader(ops.token),
          })
        ).json().comparables as Array<{
          id: string;
          ticker: string;
          ev: number | null;
          revenue_ltm: number | null;
          ebitda_ltm: number | null;
          included: boolean;
          figures_source: string | null;
          multiples: Record<string, number | null>;
        }>;

      it('rejects a non-ops caller', async () => {
        expect((await refresh(client.token)).statusCode).toBe(403);
      });

      it('replaces the figures with observed ones and re-stamps the row', async () => {
        await screenFeed();
        engine.setFeed({
          AAA: { source: 'yfinance', market_cap: 5_000, total_revenue: 250, ebitda: 60 },
          BBB: { source: 'yfinance', market_cap: 2_800, total_revenue: 200, ebitda: 40 },
        });

        const res = await refresh();
        expect(res.statusCode).toBe(200);
        expect(res.json().refreshed).toHaveLength(2);
        expect(res.json().unavailable).toEqual([]);

        const alpha = (await rowsNow()).find((r) => r.ticker === 'AAA')!;
        expect(alpha.ev).toBe(5_000);
        expect(alpha.revenue_ltm).toBe(250);
        expect(alpha.ebitda_ltm).toBe(60);
        expect(alpha.figures_source).toBe('live');
        // And the multiple the market approach reads follows the new figures:
        // 5,000 / 250, not the snapshot's 1,000 / 100.
        expect(alpha.multiples.ev_revenue_ltm).toBeCloseTo(20, 6);
      });

      it('leaves a row exactly as it was when the feed falls back', async () => {
        await screenFeed();
        // The engine returns `source: "fallback"` with a warning rather than
        // failing. Writing those figures as observed market data is the one
        // thing the provenance columns exist to prevent.
        engine.setFeed({ AAA: { source: 'yfinance', market_cap: 9_000, total_revenue: 300, ebitda: 75 } });

        const res = await refresh();
        expect(res.statusCode).toBe(200);
        expect(res.json().refreshed.map((r: { ticker: string }) => r.ticker)).toEqual(['AAA']);
        expect(res.json().unavailable.map((r: { ticker: string }) => r.ticker)).toEqual(['BBB']);

        const rows = await rowsNow();
        const beta = rows.find((r) => r.ticker === 'BBB')!;
        expect(beta.figures_source).toBe('snapshot');
        expect(beta.ev).toBe(1_400); // the screened figure, untouched
        expect(rows.find((r) => r.ticker === 'AAA')?.figures_source).toBe('live');
      });

      it('does not spend a fetch on an excluded comp', async () => {
        await screenFeed();
        const beta = (await rowsNow()).find((r) => r.ticker === 'BBB')!;
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${feedValuationId}/comparables/${beta.id}`,
          headers: authHeader(ops.token),
          payload: { included: false, exclude_reason: 'not comparable on scale' },
        });

        engine.setFeed({ AAA: { source: 'yfinance', market_cap: 5_000, total_revenue: 250, ebitda: 60 } });
        await refresh();
        expect(engine.feedCalls()).toEqual(['AAA']);
      });

      it('does not overwrite figures an analyst entered by hand', async () => {
        await screenFeed();
        const added = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${feedValuationId}/comparables`,
          headers: authHeader(ops.token),
          payload: { ticker: 'HAND', name: 'Hand Entered', ev: 777, revenue_ltm: 77 },
        });
        expect(added.statusCode).toBe(201);
        expect(added.json().comparable.figures_source).toBe('analyst');

        engine.setFeed({
          AAA: { source: 'yfinance', market_cap: 5_000, total_revenue: 250, ebitda: 60 },
          HAND: { source: 'yfinance', market_cap: 1, total_revenue: 1, ebitda: 1 },
        });
        await refresh();
        expect(engine.feedCalls()).not.toContain('HAND');
        const hand = (await rowsNow()).find((r) => r.ticker === 'HAND')!;
        expect(hand.ev).toBe(777);
        expect(hand.figures_source).toBe('analyst');
      });

      it('marks a row an analyst figure once they have typed over it', async () => {
        await screenFeed();
        engine.setFeed({
          AAA: { source: 'yfinance', market_cap: 5_000, total_revenue: 250, ebitda: 60 },
          BBB: { source: 'yfinance', market_cap: 2_800, total_revenue: 200, ebitda: 40 },
        });
        await refresh();

        const alpha = (await rowsNow()).find((r) => r.ticker === 'AAA')!;
        const patched = await app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${feedValuationId}/comparables/${alpha.id}`,
          headers: authHeader(ops.token),
          payload: { ev: 4_000 },
        });
        expect(patched.statusCode).toBe(200);
        // It stopped being observed market data the moment somebody changed it.
        expect(patched.json().comparable.figures_source).toBe('analyst');
      });

      it('refuses a refresh on a set with no ticker to fetch', async () => {
        const empty = await app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(ops.token),
          payload: { kind: '409a', company_name: 'NoPeersCo' },
        });
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${empty.json().valuation.id}/comparables/refresh`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(422);
      });

      it('records the refresh on the admin event spine', async () => {
        const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM admin_events
            WHERE subject_id = $1 AND type = 'comparables_refreshed'
            ORDER BY occurred_at DESC LIMIT 1`,
          [feedValuationId],
        );
        expect(rows[0]?.payload).toBeTruthy();
      });
    });
  });
});
