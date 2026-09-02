import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

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
    /**
     * The client cannot infer this one (round 359, methodology M4).
     *
     * Five controls on the settings page ask "is there a password to confirm?"
     * and asked it as `sso_provider !== 'google'`. `sso_provider` is only ever
     * `'google'` or null, and migration 0082 allows a third account: SAML- or
     * SCIM-provisioned, with neither. Those were shown password forms they
     * could never submit, so the answer is stated here instead.
     */
    it('says whether the account has a password, which sso_provider cannot', async () => {
      const passworded = await seedUser(ctx, { roles: ['valuation_user'] });
      expect((await me(passworded.token)).json().user).toMatchObject({
        sso_provider: null,
        has_password: true,
      });

      const provisioned = await seedUser(ctx, { roles: ['valuation_user'] });
      // What SCIM/SAML provisioning leaves behind: no digest, no sso_provider.
      await ctx.pool.query(`UPDATE users SET password_digest = NULL, provisioned_by = 'scim' WHERE id = $1`, [
        provisioned.id,
      ]);
      expect((await me(provisioned.token)).json().user).toMatchObject({
        sso_provider: null,
        has_password: false,
      });
    });

    /**
     * One projection, not two (round 359, methodology M4).
     *
     * `routes/auth.ts` and `routes/account.ts` each built the public user by
     * hand, and the lists had drifted: `totp_enabled` was added to the sign-in
     * copy when MFA shipped and never to `/me`, which is the bootstrap read —
     * so a reloaded tab held an account object the sign-in response would not
     * have recognised. Both now come from `domain/publicUser.ts`, and this
     * compares the key sets rather than any one field, because the next field
     * to be added to one and not the other is the point.
     */
    it('serves the same account shape from sign-in and from /me', async () => {
      const password = SEED_PASSWORD;
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: user.email, password },
      });
      expect(login.statusCode, login.body).toBe(200);
      const fromLogin = Object.keys(login.json().user as Record<string, unknown>).sort();
      const fromMe = Object.keys((await me(user.token)).json().user as Record<string, unknown>).sort();
      expect(fromMe).toEqual(fromLogin);
      expect(fromMe).toContain('totp_enabled');
      expect(fromMe).toContain('has_password');
      // And the digest is in neither.
      expect(fromMe).not.toContain('password_digest');
    });

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
        // Stored canonically, whatever spacing it arrived with.
        phone: '+15550100',
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

    it('normalizes however a phone number was typed to one stored shape', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      for (const typed of ['+1 (555) 123-4567', '+1 555.123.4567', '001 555 123 4567']) {
        const res = await patchMe(user.token, { phone: typed });
        expect(res.statusCode).toBe(200);
        expect(res.json().user.phone).toBe('+15551234567');
      }
      // A bracketed trunk prefix is how most of Europe writes a number; the
      // zero is dialled domestically and must not survive into storage.
      const uk = await patchMe(user.token, { phone: '+44 (0)20 7946 0000' });
      expect(uk.json().user.phone).toBe('+442079460000');
    });

    it('rejects a phone number no gateway could dial', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      // No country code at all — the shape the field accepted before it was
      // validated, and the shape an SMS campaign silently failed to deliver to.
      expect((await patchMe(user.token, { phone: '(555) 123-4567' })).statusCode).toBe(422);
      expect((await patchMe(user.token, { phone: '+1234' })).statusCode).toBe(422);
      expect((await patchMe(user.token, { phone: '+4912345678901234' })).statusCode).toBe(422);
      expect((await patchMe(user.token, { phone: '+1 555 CALL' })).statusCode).toBe(422);
    });

    it('clears the phone when it is sent as an empty string', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await patchMe(user.token, { phone: '+15551234567' });
      expect((await patchMe(user.token, { phone: '' })).json().user.phone).toBeNull();
      await patchMe(user.token, { phone: '+15551234567' });
      expect((await patchMe(user.token, { phone: null })).json().user.phone).toBeNull();
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
        payload: { current_password: SEED_PASSWORD, new_password: 'a-brand-new-password1' },
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
        payload: { token: secret, password: 'another-new-password1' },
      });
      expect(res.statusCode).toBe(200);
      expect((await me(user.token)).statusCode).toBe(401);
    });

    it('a session token carrying no epoch claim reads as epoch 0, not as revoked', async () => {
      // A missing epoch grants nothing by itself — it is compared against
      // `users.session_epoch`, and 0 matches the column default — so it stays
      // the lenient reading. `purpose` and `aud` are gates and are not.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { SignJWT } = await import('jose');
      const noEpoch = await new SignJWT({
        purpose: 'session',
        roles: ['valuation_user'],
        partner_id: null,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuer('n409')
        .setAudience('n409-valuation')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('integration-test-secret-0123456789abcdef'));
      expect((await me(noEpoch)).statusCode).toBe(200);
    });

    it('refuses a token that carries neither a purpose nor an audience', async () => {
      // Both allowances existed only to spare live sessions the deploy that
      // added each claim. Together they left one shape that answered neither
      // check — a forged or cross-flow token naming any `sub` it liked.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { SignJWT } = await import('jose');
      const unpurposed = await new SignJWT({ roles: ['admin'], partner_id: null })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuer('n409')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('integration-test-secret-0123456789abcdef'));
      expect((await me(unpurposed)).statusCode).toBe(401);
    });
  });

  // ── Personal API tokens ────────────────────────────────────────────────────

  describe('personal API tokens', () => {
    const mintRaw = (token: string, payload: unknown) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: authHeader(token), payload });

    const mint = async (token: string, name: string) => {
      // The password rides along on every mint: issuing a token is a
      // credential-level action and is re-authenticated like the rest of them.
      const res = await mintRaw(token, { name, current_password: SEED_PASSWORD });
      expect(res.statusCode).toBe(201);
      return res.json() as { token: { id: string; partner_id: string | null }; secret: string };
    };

    /**
     * Why a password stands in front of a mint.
     *
     * A personal token is the only credential on this platform that outlives
     * everything meant to take access away: `bumpSessionEpoch` — what a
     * password change and "sign out everywhere" both do — deliberately does not
     * revoke API tokens, so a borrowed session that could mint one bought
     * permanent access to the account, and the owner's obvious response to the
     * theft would not have taken it back. Everything else at that level
     * (changing the password or the login email, closing the account, disabling
     * 2FA, regenerating backup codes) already asked; this was the omission, and
     * the only one of the set that *creates* a credential rather than changing
     * one.
     */
    it('refuses to mint without the current password', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await mintRaw(user.token, { name: 'no-password' });
      expect(res.statusCode).toBe(422);
      // The field is named, so the form can mark it rather than showing a
      // sentence next to a box the user has already filled.
      expect(res.json().errors).toEqual([{ path: ['current_password'] }]);

      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: authHeader(user.token),
      });
      expect(after.json().tokens).toEqual([]);
    });

    it('refuses to mint on a wrong password', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await mintRaw(user.token, { name: 'guessed', current_password: 'not-the-password' });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe('Current password is incorrect');
    });

    /**
     * No token mints its successor.
     *
     * The password check alone does not settle this — an SSO-only account has
     * no digest to check — and it is the case that makes revocation mean
     * something: if a leaked key's last act can be to issue a replacement, then
     * revoking it ends nothing.
     */
    it('refuses a mint authenticated by an API token, password or not', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { secret } = await mint(user.token, 'first');
      const res = await mintRaw(secret, { name: 'second', current_password: SEED_PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toContain('cannot mint another API token');

      // Exactly the one token, so the refusal is a refusal and not a 403 after
      // the row was written.
      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: authHeader(user.token),
      });
      expect(after.json().tokens).toHaveLength(1);
    });

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

    it('records the withdrawal once when the control is pressed twice', async () => {
      // The personal list returns revoked tokens unfiltered, so the control is
      // still on screen after the first press; the second used to answer 204
      // and write a second `api_token_revoked` (round 356, methodology M3).
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { token } = await mint(user.token, 'pressed-twice');
      const revoke = () =>
        ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/me/tokens/${token.id}`,
          headers: authHeader(user.token),
        });
      expect((await revoke()).statusCode).toBe(204);
      const again = await revoke();
      expect(again.statusCode).toBe(404);
      expect(again.json().detail).toMatch(/already been revoked/i);

      const { rows } = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM admin_events
          WHERE type = 'api_token_revoked' AND subject_id = $1`,
        [token.id],
      );
      expect(rows[0]!.n).toBe('1');
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
      await ctx.pool.query(`UPDATE users SET password_digest = NULL, sso_provider = 'google' WHERE id = $1`, [
        user.id,
      ]);
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
        payload: { email: `signup-${Date.now()}@test.example.com`, password: 'a-good-password1' },
      });

    expect((await put(admin.token, { registration_enabled: false })).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(403);

    expect((await put(admin.token, { registration_enabled: true })).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(201);
  });

  it('password_min_length tightens the floor for every password entry point', async () => {
    // "Every" used to mean two of them. `POST /api/v1/users` — the admin
    // console's create-user form, whose accounts tend to be the privileged
    // ones — validated `min(10)` in its zod schema and nothing else, so a
    // deployment configured to 16 went on accepting ten-character passwords
    // through it. The two entry points this drove were the two that already
    // worked. See `passwordEntryPoints.test.ts` for the guard that stops the
    // list going stale again.
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

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: authHeader(admin.token),
        payload: {
          current_password: SEEDED_PASSWORD,
          email: 'shortpw-admin@test.example.com',
          password: 'twelve-chars1',
          roles: ['valuation_user'],
        },
      });
      expect(created.statusCode).toBe(422);
      expect(created.json().detail).toMatch(/at least 16/);
    } finally {
      await put(admin.token, { password_min_length: 10 });
    }
  });

  it('refuses a password with no letter or no digit at every entry point too', async () => {
    // The complexity half was missing from the admin console outright, at the
    // default minimum: '1234567890' was refused at registration, at reset, at
    // invite acceptance and at change-password, and created here.
    const complexity = /at least one letter and one number/;

    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'nodigits@test.example.com', password: 'abcdefghij' },
    });
    expect(registered.statusCode).toBe(422);
    expect(registered.json().detail).toMatch(complexity);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
      payload: {
        current_password: SEEDED_PASSWORD,
        email: 'nodigits-admin@test.example.com',
        password: 'abcdefghij',
        roles: ['valuation_user'],
      },
    });
    expect(created.statusCode).toBe(422);
    expect(created.json().detail).toMatch(complexity);

    const noLetters = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
      payload: {
        current_password: SEEDED_PASSWORD,
        email: 'nolettrs-admin@test.example.com',
        password: '1234567890',
        roles: ['valuation_user'],
      },
    });
    expect(noLetters.statusCode).toBe(422);
    expect(noLetters.json().detail).toMatch(complexity);

    // …and still creates an account whose password satisfies both halves.
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
      payload: {
        current_password: SEEDED_PASSWORD,
        email: 'goodpw-admin@test.example.com',
        password: 'abcdefghij1',
        roles: ['valuation_user'],
      },
    });
    expect(ok.statusCode).toBe(201);
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
