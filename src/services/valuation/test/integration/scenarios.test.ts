import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('improvement 3 — client what-if scenario sandbox', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  let lastEnginePayload: Record<string, any> | null = null;
  let engineShouldFail = false;

  const BASE_INPUTS = {
    income: { discount_rate: 0.25, terminal_growth: 0.03, free_cash_flows: [100_000, 200_000] },
    market: { metric: 5_000_000, multiples: [4, 6] },
    volatility: 0.6,
    shares_outstanding_common: 10_000_000,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/compute', async (req, reply) => {
      lastEnginePayload = req.body as Record<string, any>;
      if (engineShouldFail) {
        return reply.status(422).send({ detail: 'income.discount_rate must exceed terminal_growth' });
      }
      // Value tracks the discount rate so scenario deltas are observable.
      const dr = lastEnginePayload.inputs?.income?.discount_rate ?? 0.25;
      const equity = Math.round(20_000_000 * (0.25 / dr));
      return reply.send({
        engine_version: 'py-stub',
        results: { equity_value: equity, fmv_per_share: equity / 10_000_000, approaches: {} },
      });
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

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    otherClient = await seedUser(seedCtx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'SandboxCo' },
    });
    valuationId = created.json().valuation.id;

    // Official baseline calculation (ops-only route) the sandbox clones from.
    const calc = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: { inputs: BASE_INPUTS },
    });
    expect(calc.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  it('boots the sandbox with the baseline numbers and current knob values', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/scenarios/baseline`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseline.equity_value).toBe(20_000_000);
    expect(body.defaults).toMatchObject({
      revenue: 5_000_000,
      growth_rate: 0.03,
      discount_rate: 0.25,
      multiples: [4, 6],
    });
    expect(body.approaches).toEqual({
      asset: false,
      opm_backsolve: false,
      income: false,
      market: false,
    });
  });

  it('previews a scenario for the client without persisting anything', async () => {
    const before = await pool.query(
      'SELECT (SELECT count(*) FROM calculations WHERE valuation_id = $1) AS calcs, (SELECT count(*) FROM valuation_events WHERE valuation_id = $1) AS events',
      [valuationId],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/scenarios/preview`,
      headers: authHeader(client.token),
      payload: { discount_rate: 0.5, growth_rate: 0.05, revenue: 8_000_000, multiples: [5, 7, 9] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Halving via 2× discount rate: 20M baseline → 10M scenario.
    expect(body.scenario.equity_value).toBe(10_000_000);
    expect(body.baseline.equity_value).toBe(20_000_000);
    expect(body.delta.equity_value).toBe(-10_000_000);

    // The overrides land on the engine payload, merged over the baseline run.
    expect(lastEnginePayload?.inputs.income).toMatchObject({
      discount_rate: 0.5,
      terminal_growth: 0.05,
      free_cash_flows: [100_000, 200_000],
    });
    expect(lastEnginePayload?.inputs.market).toMatchObject({ metric: 8_000_000, multiples: [5, 7, 9] });
    expect(lastEnginePayload?.inputs.volatility).toBe(0.6);
    expect(lastEnginePayload?.recompute ?? null).toBeNull();

    // Read-only: no calculation row, no audit event.
    const after = await pool.query(
      'SELECT (SELECT count(*) FROM calculations WHERE valuation_id = $1) AS calcs, (SELECT count(*) FROM valuation_events WHERE valuation_id = $1) AS events',
      [valuationId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('is scoped to people who can read the valuation', async () => {
    for (const [method, url] of [
      ['GET', `/api/v1/valuations/${valuationId}/scenarios/baseline`],
      ['POST', `/api/v1/valuations/${valuationId}/scenarios/preview`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authHeader(otherClient.token),
        ...(method === 'POST' ? { payload: { discount_rate: 0.3 } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('explains when there is no calculation to sandbox yet', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'FreshCo' },
    });
    const freshId = created.json().valuation.id;

    const boot = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${freshId}/scenarios/baseline`,
      headers: authHeader(client.token),
    });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().baseline).toBeNull();

    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${freshId}/scenarios/preview`,
      headers: authHeader(client.token),
      payload: { discount_rate: 0.3 },
    });
    expect(preview.statusCode).toBe(422);
  });

  /**
   * A specialty run in place of a 409A one.
   *
   * The sandbox clones a compute payload — `{ params, inputs }` carrying a
   * discount rate, a terminal growth rate, revenue and multiples — and moves
   * one dial. A specialty engine stores `inputs = { endpoint, ...body }` and
   * has none of those, so taking simply the newest succeeded run read `{}` off
   * it and served a *full* sandbox: empty knobs for assumptions the run never
   * used, over a baseline card printing the specialty headline (on an EMI run,
   * the restricted AMV) as "Scenario FMV / share". Moving a knob then posted
   * `params: {}` to the compute endpoint.
   *
   * The refusal has to say which of the two things is true, because they take
   * opposite actions: "run a calculation" versus "this report type has no such
   * assumptions". Telling a client to check back once the valuation is drafted,
   * when it is drafted and calculated, is an instruction to wait for something
   * that already happened.
   */
  it('refuses to sandbox a specialty run, and says why rather than asking for one', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: 'emi', company_name: 'AmvCo' },
    });
    const emiId = created.json().valuation.id;
    await createCalculation(
      pool,
      {
        valuationId: emiId,
        engineVersion: 'stub-9.9.9',
        status: 'succeeded',
        inputs: { endpoint: '/engine/v1/emi-csop', inputs: { equity_value: 1_000_000 } },
        results: { kind: 'emi', specialty: { amv_per_share: 0.42, umv_per_share: 1.1 } },
        equityValue: 1_000_000,
        fmvPerShare: 0.42,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );

    const boot = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${emiId}/scenarios/baseline`,
      headers: authHeader(client.token),
    });
    expect(boot.statusCode).toBe(200);
    // No baseline, and above all not the 0.42 AMV captioned as an FMV.
    expect(boot.json().baseline).toBeNull();
    expect(boot.json().defaults).toBeNull();
    expect(JSON.stringify(boot.json())).not.toContain('0.42');
    // The kind, named the way the picker names it — and not the wording that
    // asks for a calculation that has already been run.
    expect(boot.json().unavailable_reason).toContain('EMI');
    expect(boot.json().unavailable_reason).not.toContain('check back');

    for (const [method, url, payload] of [
      ['POST', `/api/v1/valuations/${emiId}/scenarios/preview`, { discount_rate: 0.3 }],
      ['POST', `/api/v1/valuations/${emiId}/scenarios`, { name: 'Downside', discount_rate: 0.3 }],
    ] as const) {
      const res = await app.inject({ method, url, headers: authHeader(client.token), payload });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('EMI');
    }
  });

  it('still asks for a calculation when there genuinely is none', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'BarrenCo' },
    });
    const id = created.json().valuation.id;
    const boot = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/scenarios/baseline`,
      headers: authHeader(client.token),
    });
    expect(boot.json().unavailable_reason).toContain('check back');
  });

  it('rejects out-of-range knobs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/scenarios/preview`,
      headers: authHeader(client.token),
      payload: { discount_rate: -0.1 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('surfaces engine rejections as readable problems', async () => {
    engineShouldFail = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/scenarios/preview`,
        headers: authHeader(client.token),
        payload: { growth_rate: 0.9 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('discount_rate');
    } finally {
      engineShouldFail = false;
    }
  });
});
