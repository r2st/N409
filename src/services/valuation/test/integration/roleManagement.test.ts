import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Admin role promotion (admin-role-management feature A) — the additive
 * promote/demote endpoints that sit alongside the full PATCH role editor.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('admin role promotion', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let otherAdmin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    otherAdmin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(() => ctx.teardown());

  const promote = (token: string, id: string, body: unknown = { role: 'admin' }) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/promote`,
      headers: authHeader(token),
      payload: body,
    });

  const demote = (token: string, id: string, body: unknown = { role: 'admin' }) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/demote`,
      headers: authHeader(token),
      payload: body,
    });

  const rolesOf = async (id: string): Promise<string[]> => {
    const { rows } = await ctx.pool.query<{ key: string }>(
      `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [id],
    );
    return rows.map((r) => r.key);
  };

  // #1 — additive promotion keeps the existing role.
  it('promotes a client to admin without dropping their other roles', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await promote(admin.token, user.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.roles.sort()).toEqual(['admin', 'valuation_user']);
    expect((await rolesOf(user.id)).sort()).toEqual(['admin', 'valuation_user']);
  });

  // #2 — already holds the role.
  it('returns 409 when the user already has the role', async () => {
    const user = await seedUser(ctx, { roles: ['admin'] });
    const res = await promote(admin.token, user.id);
    expect(res.statusCode).toBe(409);
  });

  // #3 — non-admin caller.
  it('forbids non-admin callers', async () => {
    const target = await seedUser(ctx, { roles: ['valuation_user'] });
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    const reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    for (const actor of [client, reviewer]) {
      expect((await promote(actor.token, target.id)).statusCode).toBe(403);
      expect((await demote(actor.token, target.id)).statusCode).toBe(403);
    }
  });

  // #4 — soft-deleted target.
  it('returns 404 for a soft-deleted user', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await ctx.pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);
    expect((await promote(admin.token, user.id)).statusCode).toBe(404);
  });

  // #5 — invalid role key.
  it('rejects an invalid role key with 422', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    expect((await promote(admin.token, user.id, { role: 'wizard' })).statusCode).toBe(422);
    expect((await promote(admin.token, user.id, {})).statusCode).toBe(422);
  });

  // #6 — demote another admin.
  it('demotes another admin, removing the role', async () => {
    const user = await seedUser(ctx, { roles: ['admin', 'valuation_user'] });
    const res = await demote(admin.token, user.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.roles).toEqual(['valuation_user']);
    expect(await rolesOf(user.id)).toEqual(['valuation_user']);
  });

  // #7 — self-demotion.
  it('refuses to let an admin demote themselves', async () => {
    const res = await demote(admin.token, admin.id);
    expect(res.statusCode).toBe(422);
    expect(await rolesOf(admin.id)).toContain('admin');
  });

  // #8 — demote a role the user lacks.
  it('returns 409 when demoting a role the user does not have', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    expect((await demote(admin.token, user.id)).statusCode).toBe(409);
  });

  // #9 / #10 — audit events.
  it('records user_promoted and user_demoted audit events', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await promote(admin.token, user.id);
    await demote(otherAdmin.token, user.id);

    const { rows } = await ctx.pool.query<{ type: string; actor_id: string; payload: { role: string } }>(
      `SELECT type, actor_id, payload FROM admin_events
       WHERE subject_id = $1 AND type IN ('user_promoted', 'user_demoted') ORDER BY occurred_at`,
      [user.id],
    );
    expect(rows.map((r) => r.type)).toEqual(['user_promoted', 'user_demoted']);
    expect(rows[0]!.actor_id).toBe(admin.id);
    expect(rows[0]!.payload.role).toBe('admin');
    expect(rows[1]!.actor_id).toBe(otherAdmin.id);
  });

  // #11 — a freshly promoted user can immediately use admin routes.
  it('lets a promoted user reach admin routes right away', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    // Before promotion the console is closed to them.
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeader(user.token) }))
        .statusCode,
    ).toBe(403);

    await promote(admin.token, user.id);

    // The auth middleware re-reads roles per request, so no re-login is needed.
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeader(user.token) }))
        .statusCode,
    ).toBe(200);
  });

  it('404s for a non-existent or malformed id', async () => {
    expect((await promote(admin.token, 'not-a-ulid')).statusCode).toBe(404);
    expect((await promote(admin.token, '01N409NOSUCHUSER0000000000')).statusCode).toBe(404);
  });
});
