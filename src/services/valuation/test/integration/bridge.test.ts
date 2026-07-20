import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

function calcResults(fmv: number, equity: number, dlom: number) {
  return {
    fmv_per_share: fmv,
    equity_value: equity,
    common_equity_value: equity,
    fully_diluted_common: 1_000_000,
    discounts: { dloc: 0, dlom },
    assumptions: { volatility: 0.5 },
    approaches: { market: { weight: 1, multiples: [5] } },
  };
}

describe.skipIf(!dbUp)('value bridge endpoint (feature 3)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation(company: string, fmv: number, equity: number, dlom: number) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: ops.id },
      { ...actor, actorId: ops.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: calcResults(fmv, equity, dlom),
        equityValue: equity,
        fmvPerShare: fmv,
        createdBy: ops.id,
      },
      { ...actor, actorId: ops.id },
    );
    return v;
  }

  it('bridges two valuations of the same company', async () => {
    const older = await seedValuation('BridgeCo', 2.0, 10_000_000, 0.25);
    const newer = await seedValuation('BridgeCo', 3.5, 15_000_000, 0.2);

    const candidates = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${newer.id}/bridge-candidates`,
      headers: authHeader(ops.token),
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json().candidates.map((c: { id: string }) => c.id)).toContain(older.id);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${newer.id}/bridge/${older.id}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const { bridge } = res.json();
    expect(bridge.from_fmv).toBeCloseTo(2.0, 6);
    expect(bridge.to_fmv).toBeCloseTo(3.5, 6);
    expect(bridge.delta).toBeCloseTo(1.5, 6);
    const sum = bridge.factors.reduce((a: number, f: { contribution: number }) => a + f.contribution, 0);
    expect(sum).toBeCloseTo(bridge.delta, 4);
  });

  it('refuses to bridge valuations for different companies', async () => {
    const a = await seedValuation('AlphaCo', 2.0, 10_000_000, 0.25);
    const b = await seedValuation('BetaCo', 3.0, 12_000_000, 0.2);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${a.id}/bridge/${b.id}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(422);
  });

  it('422s when a valuation has no completed calculation', async () => {
    const withCalc = await seedValuation('GammaCo', 2.0, 10_000_000, 0.25);
    const noCalc = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'GammaCo', userId: ops.id },
      { ...actor, actorId: ops.id },
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${withCalc.id}/bridge/${noCalc.id}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(422);
  });
});
