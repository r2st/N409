import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { DEAD_LINK_DETAIL } from '../../src/domain/linkRefusal.js';

const dbUp = await isDbAvailable();

/**
 * The invitation that outlived the firm it was a seat in.
 *
 * `assertAssignablePartner` refuses to mint an invitation into an archived
 * partner — "new partner assignments must reference a live (non-archived)
 * partner" — and that is the whole of the check. It runs once, up to seven days
 * before the assignment it is about actually happens, on a flag an
 * administrator can set in between.
 *
 * So a withdrawn firm's outstanding invitations went on creating live accounts
 * under it: `acceptInvitation` asked about the row's own three columns and
 * never about the `partner_id` it was copying onto a new `users` row. The
 * account arrives with the partner roles the invitation named and a console
 * session to use them from — which is the platform's soft delete for a firm
 * doing nothing at the one door that hands out a seat.
 *
 * The sibling `inviteInviterDeactivated.test.ts` is this same shape one subject
 * over, and it takes the other remedy: deactivation *revokes*, because the
 * authority was the inviter's and it is gone. Archiving is a boolean an
 * administrator can set back, so this refuses instead — the row stays pending,
 * stays listed, and works again if the firm is restored.
 */
describe.skipIf(!dbUp)('invitations into a firm that is then archived', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const createPartner = async (key: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/partners',
      headers: authHeader(admin.token),
      payload: { name: `Firm ${key}`, key },
    });
    expect(res.statusCode).toBe(201);
    return res.json().partner.id as string;
  };

  const setArchived = async (partnerId: string, archived: boolean): Promise<void> => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${partnerId}`,
      headers: authHeader(admin.token),
      payload: { archived },
    });
    expect(res.statusCode).toBe(200);
  };

  const invite = async (email: string, partnerId: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: authHeader(admin.token),
      payload: { email, roles: ['partner'], partner_id: partnerId },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM email_outbox WHERE lower(to_email) = lower($1) ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const match = /accept-invite#token=([A-Za-z0-9_-]+)/.exec(rows[0]?.body ?? '');
    if (!match) throw new Error(`no invitation link mailed to ${email}`);
    return match[1]!;
  };

  const accept = (token: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token, password: 'a-perfectly-fine-passw0rd' },
    });

  it('cannot be accepted once the firm is archived, and works again if it is restored', async () => {
    const partner = await createPartner(`arch-invite-${Date.now()}`);
    const email = `seat.${Date.now()}@example.com`;
    const token = await invite(email, partner);

    await setArchived(partner, true);

    const refused = await accept(token);
    expect(refused.statusCode).toBe(400);
    // The merged dead-link sentence every invitation refusal shares, so an
    // unauthenticated caller cannot tell "withdrawn firm" from "no such token".
    expect(refused.json().detail).toBe(DEAD_LINK_DETAIL.invitation);

    // No account was minted, and the claim was not spent: refused, not revoked.
    const { rows: users } = await ctx.pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [
      email,
    ]);
    expect(users).toHaveLength(0);
    const { rows: inv } = await ctx.pool.query<{ accepted_at: Date | null; revoked_at: Date | null }>(
      'SELECT accepted_at, revoked_at FROM user_invitations WHERE lower(email) = lower($1)',
      [email],
    );
    expect(inv).toHaveLength(1);
    expect(inv[0]!.accepted_at).toBeNull();
    expect(inv[0]!.revoked_at).toBeNull();

    // The same link, after an administrator sets the flag back.
    await setArchived(partner, false);
    const accepted = await accept(token);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().user.partner_id).toBe(partner);
  });

  it('hides the invitation from the page that would offer the form', async () => {
    const partner = await createPartner(`arch-lookup-${Date.now()}`);
    const email = `lookup.${Date.now()}@example.com`;
    const token = await invite(email, partner);

    const info = () =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/auth/invite-info', payload: { token } });

    const live = await info();
    expect(live.statusCode).toBe(200);
    expect(live.json().email).toBe(email);

    await setArchived(partner, true);

    // The accept page reads the invitation to show who it is for. Left
    // answering, it would render a form whose submit is refused — the two
    // readers share the predicate for the same reason `LIVE_LINK_SQL` is one
    // fragment: a form that opens and will not submit is worse than either
    // answer given consistently.
    const dead = await info();
    expect(dead.statusCode).toBe(400);
    expect(dead.json().detail).toBe(DEAD_LINK_DETAIL.invitation);
  });

  it('leaves an invitation with no firm behind it alone', async () => {
    // `partner_id` is null for a platform-side seat, and the predicate has to
    // pass those: an EXISTS over a NULL id matches nothing, so an unqualified
    // clause would have made every non-partner invitation unredeemable.
    const email = `platform.${Date.now()}@example.com`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: authHeader(admin.token),
      payload: { email, roles: ['reviewer'] },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM email_outbox WHERE lower(to_email) = lower($1) ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const token = /accept-invite#token=([A-Za-z0-9_-]+)/.exec(rows[0]?.body ?? '')![1]!;
    const accepted = await accept(token);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().user.partner_id).toBeNull();
  });
});
