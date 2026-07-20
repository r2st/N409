import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('valuation analytics endpoint (feature 5)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seed(company: string, fmv: number, dlom: number, multiples: number[]) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: ops.id },
      { ...actor, actorId: ops.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: {
          fmv_per_share: fmv,
          equity_value: fmv * 1_000_000,
          discounts: { dlom },
          assumptions: { volatility: 0.5 },
          approaches: { market: { multiples } },
        },
        equityValue: fmv * 1_000_000,
        fmvPerShare: fmv,
        createdBy: ops.id,
      },
      { ...actor, actorId: ops.id },
    );
    return v;
  }

  it('returns a company-wide series and benchmark', async () => {
    await seed('AnalyticsCo', 2.0, 0.3, [4, 6]);
    const newer = await seed('AnalyticsCo', 3.0, 0.25, [3, 5, 7, 9]);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${newer.id}/analytics`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.count).toBe(2);
    expect(analytics.series.map((p: { fmv_per_share: number }) => p.fmv_per_share)).toEqual([2.0, 3.0]);
    expect(analytics.benchmark.count).toBe(4);
    expect(analytics.benchmark.median).toBeCloseTo(6, 6);
    expect(analytics.series[0].valuation_number).toBeTruthy();
  });
});
