import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('data retention + legal hold (feature 10)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  async function agedValuation(company: string, ageDays: number) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: admin.id },
      { ...actor, actorId: admin.id },
    );
    await ctx.pool.query(`UPDATE valuations SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
      v.id,
      String(ageDays),
    ]);
    return v;
  }

  it('lists seeded policies and updates one', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/policies',
      headers: authHeader(admin.token),
    });
    expect(list.json().policies.map((p: { data_type: string }) => p.data_type)).toContain('valuation');

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().policy.enabled).toBe(true);
  });

  it('archives expired valuations but skips ones under legal hold', async () => {
    // Enable the policy at 365 days.
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });

    const old = await agedValuation('OldCo', 500);
    const held = await agedValuation('HeldCo', 500);
    const young = await agedValuation('YoungCo', 100);

    // Place a legal hold on HeldCo.
    const hold = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/holds',
      headers: authHeader(admin.token),
      payload: { scope: 'valuation', reference_id: held.id, reason: 'IRS audit' },
    });
    expect(hold.statusCode).toBe(201);

    const result = await runRetentionSweep(ctx.pool);
    expect(result.archived).toBeGreaterThanOrEqual(1);
    expect(result.skipped_hold).toBeGreaterThanOrEqual(1);

    const archived = async (id: string) =>
      (await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [id])).rows[0].archived_at;
    expect(await archived(old.id)).not.toBeNull();
    expect(await archived(held.id)).toBeNull(); // frozen
    expect(await archived(young.id)).toBeNull(); // too young

    // The actions log recorded both an archive and a skip.
    const actions = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/actions',
      headers: authHeader(admin.token),
    });
    const kinds = actions.json().actions.map((a: { action: string }) => a.action);
    expect(kinds).toContain('archived');
    expect(kinds).toContain('skipped_hold');
  });

  it('releases a hold so the next sweep archives it', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(admin.token),
      payload: { archive_after_days: 365, retention_days: 730, enabled: true },
    });
    const v = await agedValuation('ReleaseCo', 500);
    const placed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/holds',
      headers: authHeader(admin.token),
      payload: { scope: 'valuation', reference_id: v.id, reason: 'temp' },
    });
    const holdId = placed.json().hold.id;

    await runRetentionSweep(ctx.pool);
    expect((await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [v.id])).rows[0].archived_at).toBeNull();

    const rel = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/holds/${holdId}/release`,
      headers: authHeader(admin.token),
    });
    expect(rel.statusCode).toBe(200);

    await runRetentionSweep(ctx.pool);
    expect((await ctx.pool.query('SELECT archived_at FROM valuations WHERE id = $1', [v.id])).rows[0].archived_at).not.toBeNull();
  });

  it('gates retention admin to admins', async () => {
    const plain = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/policies',
      headers: authHeader(plain.token),
    });
    expect(res.statusCode).toBe(403);
  });
});
