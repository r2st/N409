import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('external auditor portal (feature 8)', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let other: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    other = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation() {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Auditee Inc', userId: owner.id },
      { ...actor, actorId: owner.id },
    );
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: 'py-1.0.0',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.25, equity_value: 12_000_000 },
        equityValue: 12_000_000,
        fmvPerShare: 3.25,
        createdBy: owner.id,
      },
      { ...actor, actorId: owner.id },
    );
    return v;
  }

  const createLink = (token: string, valuationId: string, payload: object = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/auditor-access`,
      headers: authHeader(token),
      payload,
    });

  const redeem = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auditor/portal', payload: { token } });

  it('mints a link and serves a read-only bundle', async () => {
    const v = await seedValuation();
    const created = await createLink(owner.token, v.id, { label: 'PwC', expires_in_days: 30 });
    expect(created.statusCode).toBe(201);
    const { token, url } = created.json();
    expect(url).toContain('/auditor#token=');

    const bundle = await redeem(token);
    expect(bundle.statusCode).toBe(200);
    const body = bundle.json();
    expect(body.valuation.company_name).toBe('Auditee Inc');
    expect(body.conclusion.fmv_per_share).toBe('3.25');
    expect(body.evidence_summary.has_conclusion).toBe(true);
  });

  it('rejects an expired link', async () => {
    const v = await seedValuation();
    const { token } = (await createLink(owner.token, v.id)).json();
    await ctx.pool.query(`UPDATE auditor_access SET expires_at = now() - interval '1 day' WHERE valuation_id = $1`, [v.id]);
    const bundle = await redeem(token);
    expect(bundle.statusCode).toBe(401);
  });

  it('rejects a revoked link', async () => {
    const v = await seedValuation();
    const created = await createLink(owner.token, v.id);
    const { token } = created.json();
    const accessId = created.json().access.id;

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${v.id}/auditor-access/${accessId}`,
      headers: authHeader(owner.token),
    });
    expect(revoke.statusCode).toBe(204);
    expect((await redeem(token)).statusCode).toBe(401);
  });

  it("won't let a non-owner mint links for someone else's valuation", async () => {
    const v = await seedValuation();
    const res = await createLink(other.token, v.id);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a garbage token', async () => {
    expect((await redeem('not-a-real-token')).statusCode).toBe(401);
  });
});
