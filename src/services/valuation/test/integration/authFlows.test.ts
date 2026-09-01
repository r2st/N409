import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import type { GoogleOidc } from '../../src/auth/google.js';
import { createProvisionedUser, createUser } from '../../src/repos/users.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Emails go out fire-and-forget on forgot-password — poll the outbox. */
async function waitForOutbox(
  ctx: TestApp,
  toEmail: string,
  templateKey: string,
): Promise<Array<{ body: string; subject: string; status: string }>> {
  for (let i = 0; i < 40; i++) {
    const { rows } = await ctx.pool.query(
      'SELECT body, subject, status FROM email_outbox WHERE lower(to_email) = lower($1) AND template_key = $2 ORDER BY created_at ASC',
      [toEmail, templateKey],
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

async function outboxCount(ctx: TestApp, toEmail: string, templateKey: string): Promise<number> {
  // Settle window for the fire-and-forget path before asserting absence.
  await new Promise((r) => setTimeout(r, 200));
  const { rows } = await ctx.pool.query(
    'SELECT count(*)::int AS n FROM email_outbox WHERE lower(to_email) = lower($1) AND template_key = $2',
    [toEmail, templateKey],
  );
  return rows[0].n;
}

const tokenFrom = (body: string, path: string): string => {
  const match = body.match(new RegExp(`${path}#token=([A-Za-z0-9_-]+)`));
  if (!match) throw new Error(`no ${path} token in email body: ${body}`);
  return match[1]!;
};

const forgot = (ctx: TestApp, email: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email } });

const reset = (ctx: TestApp, token: string, password: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, password } });

const login = (ctx: TestApp, email: string, password: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

describe.skipIf(!dbUp)('password reset + invitations (P0 #3 / feature #9)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    partnerId = await seedPartner(ctx, 'Invite Partner');
  });
  afterAll(async () => ctx?.teardown());

  describe('forgot-password', () => {
    it('answers 202 identically for existing and unknown emails', async () => {
      const existing = await forgot(ctx, client.email);
      const unknown = await forgot(ctx, `${newUlid().toLowerCase()}@nowhere.example.com`);
      expect(existing.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(existing.body).toBe(unknown.body);
      // …but only the real account gets an email.
      expect((await waitForOutbox(ctx, client.email, 'password_reset')).length).toBe(1);
    });

    it('never emails SSO-only accounts', async () => {
      const sso = await createUser(ctx.pool, {
        email: `${newUlid().toLowerCase()}@sso.example.com`,
        ssoProvider: 'google',
        verified: true,
        roles: ['valuation_user'],
      });
      const res = await forgot(ctx, sso.email);
      expect(res.statusCode).toBe(202);
      expect(await outboxCount(ctx, sso.email, 'password_reset')).toBe(0);
    });

    it('rate-limits repeated requests per email', async () => {
      const email = `${newUlid().toLowerCase()}@ratelimit.example.com`;
      for (let i = 0; i < 3; i++) expect((await forgot(ctx, email)).statusCode).toBe(202);
      expect((await forgot(ctx, email)).statusCode).toBe(429);
    });
  });

  describe('login rate limiting (audit B-1 P1)', () => {
    it('locks out an email after 10 failed attempts, then 429s', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      // 10 wrong-password attempts are each rejected 401 (not throttled yet).
      for (let i = 0; i < 10; i++) {
        expect((await login(ctx, user.email, 'wrong-password')).statusCode).toBe(401);
      }
      // The 11th is throttled before any password check.
      expect((await login(ctx, user.email, 'wrong-password')).statusCode).toBe(429);
      // …and even the correct password is refused while the window is hot.
      expect((await login(ctx, user.email, 'test-password-123')).statusCode).toBe(429);
    });

    it('does not count successful logins toward the lockout', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      // Many correct logins in a row never trip the limiter (peek, not record).
      for (let i = 0; i < 15; i++) {
        expect((await login(ctx, user.email, 'test-password-123')).statusCode).toBe(200);
      }
    });
  });

  describe('reset-password', () => {
    it('sets a new password exactly once from the emailed link', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await forgot(ctx, user.email);
      const [email] = await waitForOutbox(ctx, user.email, 'password_reset');
      const token = tokenFrom(email!.body, '/reset-password');

      const ok = await reset(ctx, token, 'brand-new-password-1');
      expect(ok.statusCode).toBe(200);
      expect((await login(ctx, user.email, 'brand-new-password-1')).statusCode).toBe(200);
      expect((await login(ctx, user.email, 'test-password-123')).statusCode).toBe(401);

      // Single-use: replaying the link fails.
      const replay = await reset(ctx, token, 'yet-another-password-2');
      expect(replay.statusCode).toBe(400);
      expect((await login(ctx, user.email, 'brand-new-password-1')).statusCode).toBe(200);
    });

    it('rejects expired and tampered tokens', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await forgot(ctx, user.email);
      const [email] = await waitForOutbox(ctx, user.email, 'password_reset');
      const token = tokenFrom(email!.body, '/reset-password');

      expect((await reset(ctx, 'not-a-real-token', 'whatever-password-1')).statusCode).toBe(400);

      await ctx.pool.query(
        `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [user.id],
      );
      expect((await reset(ctx, token, 'whatever-password-1')).statusCode).toBe(400);
    });

    it('invalidates prior tokens when a new one is requested', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await forgot(ctx, user.email);
      await waitForOutbox(ctx, user.email, 'password_reset');
      await forgot(ctx, user.email);
      let emails = await waitForOutbox(ctx, user.email, 'password_reset');
      for (let i = 0; i < 40 && emails.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
        emails = await waitForOutbox(ctx, user.email, 'password_reset');
      }
      expect(emails.length).toBe(2);

      const first = tokenFrom(emails[0]!.body, '/reset-password');
      const second = tokenFrom(emails[1]!.body, '/reset-password');
      expect((await reset(ctx, first, 'first-token-password-1')).statusCode).toBe(400);
      expect((await reset(ctx, second, 'second-token-password-1')).statusCode).toBe(200);
    });

    /**
     * The link goes to an address, and the address can move (round 342,
     * methodology M3).
     *
     * A reset token named a `user_id` and nothing else. Three doors change
     * `users.email` — the self-service profile PATCH, the admin console's
     * `ADMIN_PATCH_COLUMNS`, SCIM — and none of them touched the token table,
     * so a link already delivered to the old mailbox still set the password and
     * bumped `session_epoch`: it took the account and signed the owner out of
     * it. Moving a login address in a hurry is what somebody does when the old
     * mailbox is the thing that was compromised.
     *
     * `email_verification_tokens` was born with this rule; migration 0204 gives
     * `password_reset_tokens` the same column, and the token carries its
     * destination rather than each email-change door remembering to sweep.
     */
    it('refuses a link issued before the login address moved', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await forgot(ctx, user.email);
      const [email] = await waitForOutbox(ctx, user.email, 'password_reset');
      const token = tokenFrom(email!.body, '/reset-password');

      // The admin console's door, which is the one that asks the subject for
      // nothing at all.
      const moved = `${newUlid().toLowerCase()}@elsewhere.example.com`;
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${user.id}`,
        headers: authHeader(admin.token),
        payload: { email: moved },
      });
      expect(patched.statusCode).toBe(200);

      expect((await reset(ctx, token, 'taken-by-the-old-inbox-1')).statusCode).toBe(400);
      // And the account is untouched: the old password still works, so nothing
      // about the refusal left it half-reset.
      expect((await login(ctx, moved, 'test-password-123')).statusCode).toBe(200);
    });

    it('still works when the address has not moved', async () => {
      // The discriminator. Without it the assertion above passes for a binding
      // that refuses every link.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await forgot(ctx, user.email);
      const [email] = await waitForOutbox(ctx, user.email, 'password_reset');
      const token = tokenFrom(email!.body, '/reset-password');
      expect((await reset(ctx, token, 'ordinary-reset-password-1')).statusCode).toBe(200);
    });

    it('honours a link minted before the column existed', async () => {
      // NULL means "not bound", not "matches nothing": rows written by the
      // previous release carry no address, and refusing them would have
      // invalidated every link in flight at deploy. `RESET_TOKEN_TTL` closes
      // that window an hour later without help.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await forgot(ctx, user.email);
      const [email] = await waitForOutbox(ctx, user.email, 'password_reset');
      const token = tokenFrom(email!.body, '/reset-password');
      await ctx.pool.query('UPDATE password_reset_tokens SET email = NULL WHERE user_id = $1', [user.id]);
      expect((await reset(ctx, token, 'legacy-row-password-1')).statusCode).toBe(200);
    });

    it('enforces the 10-char password minimum', async () => {
      const res = await reset(ctx, 'irrelevant', 'short');
      expect(res.statusCode).toBe(422);
    });
  });

  describe('change-password', () => {
    it('verifies the current password and sets the new one', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const wrong = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: authHeader(user.token),
        payload: { current_password: 'not-my-password', new_password: 'a-new-password-123' },
      });
      expect(wrong.statusCode).toBe(400);

      const ok = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: authHeader(user.token),
        payload: { current_password: 'test-password-123', new_password: 'a-new-password-123' },
      });
      expect(ok.statusCode).toBe(200);
      expect((await login(ctx, user.email, 'a-new-password-123')).statusCode).toBe(200);
      expect((await login(ctx, user.email, 'test-password-123')).statusCode).toBe(401);
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        payload: { current_password: 'x', new_password: 'a-new-password-123' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('invitations', () => {
    const invite = (token: string, payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: authHeader(token),
        payload,
      });

    it('requires a user admin', async () => {
      const res = await invite(client.token, { email: 'x@example.com', roles: ['valuation_user'] });
      expect(res.statusCode).toBe(403);
    });

    it('invites, previews, and accepts end-to-end', async () => {
      const email = `${newUlid().toLowerCase()}@invitee.example.com`;
      const created = await invite(admin.token, {
        email,
        roles: ['reviewer', 'valuation_user'],
        partner_id: partnerId,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().invitation.email).toBe(email);

      const [mail] = await waitForOutbox(ctx, email, 'user_invite');
      const token = tokenFrom(mail!.body, '/accept-invite');

      // Public preview shows who the invite is for.
      const info = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/invite-info',
        payload: { token },
      });
      expect(info.statusCode).toBe(200);
      expect(info.json().email).toBe(email);

      const accepted = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/accept-invite',
        payload: { token, password: 'invitee-password-1', first_name: 'Ada' },
      });
      expect(accepted.statusCode).toBe(201);
      const { user, token: session } = accepted.json();
      expect(user.email).toBe(email);
      expect(user.verified).toBe(true);
      expect(user.partner_id).toBe(partnerId);
      expect([...user.roles].sort()).toEqual(['reviewer', 'valuation_user']);

      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(session),
      });
      expect(me.statusCode).toBe(200);
      expect((await login(ctx, email, 'invitee-password-1')).statusCode).toBe(200);

      // Single-use.
      const replay = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/accept-invite',
        payload: { token, password: 'another-password-1' },
      });
      expect(replay.statusCode).toBe(400);
    });

    it('conflicts on existing users and duplicate pending invites', async () => {
      expect((await invite(admin.token, { email: client.email, roles: ['valuation_user'] })).statusCode).toBe(
        409,
      );

      const email = `${newUlid().toLowerCase()}@pending.example.com`;
      expect((await invite(admin.token, { email, roles: ['valuation_user'] })).statusCode).toBe(201);
      expect((await invite(admin.token, { email, roles: ['valuation_user'] })).statusCode).toBe(409);
    });

    it('revoked invitations cannot be accepted', async () => {
      const email = `${newUlid().toLowerCase()}@revoked.example.com`;
      const created = await invite(admin.token, { email, roles: ['valuation_user'] });
      const [mail] = await waitForOutbox(ctx, email, 'user_invite');
      const token = tokenFrom(mail!.body, '/accept-invite');

      const revoke = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/invitations/${created.json().invitation.id}`,
        headers: authHeader(admin.token),
      });
      expect(revoke.statusCode).toBe(204);

      const accepted = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/accept-invite',
        payload: { token, password: 'revoked-password-1' },
      });
      expect(accepted.statusCode).toBe(400);
    });

    it('resend invalidates the previous link and expired invites fail', async () => {
      const email = `${newUlid().toLowerCase()}@resend.example.com`;
      const created = await invite(admin.token, { email, roles: ['valuation_user'] });
      const id = created.json().invitation.id as string;
      const [firstMail] = await waitForOutbox(ctx, email, 'user_invite');
      const firstToken = tokenFrom(firstMail!.body, '/accept-invite');

      const resend = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/invitations/${id}/resend`,
        headers: authHeader(admin.token),
      });
      expect(resend.statusCode).toBe(200);
      let mails = await waitForOutbox(ctx, email, 'user_invite');
      for (let i = 0; i < 40 && mails.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
        mails = await waitForOutbox(ctx, email, 'user_invite');
      }
      const secondToken = tokenFrom(mails[1]!.body, '/accept-invite');

      const oldLink = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/accept-invite',
        payload: { token: firstToken, password: 'resend-password-1' },
      });
      expect(oldLink.statusCode).toBe(400);

      // Expire the refreshed invite — the new link must fail too.
      await ctx.pool.query(
        `UPDATE user_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      );
      const expired = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/accept-invite',
        payload: { token: secondToken, password: 'resend-password-1' },
      });
      expect(expired.statusCode).toBe(400);
    });

    it('lists invitations for admins only', async () => {
      const forbidden = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users/invitations',
        headers: authHeader(client.token),
      });
      expect(forbidden.statusCode).toBe(403);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users/invitations',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      const invitations = res.json().invitations as Array<Record<string, unknown>>;
      expect(invitations.length).toBeGreaterThan(0);
      expect(invitations[0]).toHaveProperty('email');
      expect(invitations[0]).toHaveProperty('expires_at');
      expect(invitations[0]).toHaveProperty('invited_by_email');
    });
  });

  describe('restore (feature #9 — reactivate deactivated accounts)', () => {
    it('restores a deactivated user so they can sign in again', async () => {
      const target = await seedUser(ctx, { roles: ['valuation_user'] });
      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${target.id}`,
        headers: authHeader(admin.token),
      });
      expect(del.statusCode).toBe(204);
      expect((await login(ctx, target.email, 'test-password-123')).statusCode).toBe(401);

      const restored = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${target.id}/restore`,
        headers: authHeader(admin.token),
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().user.deleted_at).toBeNull();
      // Deactivation dropped the roles; restore intentionally leaves them
      // empty for the admin to re-assign.
      expect(restored.json().user.password_digest).toBeUndefined();
      expect((await login(ctx, target.email, 'test-password-123')).statusCode).toBe(200);
    });

    it('404s for active users and requires a user admin', async () => {
      const active = await seedUser(ctx, { roles: ['valuation_user'] });
      const notDeleted = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${active.id}/restore`,
        headers: authHeader(admin.token),
      });
      expect(notDeleted.statusCode).toBe(404);

      const forbidden = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${active.id}/restore`,
        headers: authHeader(client.token),
      });
      expect(forbidden.statusCode).toBe(403);
    });
  });
});

/**
 * The closed account, tried at the Google door (round 272, methodology M3).
 *
 * `deleted_at` is the terminal state of a `users` row: the password route
 * refuses it with the same body an unknown address gets, and the SAML ACS
 * refuses it with `account_deactivated`. The Google callback did not ask. It
 * ran `upsertGoogleUser` — which relinked `sso_provider` and set `verified` on
 * the closed row — wrote `user_login` to the spine, minted a session and
 * redirected the browser into the SPA with the token in the fragment. Every
 * call that token then made was answered 401 by the authenticate plugin, so the
 * person was signed in to a page that could not load, and the audit trail said
 * a closed account had signed in.
 */
describe.skipIf(!dbUp)('Google SSO — a closed account is refused at the door', () => {
  let ctx: TestApp;
  const identity = { sub: 'google-oidc-sub-1', email: '', emailVerified: true };

  /** Enough of `GoogleOidc` for the callback: state round-trip, code, id_token. */
  const stubGoogle = {
    authorizationUrl: (state: string) =>
      `https://accounts.example.test/o/oauth2?state=${encodeURIComponent(state)}`,
    exchangeCode: async () => 'stub-id-token',
    verifyIdToken: async () => ({ ...identity }),
  } as unknown as GoogleOidc;

  beforeAll(async () => {
    ctx = await setupTestApp({}, { google: stubGoogle });
  });
  afterAll(async () => ctx?.teardown());

  /** A signed OIDC state, taken from the leg that mints one. */
  async function freshState(): Promise<string> {
    const start = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/google' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    if (!state) throw new Error(`no state in ${start.headers.location as string}`);
    return state;
  }

  const callback = async () =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=stub-code&state=${encodeURIComponent(await freshState())}`,
      headers: { accept: 'text/html' },
    });

  it('sends a deactivated account back to the sign-in page instead of issuing a session', async () => {
    identity.email = `${newUlid().toLowerCase()}@closed.example.com`;
    const user = await createProvisionedUser(ctx.pool, {
      email: identity.email,
      provisionedBy: 'saml',
      roles: ['valuation_user'],
    });
    await ctx.pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);

    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?sso_error=account_deactivated');
    // No token, by either route out: the fragment convention or the cookie.
    expect(res.headers.location).not.toContain('#token=');
    expect(res.headers['set-cookie']).toBeUndefined();

    // The closed row is not relinked or re-verified by a sign-in that is
    // refused — it looks the same afterwards as before.
    const { rows } = await ctx.pool.query<{ sso_provider: string | null; provisioned_by: string | null }>(
      'SELECT sso_provider, provisioned_by FROM users WHERE id = $1',
      [user.id],
    );
    expect(rows[0]).toMatchObject({ sso_provider: null, provisioned_by: 'saml' });
  });

  it('records the refusal as a failed sign-in, not as a sign-in', async () => {
    const { rows } = await ctx.pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM admin_events
        WHERE subject_label = $1 ORDER BY occurred_at ASC`,
      [identity.email],
    );
    expect(rows.map((r) => r.type)).toEqual(['user_login_failed']);
    expect(rows[0]!.payload).toMatchObject({ method: 'google', reason: 'closed_account' });
  });

  it('still signs in an account that is open', async () => {
    identity.email = `${newUlid().toLowerCase()}@open.example.com`;
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/auth\/google\/complete#token=/);
  });

  /*
   * The second door onto account creation (R325, methodology M6).
   *
   * `registration_enabled` off means "new accounts can only be created by
   * invitation", and it was read by `POST /auth/register` and nowhere else — so
   * the Google button on the public sign-in page went on minting a seat for any
   * identity that had never signed in here.
   */
  describe('with self-service registration closed', () => {
    async function setRegistration(enabled: boolean): Promise<void> {
      const admin = await seedUser(ctx, { roles: ['admin'] });
      const res = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/settings',
        headers: authHeader(admin.token),
        payload: { registration_enabled: enabled },
      });
      expect(res.statusCode).toBe(200);
    }

    afterAll(async () => setRegistration(true));

    it('refuses an address it has never seen instead of provisioning one', async () => {
      await setRegistration(false);
      identity.email = `${newUlid().toLowerCase()}@stranger.example.com`;
      const res = await callback();
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login?sso_error=registration_closed');
      expect(res.headers['set-cookie']).toBeUndefined();
      const { rowCount } = await ctx.pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [
        identity.email,
      ]);
      expect(rowCount).toBe(0);
    });

    it('still signs in an account that already exists', async () => {
      // The other half of the same sentence: closing registration must not sign
      // the firm out of the product.
      identity.email = `${newUlid().toLowerCase()}@member.example.com`;
      await setRegistration(true);
      expect((await callback()).headers.location).toMatch(/^\/auth\/google\/complete#token=/);
      await setRegistration(false);
      expect((await callback()).headers.location).toMatch(/^\/auth\/google\/complete#token=/);
    });
  });
});
