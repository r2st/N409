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
});
