import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, SEEDED_PASSWORD, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { DEAD_LINK_DETAIL } from '../../src/domain/linkRefusal.js';

const dbUp = await isDbAvailable();

/**
 * The invitation that outlived the authority it was minted with.
 *
 * An invitation is an administrator's authority written down and posted: it
 * carries whatever roles they chose — up to `god` — and stays redeemable for
 * seven days by whoever holds the link. Deactivating an account is this
 * platform's "this person's access ends now": sessions 401 on the next request
 * and API tokens stop resolving because their owner is closed.
 *
 * Pending invitations were the one thing that survived it. An administrator on
 * their way out could invite an address they control with `god`, be
 * deactivated that afternoon, and accept the invitation six days later — a
 * fresh administrator account, minted through the front door, with the offboarding
 * complete and every other trace of them gone.
 *
 * So deactivation retires them, in the transaction that closes the account: the
 * invitation's authority is the inviter's, and it cannot outlast it.
 */
describe.skipIf(!dbUp)('invitations issued by an account that is then deactivated', () => {
  let ctx: TestApp;
  let root: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    root = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  /** The invitation's raw token, read back from the mail the route sent. */
  const tokenFor = async (email: string): Promise<string> => {
    const { rows } = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM email_outbox WHERE lower(to_email) = lower($1) ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const match = /accept-invite#token=([A-Za-z0-9_-]+)/.exec(rows[0]?.body ?? '');
    if (!match) throw new Error(`no invitation link mailed to ${email}`);
    return match[1]!;
  };

  it('cannot be accepted once the inviter is deactivated', async () => {
    const leaving = await seedUser(ctx, { roles: ['admin'] });
    const invitee = `successor.${Date.now()}@example.com`;

    const invited = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: authHeader(leaving.token),
      payload: { current_password: SEEDED_PASSWORD, email: invitee, roles: ['god'] },
    });
    expect(invited.statusCode).toBe(201);
    const token = await tokenFor(invitee);

    const closed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${leaving.id}`,
      headers: authHeader(root.token),
    });
    expect(closed.statusCode).toBe(204);

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token, password: 'a-perfectly-fine-passw0rd' },
    });
    expect(accepted.statusCode).toBe(400);
    // The shared refusal for every dead invitation state — merged on purpose,
    // so a guesser cannot tell "withdrawn" from "never existed".
    expect(accepted.json().detail).toBe(DEAD_LINK_DETAIL.invitation);

    // Retired rather than deleted: the console keeps showing who invited whom.
    const { rows } = await ctx.pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM user_invitations WHERE lower(email) = lower($1)',
      [invitee],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it('leaves the invitations of every other administrator alone', async () => {
    const leaving = await seedUser(ctx, { roles: ['admin'] });
    const mine = `kept.${Date.now()}@example.com`;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: authHeader(root.token),
      payload: { current_password: SEEDED_PASSWORD, email: mine, roles: ['valuation_user'] },
    });
    const token = await tokenFor(mine);

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${leaving.id}`,
      headers: authHeader(root.token),
    });

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token, password: 'a-perfectly-fine-passw0rd' },
    });
    expect(accepted.statusCode).toBe(201);
  });
});
