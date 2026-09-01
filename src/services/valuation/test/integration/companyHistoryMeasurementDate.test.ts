import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, findValuationById } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { summaryFor } from '../../src/routes/reports.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * A client's history is dated by when each valuation was made *as of*, not by
 * when the engine last ran.
 *
 * Both surfaces that draw the history — the report's trend chart and the
 * analytics series — ordered and labelled their points by `calculations.
 * created_at`. That is the moment the arithmetic was done, and it moves:
 * recalculating last year's engagement after this year's has run reseats it as
 * the newest point. On the chart that is a signed PDF plotting a client's
 * history backwards under a caption reading "oldest first", with a date under
 * each marker that the valuation it names was not made as of. In the analytics
 * bundle it is worse than a label, because `buildAnalytics` reads `first` and
 * `last` off the ends of the list and takes the whole benchmark block from the
 * final row.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('company history is dated by the measurement date', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const results409a = (fmv: number, multiples: number[] = [4, 6]) => ({
    fmv_per_share: fmv,
    equity_value: fmv * 1_000_000,
    fully_diluted_common: 1_000_000,
    discounts: { dlom: 0.3, dloc: 0.05 },
    assumptions: { volatility: 0.5 },
    approaches: { market: { weight: 1, multiples, selected_multiple: 5, equity_value: fmv * 1e6 } },
  });

  /** One 409A whose measurement date and run timestamp are set independently. */
  async function engagement(args: {
    company: string;
    /** `inputs.valuation_date` — the date the valuation is made as of. */
    valuationDate: string | null;
    /** `calculations.created_at` — when the engine ran. */
    ranAt: string;
    fmvPerShare: number;
    multiples?: number[];
  }) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: args.company, userId: user.id, partnerId: null },
      { ...actor, actorId: user.id },
    );
    const calc = await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: args.valuationDate === null ? {} : { valuation_date: args.valuationDate },
        results: results409a(args.fmvPerShare, args.multiples),
        equityValue: args.fmvPerShare * 1_000_000,
        fmvPerShare: args.fmvPerShare,
        createdBy: user.id,
      },
      { ...actor, actorId: user.id },
    );
    await ctx.pool.query('UPDATE calculations SET created_at = $2 WHERE id = $1', [calc.id, args.ranAt]);
    return v;
  }

  const trendChart = async (valuationId: string) => {
    const { summary } = await summaryFor(ctx.pool, (await findValuationById(ctx.pool, valuationId))!);
    return summary?.charts.find((c) => c.title?.includes('Fair market value per common share'));
  };

  it('plots a recalculated prior year in its own place, labelled with its own date', async () => {
    const company = 'RecalcCo';
    // FY2024, recalculated *after* the FY2025 run — a review finding, a
    // corrected share count. Its run timestamp is now the newest of the three.
    await engagement({
      company,
      valuationDate: '2024-12-31',
      ranAt: '2026-04-01T00:00:00Z',
      fmvPerShare: 1.5,
    });
    await engagement({
      company,
      valuationDate: '2023-12-31',
      ranAt: '2024-02-10T00:00:00Z',
      fmvPerShare: 1,
    });
    const latest = await engagement({
      company,
      valuationDate: '2025-12-31',
      ranAt: '2026-05-01T00:00:00Z',
      fmvPerShare: 2,
    });

    const chart = await trendChart(latest.id);
    expect(chart).toBeDefined();
    expect(chart!.points!.map((p) => p.value)).toEqual([1, 1.5, 2]);
    expect(chart!.points!.map((p) => p.label)).toEqual(['2023-12-31', '2024-12-31', '2025-12-31']);
  });

  it('falls back to the run date for a calculation that recorded none', async () => {
    const company = 'NoDateCo';
    await engagement({ company, valuationDate: null, ranAt: '2024-03-04T00:00:00Z', fmvPerShare: 1 });
    const latest = await engagement({
      company,
      valuationDate: '2025-12-31',
      ranAt: '2026-01-05T00:00:00Z',
      fmvPerShare: 2,
    });

    const chart = await trendChart(latest.id);
    expect(chart!.points!.map((p) => p.label)).toEqual(['2024-03-04', '2025-12-31']);
    expect(chart!.points!.map((p) => p.value)).toEqual([1, 2]);
  });

  it('ignores a measurement date that is not a calendar day', async () => {
    const company = 'JunkDateCo';
    await engagement({
      company,
      valuationDate: 'last Tuesday',
      ranAt: '2024-03-04T00:00:00Z',
      fmvPerShare: 1,
    });
    const latest = await engagement({
      company,
      valuationDate: '2025-12-31',
      ranAt: '2026-01-05T00:00:00Z',
      fmvPerShare: 2,
    });

    const chart = await trendChart(latest.id);
    expect(chart!.points!.map((p) => p.label)).toEqual(['2024-03-04', '2025-12-31']);
  });

  it('seats the analytics benchmark on the latest measurement date, not the latest run', async () => {
    const company = 'AnalyticsRecalcCo';
    const target = await engagement({
      company,
      valuationDate: '2025-12-31',
      ranAt: '2026-01-10T00:00:00Z',
      fmvPerShare: 2,
      multiples: [3, 5, 7, 9],
    });
    // The prior year, recalculated afterwards: newer by `created_at`, older by
    // the date it is made as of.
    await engagement({
      company,
      valuationDate: '2024-12-31',
      ranAt: '2026-04-01T00:00:00Z',
      fmvPerShare: 1,
      multiples: [10, 12],
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${target.id}/analytics`,
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.series.map((p: { as_of: string }) => p.as_of)).toEqual(['2024-12-31', '2025-12-31']);
    expect(analytics.series.map((p: { fmv_per_share: number }) => p.fmv_per_share)).toEqual([1, 2]);
    expect(analytics.trends.fmv_per_share.first).toBe(1);
    expect(analytics.trends.fmv_per_share.last).toBe(2);
    expect(analytics.benchmark.comparable_multiples).toEqual([3, 5, 7, 9]);
  });
});
