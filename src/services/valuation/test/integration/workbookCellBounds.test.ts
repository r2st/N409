import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { computeWorkbook } from '../../src/domain/workbook.js';

const dbUp = await isDbAvailable();

/**
 * A workbook cell whose magnitude overflows the row computed from it.
 *
 * `PatchBody.value` was `z.number().finite()` and nothing else — the finiteness
 * half of the check every other money door on this service pairs with a range.
 * Storage was never the problem (`workbook_cells.value` is an unconstrained
 * `numeric`); the derived rows were. See routes/workbook.ts.
 */
describe('workbook cell bounds', () => {
  /**
   * Why the bound is on the *input*: the arithmetic downstream of it cannot
   * report the failure. This is the state the route used to allow, held against
   * the compute directly so it does not depend on the schema that now refuses it.
   */
  it('overflows a derived row to a value with no JSON spelling', () => {
    const sheets = computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 1e308 },
      { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: -1e308 },
    ]);
    const grossProfit = sheets
      .find((s) => s.key === 'income_statement')!
      .rows.find((r) => r.key === 'gross_profit')!
      .cells.find((c) => c.column_key === 'fy_current')!.value;
    expect(grossProfit).toBe(Infinity);
    // The wire value of that row is `null` — the same one an unfilled cell
    // sends, which is why an overflow reads to the analyst as "not computable
    // yet" rather than as anything being wrong.
    expect(JSON.parse(JSON.stringify({ v: grossProfit })).v).toBeNull();
  });

  describe.skipIf(!dbUp)('over the route', () => {
    let ctx: TestApp;
    let analyst: Awaited<ReturnType<typeof seedUser>>;
    let valuationId: string;

    beforeAll(async () => {
      ctx = await setupTestApp();
      analyst = await seedUser(ctx, { roles: ['reviewer'] });
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(analyst.token),
        payload: { kind: '409a', company_name: 'Overflow Co' },
      });
      valuationId = created.json().valuation.id;
    });
    afterAll(async () => ctx?.teardown());

    const patch = (value: number) =>
      ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(analyst.token),
        payload: {
          cells: [{ sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value }],
        },
      });

    it('refuses a cell past the magnitude bound, in both directions', async () => {
      expect((await patch(1e308)).statusCode).toBe(422);
      expect((await patch(-1e308)).statusCode).toBe(422);
    });

    it('still accepts a figure at the bound', async () => {
      expect((await patch(1e15)).statusCode).toBe(200);
    });

    it('still accepts an ordinary figure', async () => {
      expect((await patch(5_000_000)).statusCode).toBe(200);
    });
  });
});
