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
  let lastPayload: Record<string, any> | null = null;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/debt-valuation', async (req) => {
      lastPayload = req.body as Record<string, any>;
      // Return a plausible shape depending on type.
      if (lastPayload.instrument_type === 'safe')
        return { fair_value: 400000, conversion_price: 0.5, converted_via: 'cap' };
      if (lastPayload.instrument_type === 'convertible')
        return { fair_value: 1100, straight_debt_value: 900, option_value: 200, parity: 800 };
      return {
        dirty_price: 980.5,
        clean_price: 980.5,
        accrued_interest: 0,
        market_yield: 0.06,
        modified_duration: 4.1,
        convexity: 20,
      };
    });
    engineStub.post('/engine/v1/debt-rating-spread', async (req) => ({
      rating: (req.body as any).rating.toUpperCase(),
      spread: 0.03,
    }));
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
    expect(lastPayload?.params.benchmark_yield).toBe(0.03);
    expect(lastPayload?.params.rating).toBe('BB');
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
    expect(lastPayload?.params.market_yield).toBe(0.09);
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
