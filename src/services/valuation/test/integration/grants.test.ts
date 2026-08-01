import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

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
});
