import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

interface EngineIssue {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  hint: string | null;
}

const ISSUE = (over: Partial<EngineIssue> = {}): EngineIssue => ({
  code: 'required',
  field: 'inputs.volatility',
  message: 'volatility is required for the OPM allocation / model DLOM',
  severity: 'error',
  hint: 'Run the volatility estimator.',
  ...over,
});

const WARNING = ISSUE({
  code: 'high_discount',
  field: 'params.dlom',
  message: 'a 60.0% discount for lack of marketability is above the range normally supportable',
  severity: 'warning',
  hint: 'Reviewers will expect a model DLOM or a cited study.',
});

/**
 * Engine stub that mirrors the real contract: /validate returns structured
 * errors + warnings, /compute 422s with an `issues` array or succeeds with
 * `warnings` alongside the results.
 */
async function startEngineStub(state: {
  validateErrors: EngineIssue[];
  computeShouldFail: boolean;
  computeWarnings: EngineIssue[];
  lastValidatePayload: Record<string, unknown> | null;
}) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/validate', async (req, reply) => {
    state.lastValidatePayload = req.body as Record<string, unknown>;
    return reply.send({
      engine_version: 'py-stub',
      ok: state.validateErrors.length === 0,
      errors: state.validateErrors,
      warnings: [WARNING],
    });
  });
  stub.post('/engine/v1/compute', async (_req, reply) => {
    if (state.computeShouldFail) {
      return reply.status(422).send({
        detail: 'volatility is required (and 1 more input problem)',
        issues: [ISSUE(), ISSUE({ field: 'inputs.market.metric', code: 'not_positive' })],
        warnings: [],
      });
    }
    return reply.send({
      engine_version: 'py-stub',
      results: {
        equity_value: 12_000_000,
        fmv_per_share: 1.2,
        approaches: { income: { equity_value: 12_000_000, weight: 1 } },
      },
      warnings: state.computeWarnings,
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('Engine pre-flight validation', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state = {
    validateErrors: [] as EngineIssue[],
    computeShouldFail: false,
    computeWarnings: [] as EngineIssue[],
    lastValidatePayload: null as Record<string, unknown> | null,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    engineStub = await startEngineStub(state);

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
      payload: { kind: '409a', company_name: 'PreflightCo' },
    });
    valuationId = created.json().valuation.id;

    // Params so the payload assembly has weights to send.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: {
        shares_outstanding_common: 8_000_000,
        income: { free_cash_flows: [1e6, 2e6], discount_rate: 0.25, terminal_growth: 0.03 },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const preflight = (token: string, payload: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations/preflight`,
      headers: authHeader(token),
      payload,
    });

  it('reports a clean payload as ok, with warnings still surfaced', async () => {
    state.validateErrors = [];
    const res = await preflight(ops.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.warnings[0].code).toBe('high_discount');
    expect(body.warnings[0].field).toBe('params.dlom');
  });

  it('returns every blocking error with its field path', async () => {
    state.validateErrors = [ISSUE(), ISSUE({ field: 'inputs.market.metric', code: 'not_positive' })];
    const res = await preflight(ops.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.map((e: EngineIssue) => e.field)).toEqual([
      'inputs.volatility',
      'inputs.market.metric',
    ]);
    expect(body.errors[0].hint).toBeTruthy();
  });

  it('sends the same assembled payload compute would use', async () => {
    await preflight(ops.token, { inputs: { volatility: 0.55 } });
    const payload = state.lastValidatePayload as {
      params: Record<string, unknown>;
      inputs: Record<string, unknown>;
    };
    // Params from the DB, engine inputs from the financial model, plus the
    // caller's explicit override.
    expect(payload.params.weight_income).toBe(1);
    expect(payload.inputs.shares_outstanding_common).toBe(8_000_000);
    expect(payload.inputs.volatility).toBe(0.55);
  });

  it('scopes a per-approach preflight to that approach', async () => {
    await preflight(ops.token, { approach: 'income' });
    expect(state.lastValidatePayload?.recompute).toEqual(['income']);
  });

  it('persists nothing — preflight is a dry run', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM calculations WHERE valuation_id = $1', [
      valuationId,
    ]);
    await preflight(ops.token);
    const after = await pool.query('SELECT count(*)::int AS n FROM calculations WHERE valuation_id = $1', [
      valuationId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('is operations-only', async () => {
    const res = await preflight(client.token);
    expect(res.statusCode).toBe(403);
  });

  it('404s for an unknown valuation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations/01JZZZZZZZZZZZZZZZZZZZZZZZ/calculations/preflight',
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  describe('diagnostics on the calculation record', () => {
    it('stores engine warnings with a successful run', async () => {
      state.computeShouldFail = false;
      state.computeWarnings = [WARNING];
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const calculation = res.json().calculation;
      expect(calculation.status).toBe('succeeded');
      expect(calculation.diagnostics).toHaveLength(1);
      expect(calculation.diagnostics[0]).toMatchObject({
        code: 'high_discount',
        field: 'params.dlom',
        severity: 'warning',
      });
    });

    it('stores the blocking errors with a failed run and returns them to the caller', async () => {
      state.computeShouldFail = true;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.issues.map((i: EngineIssue) => i.field)).toEqual([
        'inputs.volatility',
        'inputs.market.metric',
      ]);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
      });
      const failed = list.json().calculations.find((c: { status: string }) => c.status === 'failed');
      expect(failed.diagnostics).toHaveLength(2);
      expect(failed.diagnostics[0].severity).toBe('error');
      state.computeShouldFail = false;
    });
  });
});
