import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Stub of engine-wrapper's /engine/v1/sensitivity. `fail` flips it to the
 * error shape the real service returns so the route's InternalServiceError
 * branch is exercised against something with the right envelope.
 */
async function startEngineStub(state: {
  fail: boolean;
  lastPayload: Record<string, unknown> | null;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/sensitivity', async (req, reply) => {
    state.lastPayload = req.body as Record<string, unknown>;
    if (state.fail) {
      return reply.status(422).send({
        type: 'urn:n409:problem:validation',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'discount_rate is required',
      });
    }
    return reply.send({
      base: { fmv_per_share: 1.25 },
      one_way: { discount_rate: [{ shock: -0.1, fmv_per_share: 1.4 }] },
      two_way: [],
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

/**
 * The two sensitivity endpoints. The closed-form grid is computed in-process;
 * the full-model one delegates to the engine. Both are ops-only analyst tooling
 * and neither had route-level coverage.
 */
describe.skipIf(!dbUp)('sensitivity routes', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state = { fail: false, lastPayload: null as Record<string, unknown> | null };

  const GOOD_BODY = {
    equity_value_cents: 5_000_000_00,
    strike_cents: 1_00,
    volatility: 0.6,
    term_years: 4,
    risk_free_rate: 0.04,
    common_shares: 10_000_000,
  };

  const grid = (payload: unknown, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/sensitivity`,
      headers: authHeader(token),
      payload,
    });

  const model = (payload: unknown, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/sensitivity/model`,
      headers: authHeader(token),
      payload,
    });

  beforeAll(async () => {
    engineStub = await startEngineStub(state);
    ctx = await setupTestApp({
      AUTO_PIPELINE: 'off',
      EMAIL_MODE: 'off',
      ENGINE_URL: engineStub.url,
    });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'SensitivityCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engineStub?.close();
  });

  describe('POST /sensitivity — closed-form grid', () => {
    it('computes a grid and echoes the valuation currency', async () => {
      const res = await grid(GOOD_BODY);
      expect(res.statusCode).toBe(200);
      const s = res.json().sensitivity;
      expect(s.currency).toBe('USD');
      expect(s.tables).toBeDefined();
      expect(s.base).toBeDefined();
    });

    it('defaults DLOM to 0 when the valuation has no params row', async () => {
      const res = await grid(GOOD_BODY);
      expect(res.json().sensitivity.dlom).toBe(0);
    });

    it('reads the stored DLOM when the body omits it', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
        payload: { dlom: 0.25 },
      });
      const res = await grid(GOOD_BODY);
      expect(res.statusCode).toBe(200);
      expect(res.json().sensitivity.dlom).toBeCloseTo(0.25, 6);
    });

    it('prefers an explicit DLOM in the body over the stored one', async () => {
      const res = await grid({ ...GOOD_BODY, dlom: 0.4 });
      expect(res.json().sensitivity.dlom).toBeCloseTo(0.4, 6);
    });

    it('is operations-only', async () => {
      const res = await grid(GOOD_BODY, client.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toContain('operations-only');
    });

    it('404s on a non-ULID id rather than reaching the database', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations/not-a-ulid/sensitivity',
        headers: authHeader(ops.token),
        payload: GOOD_BODY,
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects assumptions outside the engine-supportable ranges', async () => {
      for (const bad of [
        { ...GOOD_BODY, volatility: 0 }, // must be > 0
        { ...GOOD_BODY, volatility: 6 }, // capped at 5
        { ...GOOD_BODY, term_years: 31 }, // capped at 30
        { ...GOOD_BODY, risk_free_rate: 0.5 }, // capped at 0.25
        { ...GOOD_BODY, dlom: 0.99 }, // capped at 0.95
        { ...GOOD_BODY, equity_value_cents: -1 },
        { ...GOOD_BODY, common_shares: 0 },
        { ...GOOD_BODY, equity_value_cents: 1.5 }, // must be an integer
      ]) {
        const res = await grid(bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(422);
        expect(res.json().detail).toBe('Invalid assumptions');
      }
    });

    it('caps the number of stress steps', async () => {
      const res = await grid({ ...GOOD_BODY, volatility_steps: Array(10).fill(0.1) });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('POST /sensitivity/model — full engine re-run', () => {
    it('404s when the valuation has no params to stress', async () => {
      const fresh = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'NoParamsCo' },
      });
      const freshId = fresh.json().valuation.id as string;
      // Creating a valuation seeds a params row, so there is nothing to stress
      // only once that row is gone — which is the state this branch guards.
      await pool.query('DELETE FROM valuation_params WHERE valuation_id = $1', [freshId]);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${freshId}/sensitivity/model`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s on a non-ULID id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations/not-a-ulid/sensitivity/model',
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('posts params + inputs to the engine and returns its result', async () => {
      state.fail = false;
      const res = await model({});
      expect(res.statusCode).toBe(200);
      expect(res.json().sensitivity.base.fmv_per_share).toBe(1.25);
      expect(res.json().sensitivity.currency).toBe('USD');
      expect(state.lastPayload).not.toBeNull();
      expect(state.lastPayload).toHaveProperty('params');
      expect(state.lastPayload).toHaveProperty('inputs');
    });

    it('defaults to an empty body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/sensitivity/model`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
    });

    it('forwards only the levers the caller actually set', async () => {
      state.lastPayload = null;
      const res = await model({
        parameters: ['discount_rate', 'volatility'],
        two_way: [['discount_rate', 'volatility']],
        span: 0.2,
        steps: 5,
        inputs: {},
      });
      expect(res.statusCode).toBe(200);
      expect(state.lastPayload).toMatchObject({
        parameters: ['discount_rate', 'volatility'],
        two_way: [['discount_rate', 'volatility']],
        span: 0.2,
        steps: 5,
      });
    });

    it('omits unset levers rather than sending nulls', async () => {
      state.lastPayload = null;
      await model({ inputs: {} });
      expect(state.lastPayload).not.toHaveProperty('parameters');
      expect(state.lastPayload).not.toHaveProperty('two_way');
      expect(state.lastPayload).not.toHaveProperty('span');
      expect(state.lastPayload).not.toHaveProperty('steps');
    });

    it('rejects an unknown lever', async () => {
      const res = await model({ parameters: ['not_a_lever'] });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toBe('Invalid options');
    });

    it('rejects out-of-range span and steps', async () => {
      for (const bad of [{ span: 0 }, { span: 3 }, { steps: 1 }, { steps: 22 }, { steps: 4.5 }]) {
        const res = await model(bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      }
    });

    it('translates an engine failure into a problem response', async () => {
      state.fail = true;
      try {
        const res = await model({});
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toContain('discount_rate');
      } finally {
        state.fail = false;
      }
    });

    it('is operations-only', async () => {
      const res = await model({}, client.token);
      expect(res.statusCode).toBe(403);
    });
  });
});
