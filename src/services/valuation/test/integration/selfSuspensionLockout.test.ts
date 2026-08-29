import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The lockout guard has to be about the access, not about the role name.
 *
 * `PATCH /users/:id` and `POST /users/:id/demote` both refuse to let an
 * administrator take their own administration away — without it, one careless
 * edit ends with a console nobody can open and no route back in. Both
 * expressed the rule as "the set you are left with still contains one of
 * `admin`/`god`/`supervisor`".
 *
 * That is not the same question, because `ignored` subtracts: it is this
 * platform's suspension, and a principal holding `admin` + `ignored` can
 * administer nothing (`auth/rbac.ts`). So `roles: ['admin', 'ignored']` and
 * `promote { role: 'ignored' }` both passed a guard written to prevent exactly
 * the state they produce — and on the last administrator, that is the whole
 * platform.
 *
 * Asked through `canManageUsers`, over the roles the write would leave behind,
 * both spellings are the same question and neither can get through.
 */
describe.skipIf(!dbUp)('an administrator suspending themselves', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const auth = () => authHeader(admin.token);
  const rolesOf = async (id: string): Promise<string[]> => {
    const { rows } = await ctx.pool.query<{ key: string }>(
      `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [id],
    );
    return rows.map((r) => r.key).sort();
  };

  it('refuses a self-PATCH that adds the suspension alongside the admin role', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${admin.id}`,
      headers: auth(),
      payload: { roles: ['admin', 'ignored'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/your own admin access/i);
    expect(await rolesOf(admin.id)).toEqual(['admin']);
  });

  it('refuses promoting yourself into the suspension', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${admin.id}/promote`,
      headers: auth(),
      payload: { role: 'ignored' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/your own admin access/i);
    expect(await rolesOf(admin.id)).toEqual(['admin']);
  });

  it('still lets an administrator suspend somebody else', async () => {
    const other = await seedUser(ctx, { roles: ['admin'] });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${other.id}/promote`,
      headers: auth(),
      payload: { role: 'ignored' },
    });
    expect(res.statusCode).toBe(200);
    expect(await rolesOf(other.id)).toEqual(['admin', 'ignored']);

    // And the suspension is real: the console closes behind them.
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeader(other.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('still lets an administrator rearrange their own admin-tier roles', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${admin.id}`,
      headers: auth(),
      payload: { roles: ['admin', 'reviewer'] },
    });
    expect(res.statusCode).toBe(200);
    expect(await rolesOf(admin.id)).toEqual(['admin', 'reviewer']);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${admin.id}`,
      headers: auth(),
      payload: { roles: ['admin'] },
    });
  });
});
