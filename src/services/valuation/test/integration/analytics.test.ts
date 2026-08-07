import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

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

  async function seed(
    company: string,
    fmv: number,
    dlom: number,
    multiples: number[],
    owner: { id: string; partnerId?: string } = ops,
  ) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: owner.id, partnerId: owner.partnerId ?? null },
      { ...actor, actorId: owner.id },
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
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
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

  /**
   * The benchmark has to say where the company sits in its own comparable set,
   * and that depends entirely on which multiple you call "the company's". The
   * engine's market approach applies the median and records it as
   * `selected_multiple`; this endpoint used the mean, which on the skewed set
   * every real comp group is put the company near the top of a range it is in
   * the middle of.
   */
  it('benchmarks against the multiple the market approach applied', async () => {
    const skewed = [4, 5, 6, 7, 28]; // median 6, mean 10
    const v = await seed('SkewedComps Inc', 4.0, 0.3, skewed);
    await ctx.pool.query(
      `UPDATE calculations
          SET results = jsonb_set(results, '{approaches,market,selected_multiple}', '6')
        WHERE valuation_id = $1`,
      [v.id],
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/analytics`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.benchmark.company_multiple).toBeCloseTo(6, 6);
    expect(analytics.benchmark.percentile).toBeCloseTo(0.5, 6);
    expect(analytics.series[0].market_multiple).toBeCloseTo(6, 6);
  });

  /**
   * A firm's client is the firm's, not the seat's.
   *
   * The series used to be scoped to `user_id`, so two engagements for one
   * company opened by two members of the same firm looked like two unrelated
   * companies — while the firm console, which groups on `(partner_id,
   * company_name)`, showed them as one client with two engagements. The report's
   * trend chart shares this predicate and is suppressed below two points, so the
   * deliverable quietly dropped the year-on-year comparison.
   */
  it('joins a firm’s engagements for one client across its members', async () => {
    const firmId = await seedPartner(ctx, `Bridge Advisors ${Date.now()}`);
    const memberA = await seedUser(ctx, { roles: ['member'], partnerId: firmId });
    const memberB = await seedUser(ctx, { roles: ['member'], partnerId: firmId });

    await seed('FirmWide Robotics', 1.5, 0.3, [4], { id: memberA.id, partnerId: firmId });
    const thisYear = await seed('FirmWide Robotics', 2.25, 0.28, [5], {
      id: memberB.id,
      partnerId: firmId,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${thisYear.id}/analytics`,
      headers: authHeader(memberB.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.count).toBe(2);
    expect(analytics.series.map((p: { fmv_per_share: number }) => p.fmv_per_share)).toEqual([1.5, 2.25]);
  });

  it('never joins one firm’s client to another firm’s same-named client', async () => {
    const firmOne = await seedPartner(ctx, `Firm One ${Date.now()}`);
    const firmTwo = await seedPartner(ctx, `Firm Two ${Date.now()}`);
    const one = await seedUser(ctx, { roles: ['member'], partnerId: firmOne });
    const two = await seedUser(ctx, { roles: ['member'], partnerId: firmTwo });

    await seed('Collision Corp', 9.99, 0.3, [4], { id: two.id, partnerId: firmTwo });
    const mine = await seed('Collision Corp', 1.11, 0.3, [4], { id: one.id, partnerId: firmOne });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${mine.id}/analytics`,
      headers: authHeader(one.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.count).toBe(1);
    expect(analytics.series[0].fmv_per_share).toBe(1.11);
  });

  it('keeps a direct client scoped to its own owner', async () => {
    const other = await seedUser(ctx, { roles: ['valuation_user'] });
    await seed('Unpartnered Inc', 7.77, 0.3, [4], { id: other.id });
    const mine = await seed('Unpartnered Inc', 1.23, 0.3, [4]);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${mine.id}/analytics`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.count).toBe(1);
    expect(analytics.series[0].fmv_per_share).toBe(1.23);
  });
});
