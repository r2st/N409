import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

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

  /**
   * The bridge was the caller `sameCompanyFilter` never reached. It kept its own
   * `user_id = … AND company_name = …` in both halves — the candidate list and
   * the guard — so a firm whose successive 409As were opened by different
   * members was offered nothing to bridge to, and answered "Both valuations
   * must be for the same company" if it named last year's directly.
   */
  describe("a firm's client, across two of its members", () => {
    let firmId: string;
    let alice: Awaited<ReturnType<typeof seedUser>>;
    let bob: Awaited<ReturnType<typeof seedUser>>;

    beforeAll(async () => {
      firmId = await seedPartner(ctx, `Bridge Firm ${Date.now()}`);
      alice = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
      bob = await seedUser(ctx, { roles: ['member'], partnerId: firmId });
    });

    async function seedFirmValuation(
      owner: { id: string },
      company: string,
      fmv: number,
      partnerId: string = firmId,
    ) {
      const v = await createValuation(
        ctx.pool,
        { kind: '409a', companyName: company, userId: owner.id, partnerId },
        { ...actor, actorId: owner.id },
      );
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: 'test',
          status: 'succeeded',
          inputs: {},
          results: calcResults(fmv, fmv * 1_000_000, 0.2),
          equityValue: fmv * 1_000_000,
          fmvPerShare: fmv,
          createdBy: owner.id,
        },
        { ...actor, actorId: owner.id },
      );
      return v;
    }

    it("offers last year's engagement even though a different member opened it", async () => {
      const lastYear = await seedFirmValuation(alice, 'Halcyon Bio', 2.0);
      const thisYear = await seedFirmValuation(bob, 'Halcyon Bio', 3.0);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${thisYear.id}/bridge-candidates`,
        headers: authHeader(bob.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().candidates.map((c: { id: string }) => c.id)).toContain(lastYear.id);
    });

    it('draws the bridge between them', async () => {
      const lastYear = await seedFirmValuation(alice, 'Kestrel Labs', 2.0);
      const thisYear = await seedFirmValuation(bob, 'Kestrel Labs', 3.0);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${thisYear.id}/bridge/${lastYear.id}`,
        headers: authHeader(bob.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().bridge.from_fmv).toBeCloseTo(2.0, 6);
      expect(res.json().bridge.to_fmv).toBeCloseTo(3.0, 6);
    });

    it('still keeps another firm out, under the very same company name', async () => {
      const otherFirm = await seedPartner(ctx, `Rival Firm ${Date.now()}`);
      const carol = await seedUser(ctx, { roles: ['partner'], partnerId: otherFirm });
      const theirs = await seedFirmValuation(carol, 'Contested Name', 9.0, otherFirm);
      const ours = await seedFirmValuation(alice, 'Contested Name', 2.0);

      const candidates = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${ours.id}/bridge-candidates`,
        headers: authHeader(alice.token),
      });
      expect(candidates.json().candidates.map((c: { id: string }) => c.id)).not.toContain(theirs.id);

      // And the guard agrees with the list it is guarding — a 404 because the
      // other firm's valuation is not readable here at all.
      const bridged = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${ours.id}/bridge/${theirs.id}`,
        headers: authHeader(alice.token),
      });
      expect(bridged.statusCode).toBe(404);
    });

    it('does not join a direct client to a firm engagement of the same name', async () => {
      // `ops` here is a plain valuation_user with no partner.
      const direct = await seedValuation('Ambiguous Co', 4.0, 4_000_000, 0.2);
      const firmSide = await seedFirmValuation(alice, 'Ambiguous Co', 5.0);

      const candidates = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${firmSide.id}/bridge-candidates`,
        headers: authHeader(alice.token),
      });
      expect(candidates.json().candidates.map((c: { id: string }) => c.id)).not.toContain(direct.id);
    });
  });
});
