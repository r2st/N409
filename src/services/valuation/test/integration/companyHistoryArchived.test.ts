import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, findValuationById } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { markValuationsArchived } from '../../src/repos/retention.js';
import { restoreValuations } from '../../src/repos/valuationPurge.js';
import { summaryFor } from '../../src/routes/reports.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Retiring an engagement takes it out of the client's history, everywhere the
 * history is drawn — and putting it back brings it back.
 *
 * `archived_at` is the soft delete for a valuation, and `buildValuationWhere`
 * applies it for the ten list reads that go through it. The three surfaces
 * scoped by `sameCompanyFilter` do not go through it: each hand-writes its own
 * `FROM valuations v`, and not one of them carried an archived clause (R176).
 *
 * None of the three is a list of engagements the user is picking from, which is
 * what makes this worse than a stale roster:
 *
 *   * the report's FMV trend chart plots the retired valuation's concluded
 *     figure as a point on a **signed PDF**, under a note asserting every point
 *     is a prior valuation of this company;
 *   * the analytics series can seat it as the newest row, and the newest row is
 *     the one the whole benchmark block is computed from;
 *   * the bridge offers it as a comparison candidate, inviting a firm to
 *     explain this year's change against an engagement it withdrew.
 *
 * The retention sweep is the path that matters here. `retireValuations` also
 * suffixes the company name with ` [retired]`, which would have hidden the row
 * from these three by accident — the name stops matching. `markValuationsArchived`,
 * which is what the sweep actually calls when a policy period runs out, moves
 * `archived_at` and nothing else. So the sweep's rows kept matching by name and
 * kept appearing, and the bug was invisible to anyone testing the manual path.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('a retired engagement is out of the client history it belonged to', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const results409a = (fmv: number) => ({
    fmv_per_share: fmv,
    equity_value: fmv * 1_000_000,
    common_equity_value: fmv * 1_000_000,
    fully_diluted_common: 1_000_000,
    discounts: { dlom: 0.3, dloc: 0.05 },
    assumptions: { volatility: 0.5 },
    approaches: { market: { weight: 1, multiples: [4, 6], selected_multiple: 5 } },
  });

  /** One engagement with one succeeded run, stamped so the ordering is explicit. */
  async function engagement(company: string, at: string, fmv: number) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: user.id, partnerId: null },
      { ...actor, actorId: user.id },
    );
    const calc = await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: results409a(fmv),
        equityValue: fmv * 1_000_000,
        fmvPerShare: fmv,
        createdBy: user.id,
      },
      { ...actor, actorId: user.id },
    );
    await ctx.pool.query('UPDATE calculations SET created_at = $2 WHERE id = $1', [calc.id, at]);
    return v;
  }

  const trendPoints = async (id: string) => {
    const { summary } = await summaryFor(ctx.pool, (await findValuationById(ctx.pool, id))!);
    const chart = summary?.charts.find((c) => c.title?.includes('Fair market value per common share'));
    return chart?.points?.map((p) => p.value) ?? null;
  };

  const analyticsFmvs = async (id: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/analytics`,
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().analytics.series.map((p: { fmv_per_share: number | null }) => p.fmv_per_share);
  };

  const candidateIds = async (id: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/bridge-candidates`,
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().candidates.map((c: { id: string }) => c.id);
  };

  it('drops it from the trend chart, the analytics series and the bridge candidates at once', async () => {
    const company = 'Retired History Co';
    const oldest = await engagement(company, '2024-06-01T00:00:00Z', 2);
    const middle = await engagement(company, '2025-06-01T00:00:00Z', 5);
    const latest = await engagement(company, '2026-06-01T00:00:00Z', 3);

    // All three engagements are live, so all three surfaces see all three.
    expect(await trendPoints(latest.id)).toEqual([2, 5, 3]);
    expect(await analyticsFmvs(latest.id)).toEqual([2, 5, 3]);
    expect(await candidateIds(latest.id)).toEqual(expect.arrayContaining([oldest.id, middle.id]));

    // The retention sweep's own writer: `archived_at` and nothing else, so the
    // company name still matches and only the archived clause can exclude it.
    expect(await markValuationsArchived(ctx.pool, [middle.id])).toEqual([middle.id]);

    // The withdrawn engagement is gone from the deliverable's chart — and the
    // chart is still drawn, because two points remain. A one-sided assertion
    // would pass just as well if the whole chart had been suppressed.
    expect(await trendPoints(latest.id)).toEqual([2, 3]);
    expect(await analyticsFmvs(latest.id)).toEqual([2, 3]);
    expect(await candidateIds(latest.id)).toEqual([oldest.id]);
  });

  it('brings it back on restore — this is a filter, not a deletion', async () => {
    const company = 'Restored History Co';
    const older = await engagement(company, '2024-06-01T00:00:00Z', 2);
    const latest = await engagement(company, '2026-06-01T00:00:00Z', 3);

    await markValuationsArchived(ctx.pool, [older.id]);
    // Below two points the chart is suppressed entirely, which is the shape the
    // `sameCompanyFilter` work exists to stop — so this also pins that a
    // *wrongly* archived engagement is recoverable rather than a lost chart.
    expect(await trendPoints(latest.id)).toBeNull();
    expect(await candidateIds(latest.id)).toEqual([]);

    const restored = await restoreValuations(ctx.pool, [older.id]);
    expect(restored.restored).toEqual([older.id]);

    expect(await trendPoints(latest.id)).toEqual([2, 3]);
    expect(await analyticsFmvs(latest.id)).toEqual([2, 3]);
    expect(await candidateIds(latest.id)).toEqual([older.id]);
  });

  it('applies the archived clause on the firm branch of the filter too', async () => {
    // The clause is ANDed onto a two-branch filter. A regression that put it on
    // only the owner branch would leave *firm* histories showing archived work
    // and still pass every assertion above, all of which are direct-client.
    //
    // Two members, as the firm case actually arises: a converted client intake
    // belongs to whoever pressed Convert, so successive 409As for one client
    // are routinely opened by different people.
    const firmId = await seedPartner(ctx, `Archived Branch Firm ${Date.now()}`);
    const alice = await seedUser(ctx, { roles: ['valuation_user'], partnerId: firmId });
    const bob = await seedUser(ctx, { roles: ['valuation_user'], partnerId: firmId });
    const company = 'Firm History Co';

    const mk = async (owner: { id: string }, at: string, fmv: number) => {
      const v = await createValuation(
        ctx.pool,
        { kind: '409a', companyName: company, userId: owner.id, partnerId: firmId },
        { ...actor, actorId: owner.id },
      );
      const calc = await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: 'test',
          status: 'succeeded',
          inputs: {},
          results: results409a(fmv),
          equityValue: fmv * 1_000_000,
          fmvPerShare: fmv,
          createdBy: owner.id,
        },
        { ...actor, actorId: owner.id },
      );
      await ctx.pool.query('UPDATE calculations SET created_at = $2 WHERE id = $1', [calc.id, at]);
      return v;
    };

    await mk(alice, '2024-06-01T00:00:00Z', 2);
    const retired = await mk(bob, '2025-06-01T00:00:00Z', 4);
    const current = await mk(alice, '2026-06-01T00:00:00Z', 3);

    expect(await trendPoints(current.id)).toEqual([2, 4, 3]);
    await markValuationsArchived(ctx.pool, [retired.id]);
    expect(await trendPoints(current.id)).toEqual([2, 3]);
  });
});
