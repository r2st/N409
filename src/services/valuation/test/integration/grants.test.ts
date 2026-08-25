import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { MAX_SCENARIO_FMVS } from '../../src/domain/vesting.js';

const dbUp = await isDbAvailable();

/** Drives a valuation to an approved board resolution so grants can be issued. */
async function approvedValuation(
  ctx: TestApp,
  ops: Awaited<ReturnType<typeof seedUser>>,
  client: Awaited<ReturnType<typeof seedUser>>,
  fmv: number,
): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/valuations',
    headers: authHeader(client.token),
    payload: { kind: '409a', company_name: 'GrantCo' },
  });
  const id = created.json().valuation.id as string;
  await createCalculation(
    ctx.pool,
    {
      valuationId: id,
      engineVersion: 'test',
      status: 'succeeded',
      inputs: {},
      results: { fmv_per_share: fmv },
      equityValue: fmv * 10_000_000,
      fmvPerShare: fmv,
      createdBy: ops.id,
    },
    { actorType: 'human', actorId: ops.id },
  );
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/valuations/${id}/board`,
    headers: authHeader(ops.token),
    payload: {},
  });
  const add = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/valuations/${id}/board/members`,
    headers: authHeader(ops.token),
    payload: { name: 'Chair', email: 'chair@board.example' },
  });
  const token = add.json().sign_token as string;
  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/board/sign',
    payload: { token, decision: 'signed' },
  });
  return id;
}

describe.skipIf(!dbUp)('feature 6 — grant management', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    valuationId = await approvedValuation(ctx, ops, client, 2.5);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('refuses to issue a grant before board approval', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'UnapprovedCo' },
    });
    const id = created.json().valuation.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'Dev One', grant_date: '2026-06-01', options_count: 1000 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('issues a grant at the adopted FMV with the standard vesting template', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: {
        grantee_name: 'Alice Engineer',
        grantee_email: 'alice@grantco.example',
        // Start long ago so the grant is unambiguously fully vested regardless
        // of the wall clock when the test runs.
        grant_date: '2015-01-01',
        options_count: 48000,
      },
    });
    expect(res.statusCode).toBe(201);
    const grant = res.json().grant;
    // Exercise price snapshotted from the 409A FMV.
    expect(Number(grant.exercise_price)).toBe(2.5);
    expect(grant.vesting_months).toBe(48);
    expect(grant.cliff_months).toBe(12);
    expect(grant.vesting_start_date).toBe('2015-01-01');
    expect(grant.vesting.totalShares).toBe(48000);
    // Vesting term ended in 2019 → fully vested.
    expect(grant.vesting.vestedShares).toBe(48000);
    expect(grant.vesting.fullyVested).toBe(true);
  });

  it('honours an explicit exercise price and custom vesting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: {
        grantee_name: 'Bob',
        grant_date: '2026-01-01',
        options_count: 10000,
        exercise_price: 3.0,
        vesting_template: 'custom',
        vesting_months: 24,
        cliff_months: 6,
        frequency_months: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(Number(res.json().grant.exercise_price)).toBe(3.0);
    expect(res.json().grant.vesting_months).toBe(24);
  });

  it('rejects a cliff longer than the vesting term', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: {
        grantee_name: 'Bad',
        grant_date: '2026-01-01',
        options_count: 100,
        vesting_template: 'custom',
        vesting_months: 12,
        cliff_months: 24,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns vesting timeline + exercise scenarios on the detail view', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'Carol', grant_date: '2024-01-01', options_count: 48000 },
    });
    const grantId = created.json().grant.id;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}?fmvs=2.5,25`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.timeline[0].cumulativeVested).toBe(0);
    expect(body.timeline[body.timeline.length - 1].cumulativeVested).toBe(48000);
    expect(body.scenarios).toHaveLength(2);
    // At FMV 25 with a 2.5 strike: spread 22.5 * 48000 = 1,080,000
    expect(body.scenarios[1]).toMatchObject({ fmv: 25, spreadPerShare: 22.5, grossValue: 1_080_000 });
  });

  /**
   * `fmvs` is a comma-separated list read straight off the query string, and
   * every term costs a scenario object in the response — so an unbounded list
   * let a short request ask for an arbitrarily long one. Bounded like `sort`
   * is, and rejected rather than truncated so a caller asking for more never
   * quietly gets fewer.
   */
  it('refuses more what-if FMVs than a ladder can hold, and serves the cap itself', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'Ladder', grant_date: '2024-01-01', options_count: 1000 },
    });
    const grantId = created.json().grant.id;
    const detail = (fmvs: string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/grants/${grantId}?fmvs=${fmvs}`,
        headers: authHeader(ops.token),
      });

    const over = await detail(Array.from({ length: MAX_SCENARIO_FMVS + 1 }, (_, i) => i + 1).join(','));
    expect(over.statusCode).toBe(400);

    // The boundary itself is still served — an off-by-one here would silently
    // shorten the ladder the UI already asks for.
    const at = await detail(Array.from({ length: MAX_SCENARIO_FMVS }, (_, i) => i + 1).join(','));
    expect(at.statusCode).toBe(200);
    expect(at.json().scenarios).toHaveLength(MAX_SCENARIO_FMVS);

    // No `fmvs` at all still falls back to the default ladder.
    const none = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().scenarios).toHaveLength(4);
  });

  /*
   * The default ladder is 1×/2×/5×/10× *the current 409A FMV* and the panel's
   * "×current" column divides by it. Both were read straight off
   * `calculations.fmv_per_share`, a 409A column by name that every specialty
   * engine writes into: on an EMI run it holds the restricted AMV, which is
   * below fair market value by the whole restriction discount, so every
   * multiple on the panel came back overstated and the whole table was scaled
   * off the wrong number. R142 stopped a board *adopting* this column as a
   * §409A price; this is the same column being read as one, one screen over.
   */
  describe('the what-if ladder is only struck off a figure that is a 409A FMV', () => {
    const seedGranted = async (
      companyKind: string,
      results: Record<string, unknown>,
      columnFmv: number,
      adoptedFmv: number,
      /** Struck away from the adopted FMV, when the test needs the two to differ. */
      exercisePrice?: number,
    ) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: companyKind, company_name: `Ladder ${companyKind}` },
      });
      const id = created.json().valuation.id as string;
      await createCalculation(
        ctx.pool,
        {
          valuationId: id,
          engineVersion: 'test',
          status: 'succeeded',
          inputs: {},
          results,
          equityValue: 10_000_000,
          fmvPerShare: columnFmv,
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );
      // Named explicitly, because on a specialty run `POST /board` refuses to
      // derive one from this column at all (R142).
      const board = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/board`,
        headers: authHeader(ops.token),
        payload: { fmv_conclusion: adoptedFmv },
      });
      expect(board.statusCode, JSON.stringify(board.json())).toBe(201);
      const add = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/board/members`,
        headers: authHeader(ops.token),
        payload: { name: 'Chair', email: `chair-${companyKind}@board.example` },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/board/sign',
        payload: { token: add.json().sign_token, decision: 'signed' },
      });
      const grant = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/grants`,
        headers: authHeader(ops.token),
        payload: {
          grantee_name: 'Dana',
          grant_date: '2024-01-01',
          options_count: 1000,
          ...(exercisePrice === undefined ? {} : { exercise_price: exercisePrice }),
        },
      });
      expect(grant.statusCode, JSON.stringify(grant.json())).toBe(201);
      return { id, grantId: grant.json().grant.id as string };
    };

    const detail = async (id: string, grantId: string, query = '') => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/grants/${grantId}${query}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      return res.json();
    };

    it('never anchors an EMI panel on the restricted AMV', async () => {
      // AMV 1.00 in the column; the board adopted 1.50 explicitly and the grant
      // was struck there.
      const { id, grantId } = await seedGranted(
        'emi',
        { kind: 'emi', specialty: { amv_per_share: 1, umv_per_share: 1.5 } },
        1,
        1.5,
      );
      const body = await detail(id, grantId);
      // The ladder is 1×/2×/5×/10× of 1.50, not of the AMV.
      expect(body.scenarios.map((s: { fmv: number }) => s.fmv)).toEqual([1.5, 3, 7.5, 15]);

      // And the multiple divides by the same thing: 3.00 is 2× what this option
      // costs, not the 3× a division by the AMV reported.
      const one = await detail(id, grantId, '?fmvs=3');
      expect(one.scenarios[0]).toMatchObject({ fmv: 3, multipleOfCurrent: 2 });
    });

    it('still uses the concluded FMV on a 409A run, not the strike', async () => {
      /*
       * The control, and it has to discriminate in the other direction: the
       * column (2.50) and the exercise price (1.00) are deliberately different
       * numbers, so a "fix" that simply stopped reading the column would fail
       * here. An early grant struck below a later 409A is the ordinary way the
       * two come apart, and the panel's whole point is the spread between them.
       */
      const { id, grantId } = await seedGranted('409a', { fmv_per_share: 2.5, approaches: {} }, 2.5, 2.5, 1);
      const body = await detail(id, grantId);
      expect(body.scenarios.map((s: { fmv: number }) => s.fmv)).toEqual([2.5, 5, 12.5, 25]);
      const one = await detail(id, grantId, '?fmvs=5');
      expect(one.scenarios[0]).toMatchObject({ fmv: 5, multipleOfCurrent: 2 });
    });

    it('falls back to the strike on an ESOP run too', async () => {
      // Not only the UK schemes: an ESOP's per-share figure is ERISA adequate
      // consideration over shares outstanding, off a *supplied* equity value.
      // A real number, carefully derived, and not the one §409A asks for.
      const { id, grantId } = await seedGranted(
        'esop',
        { kind: 'esop', specialty: { fmv_per_share: 4 } },
        4,
        2,
      );
      const body = await detail(id, grantId);
      expect(body.scenarios.map((s: { fmv: number }) => s.fmv)).toEqual([2, 4, 10, 20]);
    });
  });

  it('lists grants for the owning client but not other clients', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(client.token),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().grants.length).toBeGreaterThan(0);

    const theirs = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(otherClient.token),
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('blocks a client from issuing grants', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(client.token),
      payload: { grantee_name: 'X', grant_date: '2026-01-01', options_count: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('edits and cancels a grant', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'Dave', grant_date: '2025-01-01', options_count: 5000 },
    });
    const grantId = created.json().grant.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
      payload: { options_count: 6000, notes: 'Bumped' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().grant.options_count).toBe(6000);

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().grant.status).toBe('cancelled');
  });

  // ── The vesting template has to mean what the schedule does ───────────────
  //
  // `vesting_template` was a free 60-character string resolved with
  // `templateByKey(...) ?? 48/12/1`. An unrecognised key was therefore issued
  // as a standard 4-year, 1-year-cliff grant and stored under the key that was
  // sent, so the row's label and the schedule it vests on disagreed — silently,
  // permanently, on a record that is a contract with an employee.

  it('refuses an unrecognised vesting template instead of issuing a default schedule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      // One character short of a real template key.
      payload: {
        grantee_name: 'Typo',
        grant_date: '2026-01-01',
        options_count: 1000,
        vesting_template: 'three_year_quarterl',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('Unknown vesting template');
  });

  it("issues a named template on that template's own schedule", async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: {
        grantee_name: 'Quarterly',
        grant_date: '2026-01-01',
        options_count: 3600,
        vesting_template: 'three_year_quarterly',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().grant).toMatchObject({
      vesting_template: 'three_year_quarterly',
      vesting_months: 36,
      cliff_months: 12,
      frequency_months: 3,
    });
  });

  it('moves the schedule when a patch switches the template', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'Switcher', grant_date: '2026-01-01', options_count: 4800 },
    });
    expect(created.json().grant.vesting_months).toBe(48);
    const grantId = created.json().grant.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
      payload: { vesting_template: 'three_year_quarterly' },
    });
    expect(patched.statusCode).toBe(200);
    // Previously this relabelled the grant and left it on 48 months, monthly.
    expect(patched.json().grant).toMatchObject({
      vesting_template: 'three_year_quarterly',
      vesting_months: 36,
      cliff_months: 12,
      frequency_months: 3,
    });
  });

  it('lets an explicit month override win over the template it accompanies', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'Override', grant_date: '2026-01-01', options_count: 1200 },
    });
    const grantId = created.json().grant.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
      payload: { vesting_template: 'three_year_quarterly', vesting_months: 30 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().grant).toMatchObject({ vesting_months: 30, frequency_months: 3 });
  });

  it('refuses an unrecognised template on a patch too', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'PatchTypo', grant_date: '2026-01-01', options_count: 100 },
    });
    const grantId = created.json().grant.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
      payload: { vesting_template: 'made_up' },
    });
    expect(res.statusCode).toBe(422);
  });
});
