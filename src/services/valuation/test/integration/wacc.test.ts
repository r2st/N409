import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The discount-rate build-up (migration 0135) — previewed, and applied.
 *
 * Three behaviours carry the claim this feature makes:
 *
 *   * recording a build-up and adopting it are separate, so a build-up held on
 *     the engagement while an analyst decides cannot move a discount rate
 *     somebody has already reviewed;
 *   * the preview reads the *stored* build-up rather than the request body, so
 *     it cannot show a rate the calculation would not reproduce;
 *   * the calculation hands the engine `inputs.wacc` and the `auto_wacc` flag
 *     only when both conditions hold — which is what makes `results.auto.wacc`
 *     exist, and Appendix I render at all.
 */

/** Stands in for the engine: records what each endpoint was handed. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let lastCompute: Record<string, unknown> = {};
  let lastWacc: Record<string, unknown> | null = null;

  stub.get('/engine/v1/health', async () => ({ engine_version: 'stub-1' }));

  stub.post('/engine/v1/compute', async (req) => {
    lastCompute = req.body as Record<string, unknown>;
    return {
      engine_version: 'stub-1',
      results: { equity_value: 10_000_000, fmv_per_share: 1.0, approaches: {} },
      warnings: [],
    };
  });

  // Mirrors engine/wacc.py closely enough for the route's contract: a CAPM
  // build-up, a blend, and the guideline set it was struck on.
  stub.post('/engine/v1/wacc', async (req) => {
    const body = req.body as { inputs?: Record<string, unknown> };
    lastWacc = body.inputs ?? {};
    const betas = (lastWacc.comparable_betas ?? []) as Array<{ ticker?: string; beta: number }>;
    return {
      wacc: 0.1834,
      cost_of_equity: 0.2012,
      cost_of_debt: 0.08,
      after_tax_cost_of_debt: 0.0632,
      capm: {
        risk_free_rate: 0.042,
        beta_unlevered: 1.05,
        beta_relevered: 1.24,
        equity_risk_premium: 0.055,
        size_premium: 0.0537,
        size_tier: 'micro-cap',
        company_specific_premium: 0.03,
      },
      weights: { equity: 0.8, debt: 0.2 },
      tax_rate: 0.21,
      comparables: betas.map((b) => ({ ticker: b.ticker, beta: b.beta, unlevered: b.beta * 0.9 })),
    };
  });

  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    compute: () => lastCompute,
    wacc: () => lastWacc,
    resetWacc: () => {
      lastWacc = null;
    },
  };
}

const BUILD_UP = {
  comparable_betas: [
    { ticker: 'AAA', name: 'Alpha Corp', beta: 1.2, debt_to_equity: 0.25 },
    { ticker: 'BBB', beta: 0.9 },
  ],
  target_debt_to_equity: 0.3,
  market_cap: 40_000_000,
  tax_rate: 0.21,
  equity_risk_premium: 0.055,
  forecast_horizon_years: 5,
  company_specific_premium: 0.03,
  cost_of_debt: 0.08,
};

describe.skipIf(!dbUp)('discount-rate build-up', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const patchParams = (payload: Record<string, unknown>, token = ops.token) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(token),
      payload,
    });

  const previewRate = (token = ops.token, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/wacc/preview`,
      headers: authHeader(token),
      payload,
    });

  const compute = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: {},
    });

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'DiscountCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  it('is invisible to someone who cannot read the engagement', async () => {
    expect((await previewRate(stranger.token)).statusCode).toBe(404);
  });

  it('is closed to the engagement owner, who does not build discount rates', async () => {
    expect((await previewRate(client.token)).statusCode).toBe(403);
  });

  it('refuses to preview a rate before a build-up has been entered', async () => {
    const res = await previewRate();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('No WACC build-up');
  });

  it('computes exactly as before while no build-up exists', async () => {
    // The regression that would matter most: a new column that quietly changed
    // what an untouched engagement computes.
    expect((await compute()).statusCode).toBe(201);
    expect(engine.compute().auto_wacc).toBeUndefined();
    expect((engine.compute().inputs as Record<string, unknown>).wacc).toBeUndefined();
  });

  it('refuses the switch with no build-up under it', async () => {
    const res = await patchParams({ auto_wacc: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('before switching it on');
  });

  it('refuses a build-up the engine could not strike a beta from', async () => {
    const res = await patchParams({ wacc_inputs: { target_debt_to_equity: 0.3 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('beta');
  });

  it('records a build-up without adopting it', async () => {
    const res = await patchParams({ wacc_inputs: BUILD_UP });
    expect(res.statusCode).toBe(200);
    expect(res.json().params.auto_wacc).toBe(false);
    expect(res.json().params.wacc_inputs.target_debt_to_equity).toBe(0.3);
  });

  it('previews the rate off the stored build-up, and says it is not applied', async () => {
    const res = await previewRate();
    expect(res.statusCode).toBe(200);
    expect(res.json().wacc.wacc).toBeCloseTo(0.1834, 6);
    expect(res.json().applied_on_next_run).toBe(false);
    expect(engine.wacc()?.target_debt_to_equity).toBe(0.3);
  });

  it('ignores a build-up posted in the request body', async () => {
    /*
     * The whole value of the preview. A body-driven preview would show a rate
     * off numbers that were never saved, and the calculation would then produce
     * a different one from the numbers that were.
     */
    engine.resetWacc();
    const res = await previewRate(ops.token, {
      wacc_inputs: { unlevered_beta_input: 4.0, equity_risk_premium: 0.2 },
    });
    expect(res.statusCode).toBe(200);
    expect(engine.wacc()?.unlevered_beta_input).toBeUndefined();
    expect(engine.wacc()?.comparable_betas).toHaveLength(2);
  });

  it('keeps a recorded-but-unadopted build-up out of the calculation', async () => {
    expect((await compute()).statusCode).toBe(201);
    expect(engine.compute().auto_wacc).toBeUndefined();
    expect((engine.compute().inputs as Record<string, unknown>).wacc).toBeUndefined();
  });

  it('hands the engine the build-up and the flag once it is adopted', async () => {
    expect((await patchParams({ auto_wacc: true })).statusCode).toBe(200);
    expect((await compute()).statusCode).toBe(201);

    expect(engine.compute().auto_wacc).toBe(true);
    const wacc = (engine.compute().inputs as { wacc?: Record<string, unknown> }).wacc;
    expect(wacc?.equity_risk_premium).toBe(0.055);
    // The guideline set travels whole, not as the median it implies — a median
    // cannot be re-struck on a corrected input or checked against a source.
    expect(wacc?.comparable_betas).toHaveLength(2);
  });

  it('says the preview would reach the discount rate once it is adopted', async () => {
    expect((await previewRate()).json().applied_on_next_run).toBe(true);
  });

  it('stops sending the build-up when it is switched back off', async () => {
    expect((await patchParams({ auto_wacc: false })).statusCode).toBe(200);
    expect((await compute()).statusCode).toBe(201);
    expect(engine.compute().auto_wacc).toBeUndefined();
    expect((engine.compute().inputs as Record<string, unknown>).wacc).toBeUndefined();
  });
});
