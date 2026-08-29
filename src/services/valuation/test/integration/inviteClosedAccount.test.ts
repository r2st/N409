import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Inviting an address that already has a closed account.
 *
 * The two ends of the invitation lifecycle asked different questions about the
 * same address. `POST /users/invite` refused only a *live* account
 * (`existing && !existing.deleted_at`), so an address whose account had been
 * closed — self-service, by an administrator, or by a directory deprovision —
 * was declared free and an invitation went out. `acceptInvitation` then asked
 * whether *any* `users` row holds the address, which it does: a closed account
 * is a soft delete and the row and its `users_email_key` index are still there.
 *
 * So the invitee followed a link that worked, chose a password that passed the
 * policy, and was told at the last step that an account with their email
 * already exists — for an account they cannot sign into, with no way forward
 * from that page. The invitation stayed pending in the console, so the
 * administrator's own screen agreed with the version of events that was wrong.
 *
 * The refusal belongs at the invite, where the person who can act on it is
 * standing: restore the account and send a reset. That path already exists
 * (`POST /users/:id/restore`, `POST /users/:id/send-password-reset`) and is
 * the only one that can work, because the address is spoken for either way.
 */
describe.skipIf(!dbUp)('inviting an address whose account was closed', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const auth = () => authHeader(admin.token);

  const invite = (email: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: auth(),
      payload: { email, roles: ['valuation_user'] },
    });

  it('refuses at the invite rather than at the acceptance', async () => {
    const victim = await seedUser(ctx, { roles: ['valuation_user'] });
    const closed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${victim.id}`,
      headers: auth(),
    });
    expect(closed.statusCode).toBe(204);

    const res = await invite(victim.email);
    expect(res.statusCode).toBe(409);
    // Naming the remedy: the generic "already exists" is what the *accept* end
    // said, and it is what left the administrator with nothing to do.
    expect(res.json().detail).toMatch(/closed|restore/i);

    // And nothing was sent — the row must not exist for the console to show.
    const { rows } = await ctx.pool.query('SELECT 1 FROM user_invitations WHERE lower(email) = lower($1)', [
      victim.email,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('still invites an address with no account at all', async () => {
    const res = await invite(`fresh.${Date.now()}@example.com`);
    expect(res.statusCode).toBe(201);
  });
});
