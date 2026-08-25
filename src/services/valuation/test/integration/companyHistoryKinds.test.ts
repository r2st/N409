import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, findValuationById } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { summaryFor } from '../../src/routes/reports.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Which of a client's engagements belong on one line.
 *
 * `sameCompanyFilter` answers "the same company", and both the report's trend
 * chart and the analytics series were treating that as the whole question. It
 * is not: `calculations.fmv_per_share` and `calculations.results` mean
 * different things depending on which engine wrote the row.
 *
 *   * The chart reads the typed column, which every engine populates because it
 *     is the column the row has. An EMI scheme valuation puts its **actual**
 *     market value there — the restricted figure, below the unrestricted value
 *     by the restriction discount — and it was plotted on a chart titled "Fair
 *     market value per common share over time" whose note calls each point a
 *     concluded FMV. A UK company that runs an EMI alongside its 409A therefore
 *     shipped a board-facing PDF showing a fall it did not have.
 *   * The analytics endpoint reads the `results` document, and every figure it
 *     derives is a 409A key. A specialty run has none of them, so it arrived as
 *     an all-null point — and as `latest`, which is the single row the whole
 *     benchmark block is computed from.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('company history is scoped to kinds that conclude the same figure', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /**
   * One engagement with one succeeded run, stamped at an explicit time so the
   * ordering the chart depends on cannot come down to insert latency.
   */
  async function engagement(args: {
    company: string;
    kind: string;
    at: string;
    fmvPerShare: number | null;
    equityValue?: number | null;
    results: Record<string, unknown>;
  }) {
    const v = await createValuation(
      ctx.pool,
      { kind: args.kind, companyName: args.company, userId: user.id, partnerId: null },
      { ...actor, actorId: user.id },
    );
    const calc = await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: args.results,
        equityValue: args.equityValue ?? null,
        fmvPerShare: args.fmvPerShare,
        createdBy: user.id,
      },
      { ...actor, actorId: user.id },
    );
    await ctx.pool.query('UPDATE calculations SET created_at = $2 WHERE id = $1', [calc.id, args.at]);
    return v;
  }

  const results409a = (fmv: number, multiples: number[] = [4, 6]) => ({
    fmv_per_share: fmv,
    equity_value: fmv * 1_000_000,
    fully_diluted_common: 1_000_000,
    discounts: { dlom: 0.3, dloc: 0.05 },
    assumptions: { volatility: 0.5 },
    approaches: { market: { weight: 1, multiples, selected_multiple: 5, equity_value: fmv * 1e6 } },
  });

  it('keeps an EMI actual market value off the 409A trend chart', async () => {
    const company = 'TrendCo UK';
    await engagement({
      company,
      kind: '409a',
      at: '2024-06-01T00:00:00Z',
      fmvPerShare: 2,
      equityValue: 2_000_000,
      results: results409a(2),
    });
    // The AMV is the restricted figure, so it lands *below* both 409A points
    // and reads on the chart as a valuation that halved and recovered.
    await engagement({
      company,
      kind: 'emi',
      at: '2025-01-15T00:00:00Z',
      fmvPerShare: 0.5,
      equityValue: 6_000_000,
      results: { kind: 'emi', specialty: { amv_per_share: 0.5, umv_per_share: 0.9 } },
    });
    const latest = await engagement({
      company,
      kind: '409a',
      at: '2026-06-01T00:00:00Z',
      fmvPerShare: 3,
      equityValue: 3_000_000,
      results: results409a(3),
    });

    const { summary } = await summaryFor(ctx.pool, (await findValuationById(ctx.pool, latest.id))!);
    const chart = summary?.charts.find((c) => c.title?.includes('Fair market value per common share'));
    expect(chart, 'the trend chart should still be drawn from the two 409A runs').toBeDefined();
    expect(chart!.points!.map((p) => p.value)).toEqual([2, 3]);
  });

  it('keeps an ESOP conclusion on it — that per-share figure is an FMV', async () => {
    // The distinction is what the column holds, not whether the engine is a
    // specialty one: an ESOP run concludes a fair market value per share, and
    // `headlineLabels('esop').perShare` says so.
    const company = 'TrendCo ESOP';
    await engagement({
      company,
      kind: '409a',
      at: '2024-06-01T00:00:00Z',
      fmvPerShare: 2,
      equityValue: 2_000_000,
      results: results409a(2),
    });
    await engagement({
      company,
      kind: 'esop',
      at: '2025-01-15T00:00:00Z',
      fmvPerShare: 2.4,
      equityValue: 8_000_000,
      results: { kind: 'esop', specialty: { fmv_per_share: 2.4 } },
    });
    const latest = await engagement({
      company,
      kind: '409a',
      at: '2026-06-01T00:00:00Z',
      fmvPerShare: 3,
      equityValue: 3_000_000,
      results: results409a(3),
    });

    const { summary } = await summaryFor(ctx.pool, (await findValuationById(ctx.pool, latest.id))!);
    const chart = summary?.charts.find((c) => c.title?.includes('Fair market value per common share'));
    expect(chart!.points!.map((p) => p.value)).toEqual([2, 2.4, 3]);
  });

  it('does not let a newer specialty run empty a 409A benchmark', async () => {
    const company = 'AnalyticsCo UK';
    const target = await engagement({
      company,
      kind: '409a',
      at: '2026-01-01T00:00:00Z',
      fmvPerShare: 3,
      equityValue: 3_000_000,
      results: results409a(3, [3, 5, 7, 9]),
    });
    // Newer than the 409A, so it was `latest` — the one row the comparable set,
    // the company multiple and the percentile are all read from.
    await engagement({
      company,
      kind: 'ifrs2',
      at: '2026-05-01T00:00:00Z',
      fmvPerShare: null,
      equityValue: 420_000,
      results: { kind: 'ifrs2', specialty: { total_expense: 420_000 } },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${target.id}/analytics`,
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    const { analytics } = res.json();
    expect(analytics.count).toBe(1);
    expect(analytics.series.map((p: { fmv_per_share: number | null }) => p.fmv_per_share)).toEqual([3]);
    expect(analytics.benchmark.count).toBe(4);
    expect(analytics.benchmark.median).toBeCloseTo(6, 6);
    expect(analytics.benchmark.company_multiple).toBeCloseTo(5, 6);
    expect(analytics.benchmark.percentile).not.toBeNull();
  });
});
