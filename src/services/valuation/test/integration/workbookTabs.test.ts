import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The four-tab workbook view. The assembly is unit-tested against a synthetic
 * context; what this covers is that the five real repos hand it the shapes it
 * expects — a `numeric` column arriving as a string, a `date` as a `Date`, an
 * absent profile as null — and that it is read-only.
 */
describe.skipIf(!dbUp)('workbook tabs', () => {
  let ctx: TestApp;
  let analyst: { id: string; token: string };
  let valuationId: string;

  const tabs = (token: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/workbook/tabs`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    analyst = await seedUser(ctx, { roles: ['reviewer'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(analyst.token),
      payload: { kind: '409a', company_name: 'Acme Robotics' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id;
  }, 60_000);
  afterAll(() => ctx.teardown());

  it('returns all four tabs on a brand-new valuation', async () => {
    const res = await tabs(analyst.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().tabs.map((t: { key: string }) => t.key)).toEqual([
      'company_overview',
      'captable',
      'financials',
      'valuation_params',
    ]);
    // Nothing filled in yet, but every tab still reports its shape — this is
    // what the completeness meter counts against.
    for (const tab of res.json().tabs) {
      expect(tab.total, tab.key).toBeGreaterThan(0);
      expect(tab.overridden, tab.key).toBe(0);
    }
  });

  it('falls back to the engagement name with no company profile stored', async () => {
    const field = (await tabs(analyst.token))
      .json()
      .tabs[0].sections.flatMap((s: { fields: unknown[] }) => s.fields)
      .find((f: { key: string }) => f.key === 'legal_name');
    expect(field.value).toBe('Acme Robotics');
    expect(field.edit_endpoint).toContain('company-profile');
  });

  it('reflects params written through their own endpoint', async () => {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(analyst.token),
      // All four weights or none, summing to 1 — the params route's own rule.
      payload: {
        dlom: 0.28,
        dlom_method: 'finnerty',
        weight_opm: 0.7,
        weight_income: 0,
        weight_market: 0.3,
        weight_asset: 0,
      },
    });
    expect(patched.statusCode).toBe(200);

    const params = (await tabs(analyst.token))
      .json()
      .tabs.find((t: { key: string }) => t.key === 'valuation_params');
    const fields = new Map<string, { value: unknown }>(
      params.sections
        .flatMap((s: { fields: Array<{ key: string }> }) => s.fields)
        .map((f: { key: string }) => [f.key, f]),
    );
    // `numeric` comes back from pg as a string; the tab must report a number
    // or the field beside it disagrees on type.
    expect(fields.get('dlom')!.value).toBe(0.28);
    expect(fields.get('weight_opm')!.value).toBe(0.7);
    expect(fields.get('weight_total')!.value).toBeCloseTo(1);
    expect(params.filled).toBeGreaterThanOrEqual(4);
  });

  it('shows an analyst override in force, with the stored value beside it', async () => {
    const applied = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/overwrites/dlom`,
      headers: authHeader(analyst.token),
      payload: { value: 0.35, reason: 'Finnerty output not supportable at this holding period' },
    });
    expect(applied.statusCode).toBeLessThan(300);

    const params = (await tabs(analyst.token))
      .json()
      .tabs.find((t: { key: string }) => t.key === 'valuation_params');
    const dlom = params.sections
      .flatMap((s: { fields: Array<{ key: string }> }) => s.fields)
      .find((f: { key: string }) => f.key === 'dlom');
    expect(dlom.value).toBe(0.35);
    expect(dlom.computed_value).toBe(0.28);
    expect(dlom.overridden).toBe(true);
    expect(dlom.overwrite_key).toBe('dlom');
    expect(params.overridden).toBe(1);
  });

  it('surfaces workbook cells and their derived rows on the financials tab', async () => {
    const saved = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/workbook`,
      headers: authHeader(analyst.token),
      payload: {
        cells: [
          { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 5_000_000 },
          { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 2_000_000 },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);

    const financials = (await tabs(analyst.token))
      .json()
      .tabs.find((t: { key: string }) => t.key === 'financials');
    const fields = new Map<string, { value: unknown; source: string }>(
      financials.sections
        .flatMap((s: { fields: Array<{ key: string }> }) => s.fields)
        .map((f: { key: string }) => [f.key, f]),
    );
    expect(fields.get('revenue')!.value).toBe(5_000_000);
    expect(fields.get('gross_profit')!.value).toBe(3_000_000);
    expect(fields.get('gross_margin')!.value).toBeCloseTo(0.6);
    // A derived row is changed by changing its inputs; offering an edit target
    // would invite a client to try writing it.
    expect(fields.get('gross_profit')!.source).toBe('derived');
  });

  it('is read-only — there is no write path through the view', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/api/v1/valuations/${valuationId}/workbook/tabs`,
        headers: authHeader(analyst.token),
        payload: {},
      });
      expect(res.statusCode, method).toBe(404);
    }
  });

  it('requires a session', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/workbook/tabs`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not leak another analyst’s client valuation', async () => {
    const outsider = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await tabs(outsider.token);
    expect([403, 404]).toContain(res.statusCode);
  });
});
