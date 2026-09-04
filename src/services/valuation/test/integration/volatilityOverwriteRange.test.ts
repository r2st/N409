import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { OVERWRITE_FIELDS_BY_KEY } from '../../src/domain/overwrites.js';

const dbUp = await isDbAvailable();

/**
 * Two doors onto one overwrite cell, and only one of them asked the field.
 *
 * `PUT /valuations/:id/overwrites/volatility` runs `validateOverwriteValue`,
 * which enforces the range `domain/overwrites.ts` declares for the field
 * (`{min: 0.05, max: 3}`) and answers 422 outside it.
 * `POST /valuations/:id/volatility/:estimateId/apply` imposes a figure on the
 * same cell — `upsertOverwrite`, then `applyEngineInputs` — and never asked.
 *
 * `manual_override` was `gt(0).lt(5)`, wider at both ends, so the analyst's own
 * pinned figure was the reachable way in: 4.5 recorded, adopted, written to
 * `engine_inputs.volatility`, and shown on an overwrites tab whose schema
 * endpoint tells it the maximum for that field is 3.
 */
const FIELD = OVERWRITE_FIELDS_BY_KEY.get('volatility')!;

interface StubState {
  estimate: Record<string, unknown> | null;
}

async function startEngineStub(state: StubState) {
  const stub = Fastify({ logger: false });
  // Enough closing prices that a run with no `manual_override` has something
  // to measure, so the derived-recommendation case reaches the stub below.
  stub.post('/engine/v1/market-feed', async () => ({
    source: 'yfinance',
    prices: Array.from({ length: 60 }, (_, i) => ({
      date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
      close: 100 + i,
      high: 105 + i,
      low: 95 + i,
    })),
  }));
  stub.post('/engine/v1/volatility', async (req) => {
    if (state.estimate) return state.estimate;
    const body = req.body as { manual_override?: number };
    const v = body.manual_override ?? 0.6;
    return {
      method: 'manual',
      recommended_volatility: v,
      manual_override: v,
      confidence: 'manual',
      companies: [],
      excluded_companies: [],
    };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const port = (stub.server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('the volatility a run may impose on the overwrite cell', () => {
  let ctx: TestApp;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  const state: StubState = { estimate: null };

  beforeAll(async () => {
    engine = await startEngineStub(state);
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'SigmaCo' },
    });
    expect(created.statusCode, created.body).toBe(201);
    valuationId = created.json().valuation.id as string;

    // A peer with a ticker, so a run with no `manual_override` reaches the
    // engine stub instead of being refused for having nothing to measure.
    const peer = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      payload: { ticker: 'AAA', name: 'Peer One' },
    });
    expect(peer.statusCode, peer.body).toBe(201);
  });

  // The stub's canned answer is per-test; a leak would make every later
  // adoption fail for the reason the test before it was about.
  afterEach(() => {
    state.estimate = null;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  const estimate = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/estimate`,
      headers: authHeader(ops.token),
      payload,
    });

  const apply = (estimateId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/${estimateId}/apply`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const overwrite = (value: number) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/overwrites/volatility`,
      headers: authHeader(ops.token),
      payload: { value },
    });

  it('declares a range the other door has always enforced', async () => {
    expect(FIELD.min).toBe(0.05);
    expect(FIELD.max).toBe(3);
    expect((await overwrite(FIELD.max! + 1.5)).statusCode).toBe(422);
    expect((await overwrite(FIELD.min! / 2)).statusCode).toBe(422);
  });

  it('refuses a pinned volatility above the field maximum at the estimate door', async () => {
    const res = await estimate({ manual_override: FIELD.max! + 1.5 });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('refuses a pinned volatility below the field minimum too', async () => {
    const res = await estimate({ manual_override: FIELD.min! / 2 });
    expect(res.statusCode, res.body).toBe(422);
  });

  /**
   * The half the estimate door cannot cover: a *derived* recommendation. A peer
   * set whose median sigma lands outside the range is a real measurement worth
   * recording; it is not a figure to price a §409A off, so it is refused where
   * it would be imposed rather than where it was measured.
   */
  it('refuses to adopt a derived recommendation outside the range', async () => {
    state.estimate = {
      method: 'historical',
      recommended_volatility: FIELD.max! + 1.2,
      median_volatility: FIELD.max! + 1.2,
      confidence: 'low',
      companies: [],
      excluded_companies: [],
    };
    const created = await estimate({});
    expect(created.statusCode, created.body).toBe(201);
    const estimateId = created.json().estimate.id as string;

    const applied = await apply(estimateId);
    expect(applied.statusCode, applied.body).toBe(422);
    expect(applied.json().detail).toMatch(/cannot be applied/i);

    // Neither half of the adoption happened.
    const { rows } = await ctx.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM overwrites WHERE valuation_id = $1 AND field_key = 'volatility'",
      [valuationId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    const params = await ctx.pool.query<{ engine_inputs: Record<string, unknown> | null }>(
      'SELECT engine_inputs FROM valuation_params WHERE valuation_id = $1',
      [valuationId],
    );
    expect(params.rows[0]?.engine_inputs?.volatility ?? null).toBeNull();
  });

  it('still adopts a recommendation inside the range', async () => {
    const created = await estimate({ manual_override: 0.62 });
    expect(created.statusCode, created.body).toBe(201);
    const applied = await apply(created.json().estimate.id as string);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().applied_volatility).toBeCloseTo(0.62, 10);
  });

  it('accepts the bounds themselves, so the range is inclusive at both ends', async () => {
    for (const v of [FIELD.min!, FIELD.max!]) {
      const created = await estimate({ manual_override: v });
      expect(created.statusCode, created.body).toBe(201);
      const applied = await apply(created.json().estimate.id as string);
      expect(applied.statusCode, applied.body).toBe(200);
    }
  });
});
