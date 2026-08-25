import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('Debt valuation', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  /**
   * The request the service sends the engine, in the shape this stub reads it.
   * Typed rather than `Record<string, any>` because the assertions below are
   * the point of the file — `lastPayload?.params?.market_yield` against `any`
   * passes whether or not the service sent a `params` at all.
   */
  interface DebtEngineRequest {
    instrument_type?: string;
    params?: Record<string, unknown>;
  }
  let lastPayload: DebtEngineRequest | null = null;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/debt-valuation', async (req) => {
      lastPayload = req.body as DebtEngineRequest;
      // Return a plausible shape depending on type.
      if (lastPayload.instrument_type === 'safe')
        return { fair_value: 400000, conversion_price: 0.5, converted_via: 'cap' };
      if (lastPayload.instrument_type === 'convertible')
        return { fair_value: 1100, straight_debt_value: 900, option_value: 200, parity: 800 };
      // Price scales with face, as the real engine's does: `face` carries no
      // maximum in `debt_valuation._num`, so a large one yields a large — but
      // perfectly finite — dirty price. The usual face of 1000 still prices at
      // exactly 980.5.
      const price = Number(lastPayload.params?.face ?? 1000) * 0.9805;
      return {
        dirty_price: price,
        clean_price: price,
        accrued_interest: 0,
        market_yield: 0.06,
        modified_duration: 4.1,
        convexity: 20,
      };
    });
    engineStub.post('/engine/v1/debt-rating-spread', async (req) => {
      const { rating } = req.body as { rating?: unknown };
      // A stub that TypeErrors here reports "cannot read toUpperCase of
      // undefined" from inside Fastify; say what was actually sent instead.
      if (typeof rating !== 'string') {
        throw new Error(`debt-rating-spread called without a rating: ${JSON.stringify(req.body)}`);
      }
      return { rating: rating.toUpperCase(), spread: 0.03 };
    });
    await engineStub.listen({ port: 0, host: '127.0.0.1' });
    const address = engineStub.server.address();
    const enginePort = typeof address === 'object' && address ? address.port : 0;

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: `http://127.0.0.1:${enginePort}`,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  async function createInstrument(type: string, params: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: { name: `${type} test`, instrument_type: type, currency: 'USD', params },
    });
    expect(res.statusCode).toBe(201);
    return res.json().instrument.id as string;
  }

  it('creates a bond and runs a valuation with duration', async () => {
    const id = await createInstrument('bond', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
      market_yield: 0.06,
    });
    const val = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${id}/value`,
      headers: authHeader(ops.token),
      payload: { valuation_date: '2026-06-30' },
    });
    expect(val.statusCode).toBe(200);
    expect(Number(val.json().valuation.fair_value)).toBeCloseTo(980.5);
    expect(val.json().result.modified_duration).toBe(4.1);
    // History records the run.
    const hist = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${id}/valuations`,
      headers: authHeader(ops.token),
    });
    expect(hist.json().valuations).toHaveLength(1);
  });

  it('prices a what-if without recording it as a measurement', async () => {
    const id = await createInstrument('bond', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
      market_yield: 0.06,
    });
    // The measurement. One row, and the fair value the instrument is worth.
    await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${id}/value`,
      headers: authHeader(ops.token),
      payload: { valuation_date: '2026-06-30' },
    });

    // The sensitivity walk: the same instrument at four shocked yields, priced
    // to draw a curve. `face` is what this stub scales the price by, so a
    // shocked run is given a different one — the point is that a run returning
    // a *different* number still leaves the record alone.
    for (const face of [900, 950, 1050, 1100]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/debt/instruments/${id}/value`,
        headers: authHeader(ops.token),
        payload: { overrides: { face }, persist: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.dirty_price).toBeCloseTo(face * 0.9805);
      // Answered, and explicitly not a row: a caller that stored `valuation`
      // would otherwise store `undefined` and never know.
      expect(res.json().valuation).toBeNull();
    }

    const hist = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${id}/valuations`,
      headers: authHeader(ops.token),
    });
    // `listValuations` is newest-first and `loadDebtReport` takes its head for
    // the measurement the report is about. Before the flag, that head was the
    // last shock of the walk.
    expect(hist.json().valuations).toHaveLength(1);
    expect(Number(hist.json().valuations[0].fair_value)).toBeCloseTo(980.5);
  });

  it('records the run when nothing says otherwise', async () => {
    const id = await createInstrument('bond', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
      market_yield: 0.06,
    });
    // The vacuity guard on the test above: `persist` defaults to true, so an
    // older client that has never heard of it still writes its measurement.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${id}/value`,
      headers: authHeader(ops.token),
      payload: { overrides: { face: 1100 } },
    });
    expect(res.json().valuation).not.toBeNull();
    const hist = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${id}/valuations`,
      headers: authHeader(ops.token),
    });
    expect(hist.json().valuations).toHaveLength(1);
  });

  it('orders history by the date measured, not the date typed', async () => {
    const id = await createInstrument('bond', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
      market_yield: 0.06,
    });
    // Q2 is measured first and Q1 backfilled after it — a correction, or a
    // prior quarter entered late. `valuation_date` is a request parameter, so
    // this is an ordinary thing for an analyst to do.
    for (const [date, face] of [
      ['2026-06-30', 1000],
      ['2026-03-31', 900],
      ['2026-09-30', 1100],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/debt/instruments/${id}/value`,
        headers: authHeader(ops.token),
        payload: { valuation_date: date, overrides: { face } },
      });
    }

    const hist = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${id}/valuations`,
      headers: authHeader(ops.token),
    });
    const dates = (hist.json().valuations as Array<{ valuation_date: string }>).map((v) => v.valuation_date);
    expect(dates).toEqual(['2026-09-30', '2026-06-30', '2026-03-31']);
    // The head is what `loadDebtReport` hands the report as the measurement it
    // speaks for, and what the history exhibit prints first under a sentence
    // promising "most recent first". Ordered by `created_at` it was the March
    // backfill, because that is the one that had been typed most recently.
    expect(Number(hist.json().valuations[0].fair_value)).toBeCloseTo(1100 * 0.9805);
  });

  it('breaks a same-date tie on the later run', async () => {
    const id = await createInstrument('bond', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
      market_yield: 0.06,
    });
    // Two measurements bearing one date is a re-run after a correction, and
    // there the later one is the one that stands — which is why `created_at`
    // remains the tiebreak rather than being dropped.
    for (const face of [1000, 1200]) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/debt/instruments/${id}/value`,
        headers: authHeader(ops.token),
        payload: { valuation_date: '2026-06-30', overrides: { face } },
      });
    }
    const hist = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${id}/valuations`,
      headers: authHeader(ops.token),
    });
    expect(hist.json().valuations).toHaveLength(2);
    expect(Number(hist.json().valuations[0].fair_value)).toBeCloseTo(1200 * 0.9805);
  });

  it('merges credit terms into a credit_spread valuation', async () => {
    const id = await createInstrument('credit_spread', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/debt/instruments/${id}/credit-terms`,
      headers: authHeader(ops.token),
      payload: { rating: 'BB', benchmark_yield: 0.03, seniority: 'subordinated' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${id}/value`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(lastPayload?.params?.benchmark_yield).toBe(0.03);
    expect(lastPayload?.params?.rating).toBe('BB');
  });

  it('values a convertible and a SAFE', async () => {
    const conv = await createInstrument('convertible', {
      face: 1000,
      coupon_rate: 0.04,
      frequency: 2,
      maturity_years: 5,
      conversion_ratio: 20,
      stock_price: 40,
      volatility: 0.4,
      risk_free_rate: 0.03,
      credit_spread: 0.02,
    });
    const cv = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${conv}/value`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(cv.json().result.option_value).toBe(200);

    const safe = await createInstrument('safe', {
      investment: 100000,
      valuation_cap: 5000000,
      discount: 0.2,
      next_round_pre_money: 20000000,
      next_round_shares: 10000000,
    });
    const sv = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${safe}/value`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(sv.json().result.converted_via).toBe('cap');
  });

  it('applies per-run overrides over stored params', async () => {
    const id = await createInstrument('bond', {
      face: 1000,
      coupon_rate: 0.05,
      frequency: 2,
      maturity_years: 5,
      market_yield: 0.06,
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${id}/value`,
      headers: authHeader(ops.token),
      payload: { overrides: { market_yield: 0.09 } },
    });
    expect(lastPayload?.params?.market_yield).toBe(0.09);
  });

  it('looks up a rating spread', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/rating-spread',
      headers: authHeader(ops.token),
      payload: { rating: 'bb' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().spread).toBe(0.03);
  });

  /**
   * `debt_valuations.fair_value` is `numeric(24, 6)`, so it holds figures below
   * 1e18. Nothing bounded what arrived there: `params` is `z.record(z.unknown())`
   * on the way in, and the engine's `_num` refuses NaN and Inf but sets no
   * maximum, so a face of 1e25 prices at 1e25 — finite, cleared by every check,
   * and seven orders of magnitude too large for the column. The driver answered
   * `22003 numeric field overflow` and nothing caught it.
   */
  it('refuses a fair value too large for its column instead of 500ing', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: {
        name: 'Oversized',
        instrument_type: 'bond',
        currency: 'USD',
        params: { face: 1e25, coupon_rate: 0.05, maturity_years: 5 },
      },
    });
    expect(created.statusCode).toBe(201);

    const valued = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${created.json().instrument.id}/value`,
      headers: authHeader(ops.token),
      payload: { valuation_date: '2026-01-01', overrides: {} },
    });
    expect(valued.statusCode).toBe(422);
    expect(valued.json().detail).toMatch(/too large to record/i);

    // Nothing was written: the run is refused whole, not half-stored.
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${created.json().instrument.id}/valuations`,
      headers: authHeader(ops.token),
    });
    expect(history.json().valuations).toHaveLength(0);
  });

  it('still stores a fair value the column can hold', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: {
        name: 'Large but storable',
        instrument_type: 'bond',
        currency: 'USD',
        params: { face: 1e12, coupon_rate: 0.05, maturity_years: 5 },
      },
    });
    const valued = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${created.json().instrument.id}/value`,
      headers: authHeader(ops.token),
      payload: { valuation_date: '2026-01-01', overrides: {} },
    });
    expect(valued.statusCode).toBe(200);
    expect(Number(valued.json().valuation.fair_value)).toBeCloseTo(9.805e11, -6);
  });

  it('forbids non-ops and 404s unknown instruments', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/debt/instruments',
      headers: authHeader(client.token),
    });
    expect(forbidden.statusCode).toBe(403);
    const notFound = await app.inject({
      method: 'GET',
      url: '/api/v1/debt/instruments/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      headers: authHeader(ops.token),
    });
    expect(notFound.statusCode).toBe(404);
  });
});
