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
    kind = '409a',
  ): Promise<ValuationRow> {
    const v = await createValuation(
      ctx.pool,
      { kind, companyName: company, userId, currency },
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

  /** A further succeeded run on an existing valuation, newer than the last. */
  async function addCalculation(valuationId: string, results: Record<string, unknown>): Promise<void> {
    await createCalculation(
      ctx.pool,
      {
        valuationId,
        engineVersion: '1.4.0',
        status: 'succeeded',
        inputs: { inputs: { valuation_date: '2025-05-31' } },
        results,
        fmvPerShare: Number(results.fmv_per_share ?? 0),
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
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

  /*
   * A specialty run persists `results = { kind, specialty: … }` and puts its
   * headline in the calculation's typed columns, so none of the 409A keys the
   * comparison reads exist on one. Two EMI runs used to come back with no
   * groups at all, and the view read that as "every metric these two report is
   * identical" — a claim about two conclusions that in fact differed.
   */
  it('compares two specialty runs on the engine payload they actually wrote', async () => {
    const emiA = await seed(
      owner.id,
      'Ashcombe Devices',
      { kind: 'emi', specialty: { umv_per_share: 2.25, amv_per_share: 1.8 } },
      'GBP',
      'emi',
    );
    const emiB = await seed(
      owner.id,
      'Ashcombe Devices',
      { kind: 'emi', specialty: { umv_per_share: 2.5, amv_per_share: 2.0 } },
      'GBP',
      'emi',
    );

    const res = await compare(emiA.id, emiB.id, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.metric_count).toBeGreaterThan(0);
    expect(body.changed_count).toBeGreaterThan(0);
    const rows = new Map(
      (body.groups as Array<{ rows: Array<{ key: string; delta_display: string | null }> }>)
        .flatMap((g) => g.rows)
        .map((r) => [r.key, r]),
    );
    expect(rows.get('specialty_amv_per_share')?.delta_display).toBe('+0.2');
  });

  /*
   * The same table, one run later.
   *
   * The Calculations tab offers the ordinary 409A compute on every kind, so an
   * EMI engagement's `calculations` rows interleave two shapes in one
   * `created_at DESC` ordering. Taking simply the newest succeeded run meant a
   * later 409A compute shadowed the specialty run this comparison exists to
   * read: `results.specialty` was absent, every specialty row dropped out on
   * that side alone, and the two engagements were rendered against each other
   * in a vocabulary only one of them had — a table of figures against dashes,
   * under a "Change" column that in fact measured which run happened last.
   */
  it('reads the specialty run even when an ordinary compute ran after it', async () => {
    const emiA = await seed(
      owner.id,
      'Barrow Instruments',
      { kind: 'emi', specialty: { umv_per_share: 2.25, amv_per_share: 1.8 } },
      'GBP',
      'emi',
    );
    const emiB = await seed(
      owner.id,
      'Barrow Instruments',
      { kind: 'emi', specialty: { umv_per_share: 2.5, amv_per_share: 2.0 } },
      'GBP',
      'emi',
    );
    // B also gets run through the 409A pipeline afterwards. Its result is a
    // real 409A document — it is simply not what a comparison of two EMI
    // engagements is asking about.
    await addCalculation(emiB.id, {
      fmv_per_share: 9.99,
      approaches: { market: { weight: 1, equity_value: 5_000_000 } },
    });

    const res = await compare(emiA.id, emiB.id, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const rows = new Map(
      (body.groups as Array<{ rows: Array<{ key: string; delta_display: string | null }> }>)
        .flatMap((g) => g.rows)
        .map((r) => [r.key, r]),
    );
    // Still the AMV move between the two EMI runs, not a 409A price against a
    // blank, and not 2.0 against nothing at all.
    expect(rows.get('specialty_amv_per_share')?.delta_display).toBe('+0.2');
    expect(rows.has('fmv_per_share')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('9.99');
  });

  /*
   * The fallback, which must stay. An EMI engagement that has only ever run the
   * ordinary compute has one shape available and no specialty payload to
   * prefer; refusing to read the run it does have would turn a comparison that
   * works today into two empty columns.
   */
  it('still compares two specialty engagements that only ran the ordinary compute', async () => {
    const a = await seed(owner.id, 'Calder Optics', { fmv_per_share: 1.2 }, 'GBP', 'emi');
    const b = await seed(owner.id, 'Calder Optics', { fmv_per_share: 1.5 }, 'GBP', 'emi');
    const res = await compare(a.id, b.id, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metric_count).toBeGreaterThan(0);
    const rows = new Map(
      (body.groups as Array<{ rows: Array<{ key: string; delta_display: string | null }> }>)
        .flatMap((g) => g.rows)
        .map((r) => [r.key, r]),
    );
    expect(rows.get('fmv_per_share')?.delta_display).toBe('+£0.3000');
  });

  it('refuses two kinds that measure different things', async () => {
    const emi = await seed(owner.id, 'Ashcombe Devices', null, 'USD', 'emi');
    const res = await compare(first.id, emi.id, owner.token);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/measure different things/);
    // Named as the picker names them, not as raw kind codes.
    expect(res.json().detail).toMatch(/EMI scheme valuation/);
  });

  it('compares two kinds that share the 409A engine', async () => {
    const asc718 = await seed(owner.id, 'Northwind Robotics', { fmv_per_share: 1.6 }, 'USD', '718');
    expect((await compare(first.id, asc718.id, owner.token)).statusCode).toBe(200);
  });

  /*
   * Zero metrics is not zero differences. The view says "nothing to compare"
   * off this count, because a comparison that read no metric has established
   * nothing about whether the two agree.
   */
  it('reports no metrics rather than no differences when neither side computed', async () => {
    const other = await seed(owner.id, 'Northwind Robotics', null);
    const res = await compare(uncomputed.id, other.id, owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().metric_count).toBe(0);
    expect(res.json().changed_count).toBe(0);
    expect(res.json().groups).toEqual([]);
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
