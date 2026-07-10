import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Self-service account settings (profile, sessions, personal API tokens,
 * closing an account), the admin user tools that sit alongside them, and the
 * runtime system settings that gate registration and maintenance mode.
 */

const dbUp = await isDbAvailable();

const SEED_PASSWORD = 'test-password-123';

describe.skipIf(!dbUp)('account settings', () => {
  let ctx: TestApp;
  /** A second admin, so close-account never trips the last-admin guard. */
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let otherAdmin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    otherAdmin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(() => ctx.teardown());

  const me = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeader(token) });

  const patchMe = (token: string, body: unknown) =>
    ctx.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: authHeader(token), payload: body });

  // ── Profile ────────────────────────────────────────────────────────────────

  describe('profile', () => {
    it('returns the caller’s own profile', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await me(user.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ id: user.id, email: user.email });
      // A profile response must never carry the password digest.
      expect(res.json().user.password_digest).toBeUndefined();
    });

    it('updates name, phone, company, job title and timezone', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await patchMe(user.token, {
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: '+1 555 0100',
        company_name: 'Analytical Engines Inc',
        job_title: 'Founder',
        timezone: 'Europe/London',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: '+1 555 0100',
        company_name: 'Analytical Engines Inc',
        job_title: 'Founder',
        timezone: 'Europe/London',
      });
    });

    it('clears a field when it is sent as an empty string', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await patchMe(user.token, { job_title: 'Founder' });
      const res = await patchMe(user.token, { job_title: '' });
      expect(res.json().user.job_title).toBeNull();
    });

    it('rejects an unknown timezone', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await patchMe(user.token, { timezone: 'Mars/Olympus_Mons' });
      expect(res.statusCode).toBe(422);
    });

    it('rejects unknown fields rather than silently ignoring them', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      // `roles` and `verified` are admin-only — a client must not self-promote.
      expect((await patchMe(user.token, { roles: ['admin'] })).statusCode).toBe(422);
      expect((await patchMe(user.token, { verified: true })).statusCode).toBe(422);
      expect((await patchMe(user.token, { partner_id: 'x' })).statusCode).toBe(422);
    });

    it('requires authentication', async () => {
      expect((await ctx.app.inject({ method: 'PATCH', url: '/api/v1/me', payload: {} })).statusCode).toBe(
        401,
      );
    });
  });

  describe('email change', () => {
    it('requires the current password', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await patchMe(user.token, { email: 'moved@test.example.com' });
      expect(res.statusCode).toBe(422);
      expect((await me(user.token)).json().user.email).toBe(user.email);
    });

    it('rejects a wrong current password', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await patchMe(user.token, {
        email: 'moved2@test.example.com',
        current_password: 'not-the-password',
      });
      expect(res.statusCode).toBe(400);
      expect((await me(user.token)).json().user.email).toBe(user.email);
    });

    it('changes the email and marks it unverified', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query('UPDATE users SET verified = true WHERE id = $1', [user.id]);
      const res = await patchMe(user.token, {
        email: 'ada@test.example.com',
        current_password: SEED_PASSWORD,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: 'ada@test.example.com', verified: false });

      // The new address is the login identifier from now on.
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@test.example.com', password: SEED_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    });

    it('rejects an email already taken by another account', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await patchMe(user.token, {
        email: admin.email,
        current_password: SEED_PASSWORD,
      });
      expect(res.statusCode).toBe(409);
    });

    it('treats resubmitting the same email as a no-op', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query('UPDATE users SET verified = true WHERE id = $1', [user.id]);
      // No current_password, and differing only by case — must not demand
      // re-authentication and must not reset `verified`.
      const res = await patchMe(user.token, { email: user.email.toUpperCase(), first_name: 'Same' });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ verified: true, first_name: 'Same' });
    });
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  describe('session revocation', () => {
    it('sign-out-everywhere kills old tokens and returns a working replacement', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stale = user.token;

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/me/sessions/revoke',
        headers: authHeader(stale),
      });
      expect(res.statusCode).toBe(200);
      const fresh = res.json().token as string;
      expect(fresh).not.toBe(stale);

      expect((await me(stale)).statusCode).toBe(401);
      expect((await me(fresh)).statusCode).toBe(200);
    });

    it('changing the password signs out other sessions', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      // A second sign-in, standing in for another device.
      const other = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: user.email, password: SEED_PASSWORD },
        })
      ).json().token as string;

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: authHeader(user.token),
        payload: { current_password: SEED_PASSWORD, new_password: 'a-brand-new-password' },
      });
      expect(res.statusCode).toBe(200);

      expect((await me(other)).statusCode).toBe(401);
      expect((await me(user.token)).statusCode).toBe(401);
      // …but the token handed back to the caller keeps this session alive.
      expect((await me(res.json().token as string)).statusCode).toBe(200);
    });

    it('resetting the password signs out every session', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email: user.email },
      });
      // Mint a token directly: the emailed secret isn't observable from here.
      const { createPasswordResetToken } = await import('../../src/repos/passwordResets.js');
      const secret = await createPasswordResetToken(ctx.pool, user.id);

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: { token: secret, password: 'another-new-password' },
      });
      expect(res.statusCode).toBe(200);
      expect((await me(user.token)).statusCode).toBe(401);
    });

    it('a session token minted before the epoch claim existed still works', async () => {
      // Guards the deploy: old JWTs carry no session_epoch and must read as 0.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { SignJWT } = await import('jose');
      const legacy = await new SignJWT({ roles: ['valuation_user'], partner_id: null })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuer('n409')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('integration-test-secret-0123456789abcdef'));
      expect((await me(legacy)).statusCode).toBe(200);
    });
  });

  // ── Personal API tokens ────────────────────────────────────────────────────

  describe('personal API tokens', () => {
    const mint = async (token: string, name: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: authHeader(token),
        payload: { name },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { token: { id: string; partner_id: string | null }; secret: string };
    };

    it('mints a token that authenticates as its owner', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { token, secret } = await mint(user.token, 'scripting');
      expect(secret).toMatch(/^n409_pat_/);
      expect(token.partner_id).toBeNull();

      const res = await me(secret);
      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(user.id);
    });

    it('lists the owner’s tokens without ever re-exposing the secret', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { secret } = await mint(user.token, 'ci');
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: authHeader(user.token),
      });
      expect(res.statusCode).toBe(200);
      const tokens = res.json().tokens as Array<{ name: string; token_prefix: string }>;
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.name).toBe('ci');
      expect(res.body).not.toContain(secret);
    });

    it('revokes a token, and the secret stops working', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { token, secret } = await mint(user.token, 'temporary');
      expect((await me(secret)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${token.id}`,
        headers: authHeader(user.token),
      });
      expect(res.statusCode).toBe(204);
      expect((await me(secret)).statusCode).toBe(401);
    });

    it('will not let one user revoke another’s token', async () => {
      const owner = await seedUser(ctx, { roles: ['valuation_user'] });
      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      const { token, secret } = await mint(owner.token, 'private');

      // 404, not 403 — a stranger shouldn't learn the token exists. Not even
      // an admin may revoke a personal token they don't own.
      for (const actor of [stranger.token, admin.token]) {
        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/me/tokens/${token.id}`,
          headers: authHeader(actor),
        });
        expect(res.statusCode).toBe(404);
      }
      expect((await me(secret)).statusCode).toBe(200);
    });

    it('is rejected by the partner API, which needs an organisation to scope to', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { secret } = await mint(user.token, 'not-a-partner-key');
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/partner/v1/valuations',
        headers: authHeader(secret),
      });
      expect(res.statusCode).toBe(403);
    });

    it('sign-out-everywhere does not revoke API tokens', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { secret } = await mint(user.token, 'integration');
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/me/sessions/revoke',
        headers: authHeader(user.token),
      });
      expect((await me(secret)).statusCode).toBe(200);
    });
  });

  // ── Close account ──────────────────────────────────────────────────────────

  describe('closing an account', () => {
    const close = (token: string, body: unknown = {}) =>
      ctx.app.inject({ method: 'DELETE', url: '/api/v1/me', headers: authHeader(token), payload: body });

    it('requires the current password', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      expect((await close(user.token)).statusCode).toBe(422);
      expect((await close(user.token, { current_password: 'wrong' })).statusCode).toBe(400);
      expect((await me(user.token)).statusCode).toBe(200);
    });

    it('closes the account, killing sessions and API tokens', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const secret = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/me/tokens',
          headers: authHeader(user.token),
          payload: { name: 'doomed' },
        })
      ).json().secret as string;

      expect((await close(user.token, { current_password: SEED_PASSWORD })).statusCode).toBe(204);

      expect((await me(user.token)).statusCode).toBe(401);
      expect((await me(secret)).statusCode).toBe(401);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: user.email, password: SEED_PASSWORD },
      });
      expect(login.statusCode).toBe(401);
    });

    it('records the closure in the audit log', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await close(user.token, { current_password: SEED_PASSWORD });
      const { rows } = await ctx.pool.query(
        `SELECT type, actor_id FROM admin_events WHERE subject_id = $1 AND type = 'account_closed'`,
        [user.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_id).toBe(user.id);
    });

    it('lets an admin close their own account while another admin remains', async () => {
      expect((await close(otherAdmin.token, { current_password: SEED_PASSWORD })).statusCode).toBe(204);
    });

    it('refuses to remove the last administrator', async () => {
      // A dedicated database, so `admin` really is the only one left.
      const solo = await setupTestApp();
      try {
        const only = await seedUser(solo, { roles: ['admin'] });
        await seedUser(solo, { roles: ['valuation_user'] });
        const res = await solo.app.inject({
          method: 'DELETE',
          url: '/api/v1/me',
          headers: authHeader(only.token),
          payload: { current_password: SEED_PASSWORD },
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toMatch(/only administrator/i);
      } finally {
        await solo.teardown();
      }
    });
  });

  // ── Admin user tools ───────────────────────────────────────────────────────

  describe('admin user tools', () => {
    it('sends a password reset link to a user', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/send-password-reset`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);

      const { rows } = await ctx.pool.query(
        'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
        [user.id],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses to send a reset link to an SSO account', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query(
        `UPDATE users SET password_digest = NULL, sso_provider = 'google' WHERE id = $1`,
        [user.id],
      );
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/send-password-reset`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it('force-signs-out a user', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      expect((await me(user.token)).statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/revoke-sessions`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      expect((await me(user.token)).statusCode).toBe(401);
    });

    it('will not let an admin revoke their own sessions from the console', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${admin.id}/revoke-sessions`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(422);
      expect((await me(admin.token)).statusCode).toBe(200);
    });

    it('denies both tools to non-admins', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const reviewer = await seedUser(ctx, { roles: ['reviewer'] });
      for (const path of ['send-password-reset', 'revoke-sessions']) {
        for (const actor of [user, reviewer]) {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/users/${user.id}/${path}`,
            headers: authHeader(actor.token),
          });
          expect(res.statusCode).toBe(403);
        }
      }
    });
  });
});

// ── System settings ──────────────────────────────────────────────────────────

describe.skipIf(!dbUp)('system settings', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(() => ctx.teardown());

  const put = (token: string, body: unknown) =>
    ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: authHeader(token),
      payload: body,
    });

  it('serves a strict public subset to anonymous callers', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/settings' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().settings).sort()).toEqual([
      'maintenance_mode',
      'registration_enabled',
      'support_email',
    ]);
  });

  it('returns defaults before anything has been written', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      registration_enabled: true,
      maintenance_mode: false,
      password_min_length: 10,
    });
    expect(res.json().updated).toEqual({});
  });

  it('is readable by ops, writable only by user-admins', async () => {
    const read = (token: string) =>
      ctx.app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers: authHeader(token) });

    expect((await read(reviewer.token)).statusCode).toBe(200);
    expect((await read(reviewer.token)).json().editable).toBe(false);
    expect((await read(client.token)).statusCode).toBe(403);

    expect((await put(reviewer.token, { maintenance_mode: true })).statusCode).toBe(403);
    expect((await put(client.token, { maintenance_mode: true })).statusCode).toBe(403);
  });

  it('rejects unknown keys and out-of-range values', async () => {
    expect((await put(admin.token, { nonsense: true })).statusCode).toBe(422);
    expect((await put(admin.token, {})).statusCode).toBe(422);
    // 8 is below the hard floor the route schemas already enforce.
    expect((await put(admin.token, { password_min_length: 8 })).statusCode).toBe(422);
    expect((await put(admin.token, { support_email: 'not-an-email' })).statusCode).toBe(422);
  });

  it('persists a write and audits it', async () => {
    const res = await put(admin.token, { support_email: 'help@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.support_email).toBe('help@example.com');

    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/settings' });
    expect(pub.json().settings.support_email).toBe('help@example.com');

    const { rows } = await ctx.pool.query(
      `SELECT payload FROM admin_events WHERE type = 'system_settings_updated'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ changed: { support_email: 'help@example.com' } });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      headers: authHeader(admin.token),
    });
    expect(detail.json().updated.support_email.updated_by).toBe(admin.id);
  });

  it('registration_enabled=false closes self-service sign-up', async () => {
    const register = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: `signup-${Date.now()}@test.example.com`, password: 'a-good-password' },
      });

    expect((await put(admin.token, { registration_enabled: false })).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(403);

    expect((await put(admin.token, { registration_enabled: true })).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(201);
  });

  it('password_min_length tightens the floor for every password entry point', async () => {
    await put(admin.token, { password_min_length: 16 });
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'shortpw@test.example.com', password: 'twelve-chars' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/at least 16/);

      const change = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: authHeader(client.token),
        payload: { current_password: SEED_PASSWORD, new_password: 'twelve-chars' },
      });
      expect(change.statusCode).toBe(422);
    } finally {
      await put(admin.token, { password_min_length: 10 });
    }
  });

  it('maintenance_mode makes the platform read-only for everyone but ops', async () => {
    await put(admin.token, { maintenance_mode: true });
    try {
      // Clients can still read…
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeader(client.token) }))
          .statusCode,
      ).toBe(200);
      // …but not write.
      const write = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: authHeader(client.token),
        payload: { first_name: 'Nope' },
      });
      expect(write.statusCode).toBe(503);

      // Ops keep working — including the write that turns maintenance back off.
      const opsWrite = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: authHeader(reviewer.token),
        payload: { first_name: 'Still working' },
      });
      expect(opsWrite.statusCode).toBe(200);

      // Sign-in is unauthenticated and stays up, so nobody is locked out.
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: client.email, password: SEED_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    } finally {
      await put(admin.token, { maintenance_mode: false });
    }
    expect(
      (
        await ctx.app.inject({
          method: 'PATCH',
          url: '/api/v1/me',
          headers: authHeader(client.token),
          payload: { first_name: 'Fine now' },
        })
      ).statusCode,
    ).toBe(200);
  });
});
