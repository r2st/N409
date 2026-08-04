import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

describe.runIf(dbUp)('ASC 718 (private + public)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(() => ctx?.teardown());

  async function seedValuation(company = 'OptCo'): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '718', company_name: company },
    });
    return created.json().valuation.id as string;
  }

  it('prices a private option grant off the concluded 409A FMV', async () => {
    const id = await seedValuation();
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 5 },
        equityValue: 5 * 10_000_000,
        fmvPerShare: 5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(ops.token),
      payload: {
        grants: [
          {
            options_granted: 100000,
            grant_date: '2026-01-01',
            vesting_months: 48,
            exercise_price: 5,
            expected_term_years: 6,
            volatility: 0.6,
            risk_free_rate: 0.04,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().asc718;
    expect(body.company_type).toBe('private');
    expect(body.options.totalCompensationCost).toBeGreaterThan(0);
    expect(body.valuation_fmv_per_share).toBe(5);
  });

  it('values a public ESPP with a lookback discount, decomposed into components', async () => {
    const id = await seedValuation('PublicCo');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(ops.token),
      payload: {
        company_type: 'public',
        default_volatility: 0.3,
        default_grant_date_fair_value: 20,
        espp: [
          {
            shares_enrolled: 50000,
            grant_date_price: 20,
            discount_pct: 0.15,
            lookback_months: 12,
            risk_free_rate: 0.03,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const espp = res.json().asc718.espp[0];
    expect(espp.components.purchaseDiscount).toBeCloseTo(3, 2);
    expect(espp.fair_value_per_share).toBeGreaterThan(3);
    expect(espp.total_fair_value).toBeGreaterThan(0);
  });

  it('values public RSUs (service, performance, market) and a relative-TSR award', async () => {
    const id = await seedValuation('RsuCo');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(ops.token),
      payload: {
        company_type: 'public',
        default_grant_date_fair_value: 50,
        default_volatility: 0.4,
        rsu: [
          { condition: 'service', units: 1000 },
          { condition: 'performance', units: 1000, expected_attainment: 1, attainment_volatility: 0.3 },
          { condition: 'market', units: 1000, hurdle_price: 60, vesting_years: 3, risk_free_rate: 0.03 },
        ],
        tsr: [
          {
            target_units: 1000,
            performance_period_years: 3,
            risk_free_rate: 0.03,
            peers: [
              { name: 'A', volatility: 0.4 },
              { name: 'B', volatility: 0.4 },
            ],
            payout_schedule: [
              { percentile: 50, payout_ratio: 1 },
              { percentile: 0, payout_ratio: 0 },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().asc718;
    expect(body.rsu).toHaveLength(3);
    expect(body.rsu[0].fairValuePerUnit).toBe(50);
    expect(body.rsu[1].condition).toBe('performance');
    expect(body.rsu[1].expectedPayoutRatio).toBeGreaterThan(0);
    expect(body.rsu[2].probabilityMet).toBeGreaterThanOrEqual(0);
    expect(body.tsr[0].totalFairValue).toBeGreaterThan(0);
  });

  it('persists and reads public-company settings', async () => {
    const id = await seedValuation('SettingsCo');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${id}/asc718/settings`,
      headers: authHeader(ops.token),
      payload: {
        company_type: 'public',
        ticker: 'ACME',
        expected_term_method: 'lattice',
        espp_discount_pct: 0.15,
        espp_lookback_months: 6,
        tsr_peer_basket: [{ name: 'A', volatility: 0.4 }],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.company_type).toBe('public');
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/asc718/settings`,
      headers: authHeader(ops.token),
    });
    expect(get.json().settings.ticker).toBe('ACME');
    expect(get.json().settings.expected_term_method).toBe('lattice');
  });

  it('rejects an empty award request', async () => {
    const id = await seedValuation('EmptyCo');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(ops.token),
      payload: { grants: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('forbids non-ops callers', async () => {
    const id = await seedValuation('ForbidCo');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(client.token),
      payload: { rsu: [{ condition: 'service', units: 10, market_price: 5 }] },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── The per-request Monte-Carlo draw budget ───────────────────────────────
  //
  // The RSU and TSR estimators are synchronous loops on a single-threaded
  // process, so their cost stalls every other request on the box — /health
  // included — and no request timeout can interrupt them. The per-award schema
  // caps multiply rather than compose (20 TSR × 50 peers × 30,000 paths is
  // 30.6 million draws), so the request as a whole has to be priced.

  it('leaves an ordinary batch scaled by exactly 1 and reports what it rests on', async () => {
    const id = await seedValuation('BudgetCo');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(ops.token),
      payload: {
        company_type: 'public',
        default_grant_date_fair_value: 50,
        default_volatility: 0.4,
        rsu: [{ condition: 'market', units: 1000, hurdle_price: 60, vesting_years: 3 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const mc = res.json().asc718.monte_carlo;
    expect(mc.scale).toBe(1);
    expect(mc.requested_draws).toBe(40_000);
    expect(mc.paths.marketConditionRsu).toBe(40_000);
    expect(mc.requested_draws).toBeLessThan(mc.draw_budget);
  });

  it('scales a batch that would otherwise stall the event loop, and says so', async () => {
    const id = await seedValuation('BigBatchCo');
    // Entirely legal under the per-award caps: 20 TSR awards, 20 peers each.
    const peers = Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, volatility: 0.4 }));
    const tsr = Array.from({ length: 20 }, () => ({
      target_units: 1000,
      performance_period_years: 3,
      risk_free_rate: 0.03,
      peers,
      payout_schedule: [
        { percentile: 75, payout_ratio: 2 },
        { percentile: 50, payout_ratio: 1 },
        { percentile: 0, payout_ratio: 0 },
      ],
    }));
    const started = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/asc718`,
      headers: authHeader(ops.token),
      payload: {
        company_type: 'public',
        default_grant_date_fair_value: 50,
        default_volatility: 0.4,
        tsr,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().asc718;
    const mc = body.monte_carlo;
    // 20 awards × 30,000 paths × 22 draws = 13.2M, over the 4M budget.
    expect(mc.requested_draws).toBe(13_200_000);
    expect(mc.scale).toBeLessThan(1);
    expect(mc.paths.relativeTsr).toBeLessThan(30_000);
    expect(mc.paths.relativeTsr).toBeGreaterThanOrEqual(1_000);
    // Scaled, not refused — every award still has a usable number.
    expect(body.tsr).toHaveLength(20);
    for (const t of body.tsr) expect(t.fairValuePerUnit).toBeGreaterThan(0);
    // The whole point: this used to be seconds of uninterruptible CPU.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

});
