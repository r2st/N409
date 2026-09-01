import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, type ValuationRow } from '../../src/repos/valuations.js';
import {
  CALCULATION_PAGE_LIMIT,
  createCalculation,
  listCalculationResults,
  listCalculations,
} from '../../src/repos/calculations.js';
import { reportFigures } from '../../src/domain/reportFigures.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The superseded-figure window, read without the payloads nobody opens.
 *
 * R330 (M8). `routes/qa.ts` reads the last twenty runs to collect the figures a
 * report may still be quoting after they were superseded, and hands each row to
 * `reportFigures`. It was taking the whole row, so every QA review pulled twenty
 * `inputs` documents — the engine request per run, cap table and all — out of
 * the table, across the socket and through the driver's JSON parse, for a caller
 * that opens exactly one key of one of them.
 *
 * Two things have to stay true of the narrower read, and they pull against each
 * other: the window must be the same window a reviewer sees, and the figures it
 * produces must be the same figures. The second is the one a column list can
 * break silently — `incomeAssumptions` falls back to `inputs.inputs.income` on
 * runs that predate the engine recording those assumptions on the result, which
 * is precisely the older half of the history this check exists to look at.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/** A results document big enough that the `inputs` beside it is not free. */
const results = (fmv: number) => ({
  fmv_per_share: fmv,
  equity_value: 48_210_000,
  fully_diluted_common: 21_200_000,
  discounts: { dloc: 0.1002, dlom: 0.3142 },
  approaches: {
    income: { value: 41_200_000, weight: 0.5 },
    market: { value: 55_000_000, weight: 0.5 },
  },
});

/** The engine request as it is actually stored: a cap table under `inputs`. */
const engineInputs = (income: Record<string, unknown> | null) => ({
  params: { valuation_date: '2026-03-31' },
  inputs: {
    ...(income ? { income } : {}),
    cap_table: Array.from({ length: 200 }, (_, i) => ({
      class: `class_${i}`,
      shares: 10_000 + i,
      preference: i * 1_000,
      seniority: i % 5,
    })),
  },
});

describe.skipIf(!dbUp)('the superseded-figure window', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let v: ValuationRow;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Meridian Instruments, Inc.', userId: client.id, currency: 'USD' },
      { ...actor, actorId: client.id },
    );
    // One run past the window, so the cap is exercised rather than assumed, and
    // one of them carrying the legacy income assumptions.
    for (let i = 0; i < CALCULATION_PAGE_LIMIT + 1; i += 1) {
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: i % 7 === 3 ? 'failed' : 'succeeded',
          inputs: engineInputs(i === 0 ? null : { discount_rate: 0.22, terminal_growth: 0.03 }),
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

  it('reads the same twenty runs, in the same order, as the history a reviewer sees', async () => {
    const wide = await listCalculations(ctx.pool, v.id);
    const narrow = await listCalculationResults(ctx.pool, v.id);
    expect(narrow.calculations.map((c) => c.id)).toEqual(wide.calculations.map((c) => c.id));
    expect(narrow.truncated).toBe(wide.truncated);
    expect(narrow.truncated).toBe(true);
    // Failed runs stay in the window rather than being filtered in SQL: the
    // caller wants the succeeded ones among the last twenty, not the last
    // twenty succeeded ones, which is a longer history.
    expect(narrow.calculations.some((c) => c.status === 'failed')).toBe(true);
  });

  it('produces figure-for-figure what the wide read produced', async () => {
    const wide = await listCalculations(ctx.pool, v.id);
    const narrow = await listCalculationResults(ctx.pool, v.id);
    expect(narrow.calculations.map((c) => reportFigures(c, v.currency))).toEqual(
      wide.calculations.map((c) => reportFigures(c, v.currency)),
    );
    // Not vacuously equal: the window really is producing figures.
    expect(
      Object.keys(narrow.calculations.map((c) => reportFigures(c, v.currency))[0]!).length,
    ).toBeGreaterThan(0);
  });

  it('carries the one path into inputs its reader takes, and none of the rest', async () => {
    const { calculations } = await listCalculationResults(ctx.pool, v.id);
    for (const row of calculations) {
      const inputs = row.inputs as { inputs?: Record<string, unknown> };
      // The cap table is the bulk of the document and nothing here opens it.
      expect(Object.keys(inputs)).toEqual(['inputs']);
      expect(Object.keys(inputs.inputs ?? {})).toEqual(['income']);
    }
    // A run with nothing at that path yields the absence its reader already
    // handles, rather than a missing key.
    const oldest = await ctx.pool.query<{ inputs: { inputs: { income: unknown } } }>(
      `SELECT jsonb_build_object('inputs', jsonb_build_object('income', inputs #> '{inputs,income}')) AS inputs
         FROM calculations WHERE valuation_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [v.id],
    );
    expect(oldest.rows[0]!.inputs.inputs.income).toBeNull();
  });
});
