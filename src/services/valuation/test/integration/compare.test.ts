import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, type ValuationRow } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * GET /api/v1/valuations/compare.
 *
 * The behaviour that matters here is not the table — that is pinned in
 * valuationCompare.test.ts — but the boundary: both sides are authorised
 * independently, so a caller cannot read a valuation they have no right to
 * simply by naming it as the other half of a comparison they do.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('valuation comparison endpoint', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let first: ValuationRow;
  let second: ValuationRow;
  let uncomputed: ValuationRow;
  let foreign: ValuationRow;

  async function seed(
    userId: string,
    company: string,
    results: Record<string, unknown> | null,
    currency = 'USD',
  ): Promise<ValuationRow> {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId, currency },
      { ...actor, actorId: userId },
    );
    if (results) {
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { inputs: { valuation_date: '2025-05-31' } },
          results,
          fmvPerShare: Number(results.fmv_per_share ?? 0),
          createdBy: userId,
        },
        { ...actor, actorId: userId },
      );
    }
    return v;
  }

  const compare = (a: string, b: string, token: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/compare?a=${a}&b=${b}`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });

    first = await seed(owner.id, 'Northwind Robotics', {
      fmv_per_share: 1.42,
      equity_value: 48_000_000,
      allocation_method: 'opm',
      discounts: { dloc: 0.05, dlom: 0.3 },
      assumptions: { volatility: 0.65 },
      approaches: { opm_backsolve: { weight: 1, equity_value: 48_000_000 } },
    });
    second = await seed(owner.id, 'Northwind Robotics', {
      fmv_per_share: 1.87,
      equity_value: 61_000_000,
      allocation_method: 'hybrid',
      discounts: { dloc: 0.05, dlom: 0.22 },
      assumptions: { volatility: 0.58 },
      approaches: { opm_backsolve: { weight: 1, equity_value: 61_000_000 } },
    });
    uncomputed = await seed(owner.id, 'Northwind Robotics', null);
    foreign = await seed(stranger.id, 'Someone Else Ltd', { fmv_per_share: 9.99 });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('compares two valuations the caller owns', async () => {
    const res = await compare(first.id, second.id, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.a.valuation_id).toBe(first.id);
    expect(body.b.valuation_id).toBe(second.id);
    expect(body.a.engine_version).toBe('1.4.0');
    expect(body.a.valuation_date).toBe('2025-05-31');
    expect(body.summary).toBe('FMV per share is up from $1.4200 to $1.8700 (31.7%).');

    const rows = new Map(
      (body.groups as Array<{ rows: Array<{ key: string; delta_display: string | null }> }>)
        .flatMap((g) => g.rows)
        .map((r) => [r.key, r]),
    );
    expect(rows.get('dlom')?.delta_display).toBe('−8.0 pts');
    expect(body.changed_count).toBeGreaterThan(0);
  });

  it('uses the newest successful calculation on each side', async () => {
    // A later run supersedes the earlier one, exactly as the report does.
    await createCalculation(
      ctx.pool,
      {
        valuationId: second.id,
        engineVersion: '1.5.0',
        status: 'succeeded',
        inputs: { inputs: { valuation_date: '2025-11-30' } },
        results: { fmv_per_share: 2.5 },
        fmvPerShare: 2.5,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    const res = await compare(first.id, second.id, owner.token);
    expect(res.json().b.engine_version).toBe('1.5.0');
    expect(res.json().b.valuation_date).toBe('2025-11-30');
  });

  it('renders a side that has never computed instead of failing', async () => {
    const res = await compare(first.id, uncomputed.id, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.b.calculation_id).toBeNull();
    // "The new one hasn't run yet" is a normal thing to want to look at.
    const fmv = (body.groups as Array<{ rows: Array<{ key: string; b_display: string | null }> }>)
      .flatMap((g) => g.rows)
      .find((r) => r.key === 'fmv_per_share');
    expect(fmv?.b_display).toBeNull();
  });

  it('refuses a comparison that includes a valuation the caller cannot read', async () => {
    // 404, not 403: distinguishing them would confirm the id exists.
    expect((await compare(first.id, foreign.id, owner.token)).statusCode).toBe(404);
    expect((await compare(foreign.id, first.id, owner.token)).statusCode).toBe(404);
    expect((await compare(first.id, second.id, stranger.token)).statusCode).toBe(404);
  });

  it('404s on an unknown or malformed id', async () => {
    expect((await compare(first.id, '01N409NOSUCHVALUATION00AA', owner.token)).statusCode).toBe(404);
    expect((await compare(first.id, 'not-a-ulid', owner.token)).statusCode).toBe(404);
  });

  it('rejects comparing a valuation with itself', async () => {
    const res = await compare(first.id, first.id, owner.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/two different valuations/);
  });

  it('rejects a comparison across currencies rather than mixing symbols', async () => {
    const sterling = await seed(owner.id, 'Northwind UK', { fmv_per_share: 1.1 }, 'GBP');
    const res = await compare(first.id, sterling.id, owner.token);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/denominated differently/);
  });

  it('requires both ids', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/compare?a=${first.id}`,
      headers: authHeader(owner.token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/compare?a=${first.id}&b=${second.id}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
