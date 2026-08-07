import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { resetEngineVersionCache } from '../../src/routes/specialty.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Specialty pipeline end-to-end: kind-specific intake schema → questionnaire
 * answers → specialty run against a stubbed engine → stored calculation. The
 * stub mirrors the engine endpoints' shapes, not their maths.
 */
describe.skipIf(!dbUp)('specialty report-type pipeline', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  const engineRequests: Array<{ url: string; body: unknown }> = [];

  beforeAll(async () => {
    resetEngineVersionCache();
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.addHook('preHandler', async (req) => {
      engineRequests.push({ url: req.url, body: req.body });
    });
    engineStub.get('/engine/v1/health', async () => ({
      status: 'ok',
      engine_version: 'stub-9.9.9',
      contract: 'engine/v1',
    }));
    engineStub.post('/engine/v1/qsbs', async (req) => {
      const inputs = (req.body as Record<string, any>).inputs;
      if (!inputs.entity_type) return { statusCode: 422 };
      return {
        eligible: inputs.entity_type === 'c_corp',
        exclusion_percentage: 1,
        tests: { c_corporation: { passed: true, detail: '' } },
        failed_tests: [],
      };
    });
    engineStub.post('/engine/v1/esop', async (req) => {
      const b = req.body as Record<string, any>;
      const perShare = b.inputs.equity_value / b.inputs.shares_outstanding;
      return {
        fmv_per_share: perShare * 0.75,
        levels: {},
        ...(b.repurchase ? { repurchase_obligation: { total_obligation: 123 } } : {}),
      };
    });
    engineStub.post('/engine/v1/emi-csop', async (req) => {
      const b = req.body as Record<string, any>;
      if (typeof b.params.equity_value !== 'number') {
        return { detail: 'emi.equity_value must be a number', statusCode: 422 };
      }
      const pro = b.params.equity_value / b.params.total_shares;
      return {
        pro_rata_per_share: pro,
        umv_per_share: pro,
        amv_per_share: pro * 0.9,
        qualification: { qualifies: true, checks: {}, failed_checks: [] },
      };
    });
    engineStub.post('/engine/v1/smb', async () => ({
      methods: { sde_multiple: { equity_value: 500_000 } },
      weights: { sde_multiple: 1 },
      equity_value: 500_000,
    }));
    engineStub.post('/engine/v1/impairment', async (req) => {
      const b = req.body as Record<string, any>;
      return { standard: 'ASC 350-20', test: b.test, impaired: true, impairment_loss: 20 };
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
      EMAIL_MODE: 'off',
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

  async function createValuation(kind: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind, company_name: `${kind} Co` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id;
  }

  async function saveAnswers(id: string, answers: Record<string, unknown>): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/questionnaire`,
      headers: authHeader(client.token),
      payload: { answers },
    });
    expect(res.statusCode).toBe(200);
  }

  it('serves a kind-specific intake schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/intake/schema?kind=esop',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('esop');
    expect(body.sections.map((s: { key: string }) => s.key)).toEqual(['company', 'esop_value', 'repurchase']);
    // The default stays the 409A questionnaire.
    const def = await app.inject({
      method: 'GET',
      url: '/api/v1/intake/schema',
      headers: authHeader(client.token),
    });
    expect(def.json().sections.map((s: { key: string }) => s.key)).toContain('cap_table');
  });

  it('judges questionnaire completion against the kind form and stores kind fields', async () => {
    const id = await createValuation('csop');
    await saveAnswers(id, {
      legal_name: 'Grantco Ltd',
      state_of_incorporation: 'England',
      incorporation_date: '2019-04-01',
      industry: 'software',
      business_description: 'B2B SaaS.',
      equity_value: 5_000_000,
      total_shares: 1_000_000,
      options_granted: 10_000,
      exercise_price: 5,
      // A 409A-only field must be dropped by the kind's key filter.
      total_shares_outstanding: 999,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/questionnaire`,
      headers: authHeader(client.token),
    });
    const body = res.json();
    expect(body.kind).toBe('csop');
    expect(body.completion.ready).toBe(true);
    expect(body.answers.equity_value).toBe(5_000_000);
    expect('total_shares_outstanding' in body.answers).toBe(false);

    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/questionnaire/submit`,
      headers: authHeader(client.token),
      payload: {},
    });
    expect(submit.statusCode).toBe(200);
  });

  it('runs an ESOP valuation from intake to a stored calculation with headline figures', async () => {
    const id = await createValuation('esop');
    await saveAnswers(id, {
      equity_value: 10_000_000,
      shares_outstanding: 1_000_000,
      value_basis: 'control',
      dloc: 0.1,
      dlom: 0.15,
      esop_share_balance: 200_000,
      annual_redemption_rate: 0.08,
    });
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(run.statusCode).toBe(201);
    const { calculation, result } = run.json();
    expect(result.fmv_per_share).toBeCloseTo(7.5);
    expect(result.repurchase_obligation).toBeTruthy();
    expect(calculation.engine_version).toBe('stub-9.9.9');
    expect(Number(calculation.fmv_per_share)).toBeCloseTo(7.5);
    expect(Number(calculation.equity_value)).toBe(10_000_000);
    expect(calculation.results.kind).toBe('esop');
    expect(calculation.results.specialty.fmv_per_share).toBeCloseTo(7.5);

    const latest = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().result.fmv_per_share).toBeCloseTo(7.5);
    expect(latest.json().supported).toBe(true);
  });

  it('merges run inputs over the questionnaire answers', async () => {
    const id = await createValuation('emi');
    await saveAnswers(id, {
      equity_value: 1_000_000,
      total_shares: 100_000,
      options_granted: 1_000,
      gross_assets: 2_000_000,
      fte_employee_count: 40,
      is_independent: true,
      has_qualifying_trade: true,
      works_25_hours_or_75_pct: true,
    });
    engineRequests.length = 0;
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: { inputs: { restriction_discount: 0.2 } },
    });
    expect(run.statusCode).toBe(201);
    const sent = engineRequests.find((r) => r.url === '/engine/v1/emi-csop')!;
    const params = (sent.body as Record<string, any>).params;
    expect(params.restriction_discount).toBe(0.2);
    expect(params.employee_count).toBe(40);
  });

  it('422s a kind outside the specialty pipeline and missing assembly facts', async () => {
    const id409a = await createValuation('409a');
    const wrongKind = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id409a}/specialty`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(wrongKind.statusCode).toBe(422);

    // A goodwill run without the questionnaire's test selection cannot build.
    const goodwill = await createValuation('goodwill');
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${goodwill}/specialty`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().detail).toMatch(/impairment-test/);
  });

  it('keeps specialty runs operations-only', async () => {
    const id = await createValuation('fmv');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(client.token),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
