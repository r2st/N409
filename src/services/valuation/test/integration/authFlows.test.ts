import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createUser } from '../../src/repos/users.js';
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
      expect(
        (await invite(admin.token, { email: client.email, roles: ['valuation_user'] })).statusCode,
      ).toBe(409);

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
