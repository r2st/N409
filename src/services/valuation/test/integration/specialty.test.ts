import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createCalculation } from '../../src/repos/calculations.js';
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
    engineStub.post('/engine/v1/fair-value-820', async (req) => {
      const inputs = (req.body as Record<string, any>).inputs;
      const total = (inputs.positions as Array<{ fair_value: number }>).reduce(
        (sum, p) => sum + p.fair_value,
        0,
      );
      return {
        by_level: { level_1: total, level_2: 0, level_3: 0 },
        total_fair_value: total,
        predominant_level: 'level_1',
        unobservable_inputs: [],
      };
    });
    engineStub.post('/engine/v1/gift-estate', async (req) => {
      const inputs = (req.body as Record<string, any>).inputs;
      const proRata = inputs.entity_value * (inputs.percent_interest / 100);
      const concluded = proRata * (1 - (inputs.dloc ?? 0)) * (1 - (inputs.dlom ?? 0));
      return {
        entity_value: inputs.entity_value,
        pro_rata_value: proRata,
        concluded_value: concluded,
        taxable_gift: concluded,
        rev_rul_59_60: { addressed_count: 0, total_count: 8, unaddressed: [] },
      };
    });
    engineStub.post('/engine/v1/ifrs2', async (req) => {
      const inputs = (req.body as Record<string, any>).inputs;
      const perAward = 4.0;
      return {
        settlement: inputs.settlement,
        vesting_condition: inputs.vesting_condition,
        fair_value_per_award: perAward,
        total_expense: perAward * (inputs.options_granted ?? 0),
        expense_schedule: [],
        remeasurement: { required: inputs.settlement === 'cash_settled' },
      };
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
      // What VAL230 asks for on top of the valuation inputs.
      company_registration_number: '09876543',
      registered_office_address: '1 Example Street, London, EC1A 1BB',
      share_class: 'Ordinary shares of £0.0001 each',
      proposed_grant_date: '2026-10-01',
      share_restrictions: 'Bad-leaver forfeiture; transfers require board consent.',
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

  /**
   * A 409A-shaped run landing after a specialty one, on the same valuation.
   *
   * `calculations` holds both shapes. Nothing stops an ESOP or EMI engagement
   * from also using the Calculations tab's ordinary compute — the button is
   * offered on every kind — and that row is newer without being a specialty
   * result. This handler used to ask for the newest succeeded run of *any*
   * shape and then read `results.specialty` off it, so a later 409A run made
   * the tab report "No result yet · Run the engine to produce the calculation
   * this report type's exhibits are built from" directly above a run history
   * listing the succeeded specialty run it had just discarded. The history has
   * always filtered to specialty runs; the latest-result lookup now asks the
   * same question.
   */
  it('keeps serving the specialty result after a 409A run lands on top of it', async () => {
    const id = await createValuation('esop');
    await saveAnswers(id, {
      equity_value: 8_000_000,
      shares_outstanding: 1_000_000,
      value_basis: 'control',
      esop_share_balance: 100_000,
    });
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(run.statusCode).toBe(201);

    // The ordinary pipeline's shape, written by the same repo function the
    // compute route uses, and newer.
    await createCalculation(
      pool,
      {
        valuationId: id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { approaches: { income: { equity_value: 9_000_000, weight: 1 } } },
        equityValue: 9_000_000,
        fmvPerShare: 9,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );

    const latest = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
    });
    expect(latest.statusCode).toBe(200);
    const body = latest.json();
    // The specialty result is still the one served, and it is the specialty
    // run's own calculation row beside it — not the 409A row's figures.
    expect(body.result.fmv_per_share).toBeCloseTo(6);
    expect(body.calculation.results.kind).toBe('esop');
    expect(Number(body.calculation.fmv_per_share)).toBeCloseTo(6);
    // And the two never disagree: a served result means a non-empty history.
    expect(body.history.length).toBeGreaterThan(0);
    expect(body.history.some((h: { id: string }) => h.id === body.calculation.id)).toBe(true);
  });

  /*
   * The VAL231 pack, one ordinary compute later.
   *
   * `loadHmrcForm` reads the UMV/AMV pair off `results.specialty` and the
   * Schedule 5 facts off `inputs.params` — both written only by the EMI engine
   * run. Taking simply the newest succeeded run meant a 409A compute on the
   * same engagement (the Calculations tab offers it on every kind) shadowed
   * that run: neither shape matched, both projections came back null, and the
   * form reported the two figures HMRC is being asked to agree as *not
   * supplied* — while the analyst looking at the specialty tab could see the
   * engine had produced them.
   */
  it('builds the HMRC pack off the EMI run after a 409A compute lands on top', async () => {
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
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/specialty`,
          headers: authHeader(ops.token),
          payload: {},
        })
      ).statusCode,
    ).toBe(201);

    await createCalculation(
      pool,
      {
        valuationId: id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { approaches: { income: { equity_value: 2_000_000, weight: 1 } } },
        equityValue: 2_000_000,
        fmvPerShare: 20,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/hmrc-form`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const form = res.json().form;
    const fields = new Map(
      (form.sections as Array<{ fields: Array<{ key: string; value: string | null }> }>)
        .flatMap((s) => s.fields)
        .map((f) => [f.key, f.value]),
    );
    // The stub prices UMV at equity/shares and AMV at 90% of it.
    expect(fields.get('umv_per_share')).toContain('10.00');
    expect(fields.get('amv_per_share')).toContain('9.00');
    // And the Schedule 5 facts off the same run's params, not a 409A row's.
    expect(fields.get('employee_count')).toBe('40');
    expect(form.missing_required).not.toContain('Unrestricted market value (UMV) per share');
    expect(form.missing_required).not.toContain('Actual market value (AMV) per share');
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

  /**
   * ASC 820, gift & estate and IFRS 2 had questionnaires but no dispatch, so
   * each fell through to the 409A allocation. These check that each now
   * reaches its own endpoint and stores the figure its deliverable concludes.
   */
  it('runs an ASC 820 measurement against the fair-value endpoint', async () => {
    const id = await createValuation('820');
    await saveAnswers(id, {
      fund_name: 'Example Growth Fund II',
      measurement_date: '2026-06-30',
      fair_value_level: 'level_3',
    });
    engineRequests.length = 0;
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: {
        inputs: {
          positions: [
            { name: 'Listed', fair_value: 1_000_000, level: 'level_1' },
            { name: 'Private', fair_value: 4_000_000, level: 'level_3' },
          ],
        },
      },
    });
    expect(run.statusCode).toBe(201);
    const sent = engineRequests.find((r) => r.url === '/engine/v1/fair-value-820')!;
    expect(sent).toBeTruthy();
    expect((sent.body as Record<string, any>).inputs.measurement_date).toBe('2026-06-30');

    const { calculation, result } = run.json();
    expect(result.total_fair_value).toBe(5_000_000);
    // The measurement total, and no per-share figure — an ASC 820 engagement
    // values positions, not shares.
    expect(Number(calculation.equity_value)).toBe(5_000_000);
    expect(calculation.fmv_per_share).toBeNull();
  });

  it('422s an ASC 820 run with no position schedule', async () => {
    const id = await createValuation('820');
    await saveAnswers(id, { measurement_date: '2026-06-30', fair_value_level: 'level_3' });
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(run.statusCode).toBe(422);
    expect(run.json().detail).toMatch(/position schedule/);
  });

  it('runs a gift & estate valuation and stores the transferred interest', async () => {
    const id = await createValuation('gifts');
    await saveAnswers(id, {
      transfer_date: '2026-04-15',
      transfer_type: 'gift',
      interest_transferred: 'A 25% non-voting membership interest.',
      percent_interest: 25,
      dloc: 0.2,
      dlom: 0.3,
    });
    engineRequests.length = 0;
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: { inputs: { entity_value: 10_000_000 } },
    });
    expect(run.statusCode).toBe(201);
    const sent = engineRequests.find((r) => r.url === '/engine/v1/gift-estate')!;
    expect((sent.body as Record<string, any>).inputs.percent_interest).toBe(25);

    const { calculation, result } = run.json();
    // 2,500,000 × 0.80 × 0.70 — multiplicative, not a 50% haircut.
    expect(result.concluded_value).toBeCloseTo(1_400_000);
    // The interest, not the 10m entity value it was derived from.
    expect(Number(calculation.equity_value)).toBeCloseTo(1_400_000);
    expect(calculation.fmv_per_share).toBeNull();
  });

  it('runs an IFRS 2 award and carries the settlement through', async () => {
    const id = await createValuation('ifrs2');
    await saveAnswers(id, {
      grant_date: '2026-01-01',
      settlement: 'cash_settled',
      vesting_condition: 'market',
      vesting_years: 4,
      exercise_price: 10,
      share_price: 12,
      options_granted: 100_000,
      expected_term_years: 4,
      expected_volatility: 0.6,
      risk_free_rate: 0.04,
    });
    engineRequests.length = 0;
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/specialty`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(run.statusCode).toBe(201);
    const sent = engineRequests.find((r) => r.url === '/engine/v1/ifrs2')!;
    const inputs = (sent.body as Record<string, any>).inputs;
    expect(inputs.settlement).toBe('cash_settled');
    expect(inputs.vesting_condition).toBe('market');

    const { calculation, result } = run.json();
    expect(result.remeasurement.required).toBe(true);
    // The total charge; fair value per award is not a per-share figure.
    expect(Number(calculation.equity_value)).toBeCloseTo(400_000);
    expect(calculation.fmv_per_share).toBeNull();
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
