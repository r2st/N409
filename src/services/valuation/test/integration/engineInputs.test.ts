import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/** Engine stub that records the compute payload so we can assert wiring. */
async function startEngineStub(record: (body: unknown) => void) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/compute', async (req, reply) => {
    record(req.body);
    return reply.send({
      engine_version: 'py-stub',
      results: {
        equity_value: 12_000_000,
        fmv_per_share: 1.2,
        approaches: { income: { equity_value: 12_000_000, weight: 1 } },
      },
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('Financial model (engine_inputs) API', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let lastEnginePayload: Record<string, unknown> | null = null;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    engineStub = await startEngineStub((b) => {
      lastEnginePayload = b as Record<string, unknown>;
    });

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: engineStub.url,
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'ModelCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const patch = (token: string, body: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(token),
      payload: body,
    });

  it('persists a hand-entered model and reads it back', async () => {
    const res = await patch(ops.token, {
      shares_outstanding_common: 8_000_000,
      volatility: 0.6,
      income: { free_cash_flows: [1e6, 2e6, 3e6], discount_rate: 0.25, terminal_growth: 0.03 },
      market: { metric: 4_000_000, multiples: [3.5, 5, 6.2] },
      share_classes: [
        { kind: 'common', name: 'Common', shares: 8_000_000 },
        { kind: 'preferred', name: 'Series A', shares: 2_000_000, preference: 5_000_000 },
      ],
    });
    expect(res.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
    });
    expect(get.statusCode).toBe(200);
    const ei = get.json().engine_inputs;
    expect(ei.shares_outstanding_common).toBe(8_000_000);
    expect(ei.income.free_cash_flows).toEqual([1e6, 2e6, 3e6]);
    expect(ei.share_classes).toHaveLength(2);
  });

  it('merges partial edits without wiping untouched sections', async () => {
    const res = await patch(ops.token, { volatility: 0.7 });
    expect(res.statusCode).toBe(200);
    const ei = res.json().params.engine_inputs;
    expect(ei.volatility).toBe(0.7);
    // The income section from the first save survives.
    expect(ei.income.free_cash_flows).toEqual([1e6, 2e6, 3e6]);
  });

  it('rejects non-ops writers with 403', async () => {
    const res = await patch(client.token, { volatility: 0.5 });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid model with 422', async () => {
    const res = await patch(ops.token, { income: { discount_rate: 0.02, terminal_growth: 0.05 } });
    expect(res.statusCode).toBe(422);
  });

  it('feeds the saved model straight into the compute engine', async () => {
    // Weight the income approach so the engine payload carries our DCF inputs.
    const weights = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { weight_asset: 0, weight_opm: 0, weight_income: 1, weight_market: 0 },
    });
    expect(weights.statusCode).toBe(200);

    lastEnginePayload = null;
    const calc = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(calc.statusCode).toBe(201);
    const inputs = (lastEnginePayload as { inputs?: Record<string, unknown> } | null)?.inputs;
    expect(inputs).toBeTruthy();
    expect((inputs?.income as { free_cash_flows: number[] }).free_cash_flows).toEqual([1e6, 2e6, 3e6]);
  });

  /**
   * The DCF's methodology choices, over the whole path they have to survive:
   * the route that would not accept them, the jsonb document that never held
   * them, and the payload the engine reads them from. Asserting the schema
   * alone would have passed on the day the engine could not be told either.
   */
  it('carries the mid-year convention and an exit-multiple terminal value to the engine', async () => {
    const saved = await patch(ops.token, {
      income: {
        free_cash_flows: [1e6, 2e6, 3e6],
        discount_rate: 0.25,
        mid_year_convention: true,
        terminal_method: 'exit_multiple',
        exit_multiple: 8.5,
        terminal_metric: 4_400_000,
        terminal_metric_basis: 'ebitda',
      },
    });
    expect(saved.statusCode).toBe(200);

    lastEnginePayload = null;
    const calc = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(calc.statusCode).toBe(201);

    const income = (lastEnginePayload as { inputs?: { income?: Record<string, unknown> } } | null)?.inputs
      ?.income;
    expect(income?.mid_year_convention).toBe(true);
    expect(income?.terminal_method).toBe('exit_multiple');
    expect(income?.exit_multiple).toBe(8.5);
    expect(income?.terminal_metric).toBe(4_400_000);
    expect(income?.terminal_metric_basis).toBe('ebitda');
  });

  it('refuses an exit-multiple terminal value with nothing to strike', async () => {
    const res = await patch(ops.token, {
      income: { discount_rate: 0.25, terminal_method: 'exit_multiple' },
    });
    expect(res.statusCode).toBe(422);
  });
});
