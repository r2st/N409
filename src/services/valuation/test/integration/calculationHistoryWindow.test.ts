import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, type ValuationRow } from '../../src/repos/valuations.js';
import {
  CALCULATION_PAGE_LIMIT,
  createCalculation,
  listCalculationHistory,
  listCalculations,
} from '../../src/repos/calculations.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The run history, read without the engine request nobody opens.
 *
 * R338 (M8). `GET /valuations/:id/calculations` draws a list of dates, statuses
 * and per-share figures, and it was shipping the whole `inputs` document —
 * every share class, every comparable, the full params document — for each of
 * twenty runs to do it. `CalculationPanel` reads `results` and the typed scalar
 * columns and nothing else; the one surface that wants the request has its own
 * route, which returns it under `request`.
 *
 * Two things have to stay true of the narrower read: it must be the same window
 * the wide one returns, in the same order, so `truncated` still means what it
 * said; and `results` must survive intact, because unlike
 * `listCalculationResults` this reader's caller does open it.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

const results = (fmv: number) => ({
  fmv_per_share: fmv,
  equity_value: 48_210_000,
  recomputed: ['market'],
  discounts: { dloc: 0.1002, dlom: 0.3142 },
  assumptions: { time_to_exit_years: 3.5, volatility: 0.62, risk_free_rate: 0.041 },
  approaches: {
    income: { value: 41_200_000, weight: 0.5 },
    market: { value: 55_000_000, weight: 0.5 },
  },
});

/** The engine request as it is actually stored: a cap table under `inputs`. */
const engineInputs = () => ({
  params: { valuation_date: '2026-03-31' },
  inputs: {
    cap_table: Array.from({ length: 200 }, (_, i) => ({
      class: `class_${i}`,
      shares: 10_000 + i,
      preference: i * 1_000,
      seniority: i % 5,
    })),
  },
});

describe.skipIf(!dbUp)('the run-history window', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let v: ValuationRow;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
    v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Meridian Instruments, Inc.', userId: client.id, currency: 'USD' },
      { ...actor, actorId: client.id },
    );
    // One run past the window, so the cap is exercised rather than assumed.
    for (let i = 0; i < CALCULATION_PAGE_LIMIT + 1; i += 1) {
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: i % 7 === 3 ? 'failed' : 'succeeded',
          inputs: engineInputs(),
          results: i % 7 === 3 ? null : results(1 + i / 100),
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );
    }
  });
  afterAll(async () => {
    await ctx?.teardown();
  });

  it('reads the same twenty runs, in the same order, with the same truncation', async () => {
    const wide = await listCalculations(ctx.pool, v.id);
    const narrow = await listCalculationHistory(ctx.pool, v.id);
    expect(narrow.calculations.map((c) => c.id)).toEqual(wide.calculations.map((c) => c.id));
    expect(narrow.truncated).toBe(wide.truncated);
    expect(narrow.truncated).toBe(true);
    // Failed runs stay in the window: the panel draws them, and a failed run is
    // the case its step inspector is most useful for.
    expect(narrow.calculations.some((c) => c.status === 'failed')).toBe(true);
  });

  it('keeps every column the panel draws, including the whole results document', async () => {
    const wide = await listCalculations(ctx.pool, v.id);
    const narrow = await listCalculationHistory(ctx.pool, v.id);
    for (const [i, row] of narrow.calculations.entries()) {
      const { inputs: _dropped, ...rest } = wide.calculations[i]!;
      expect(row).toEqual(rest);
    }
    // Not vacuous: the results document really is present and really is the one
    // the panel reads its approach breakdown out of.
    const succeeded = narrow.calculations.find((c) => c.status === 'succeeded')!;
    expect(Object.keys(succeeded.results as Record<string, unknown>)).toContain('approaches');
    expect(succeeded.has_trace).toBe(false);
  });

  it('does not carry the engine request at all', async () => {
    const { calculations } = await listCalculationHistory(ctx.pool, v.id);
    for (const row of calculations) {
      expect(row).not.toHaveProperty('inputs');
    }
    // And the wide reader still does — this is a narrowing of one caller, not a
    // change to what the table stores or to what the evidence bundle archives.
    const wide = await listCalculations(ctx.pool, v.id);
    expect(wide.calculations[0]!.inputs).toHaveProperty('params');
  });

  it('is what the endpoint answers with', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/calculations`,
      headers: { authorization: `Bearer ${ops.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { calculations: Record<string, unknown>[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.calculations).toHaveLength(CALCULATION_PAGE_LIMIT);
    for (const row of body.calculations) expect(row).not.toHaveProperty('inputs');
    // The half the panel does read survives the serialisation.
    const succeeded = body.calculations.find((c) => c.status === 'succeeded')!;
    expect((succeeded.results as { approaches: unknown }).approaches).toBeTruthy();
  });
});
