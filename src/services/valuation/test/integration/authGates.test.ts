import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { upsertSamlConfig } from '../../src/repos/ssoConfig.js';
import { totp } from '../../src/auth/totp.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The auth surfaces answering something other than yes.
 *
 * `authFlows.test.ts` and `authSurfaces.test.ts` walk the flows; what neither
 * reaches is the set of refusals that depend on *deployment state* rather than
 * on the request — registration switched off, SAML configured, 2FA turned off
 * between issuing a challenge and redeeming it, a session whose user is no
 * longer there. Those are the arms that only fire on somebody's live install,
 * and each one is a place where the friendly answer is the bug: a 500 on a
 * vanished user, or a challenge that still verifies after an administrator
 * removed the second factor.
 *
 * The malformed-body cases are here for the same reason. Every one of these
 * routes is unauthenticated and internet-facing, so "what does it do with
 * nonsense" is not a hypothetical.
 */

const POLL_MS = 50;

describe.skipIf(!dbUp)('auth refusals that depend on how the deployment is set up', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  const post = (url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, payload });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('bodies that are not requests', () => {
    it('422s a registration with no usable credentials in it', async () => {
      for (const body of [
        {},
        { email: 'not-an-email', password: 'longenough1' },
        { email: 'a@b.example.com' },
      ]) {
        const res = await post('/api/v1/auth/register', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().errors?.length).toBeGreaterThan(0);
      }
    });

    it('422s a login with no usable credentials in it', async () => {
      // Ahead of the rate limiter on purpose: a malformed body must not spend
      // an attempt out of the ten a real address gets.
      for (const body of [{}, { email: 'nope' }, { email: 'a@b.example.com' }]) {
        expect((await post('/api/v1/auth/login', body)).statusCode).toBe(422);
      }
    });

    it('422s a forgot-password with nothing to send anything to', async () => {
      expect((await post('/api/v1/auth/forgot-password', {})).statusCode).toBe(422);
      expect((await post('/api/v1/auth/forgot-password', { email: 'nope' })).statusCode).toBe(422);
    });
  });

  describe('self-service registration, switched off', () => {
    const setRegistration = async (enabled: boolean) => {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/settings',
        headers: authHeader(admin.token),
        payload: { registration_enabled: enabled },
      });
      expect(res.statusCode, res.body).toBe(200);
    };

    it('refuses a sign-up while it is closed, and takes it again once reopened', async () => {
      await setRegistration(false);
      const closed = await post('/api/v1/auth/register', {
        email: `${newUlid().toLowerCase()}@closed.example.com`,
        password: 'a-good-password-1',
      });
      // 403, not 404: the route exists and the caller is being told the policy,
      // which is what lets the SPA hide the Register link with a reason.
      expect(closed.statusCode).toBe(403);
      expect(closed.json().detail).toContain('registration is currently closed');

      // And the public settings surface says the same thing, so the two cannot
      // disagree about whether the button should be there.
      const settings = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/settings' });
      expect(settings.json().settings.registration_enabled).toBe(false);

      await setRegistration(true);
      const open = await post('/api/v1/auth/register', {
        email: `${newUlid().toLowerCase()}@open.example.com`,
        password: 'a-good-password-1',
      });
      expect(open.statusCode, open.body).toBe(201);
    });
  });

  describe('which login methods are advertised', () => {
    const providers = async () =>
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/providers' })).json();

    it('offers SAML only once the three fields a login needs are all present', async () => {
      // The panel takes a partial config — an administrator saves the entity id
      // before the certificate arrives — and a "Sign in with SSO" button over
      // one of those is a redirect to nowhere. So enabled is necessary and not
      // sufficient; all three are checked.
      await upsertSamlConfig(ctx.pool, {
        enabled: true,
        idpEntityId: 'urn:idp',
        idpSsoUrl: 'https://idp.example.com/sso',
        updatedBy: admin.id,
      });
      expect((await providers()).saml).toBe(false);

      await upsertSamlConfig(ctx.pool, {
        enabled: true,
        idpEntityId: 'urn:idp',
        idpSsoUrl: 'https://idp.example.com/sso',
        idpCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        updatedBy: admin.id,
      });
      expect((await providers()).saml).toBe(true);

      // Switched off with everything still filled in is off.
      await upsertSamlConfig(ctx.pool, {
        enabled: false,
        idpEntityId: 'urn:idp',
        idpSsoUrl: 'https://idp.example.com/sso',
        idpCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        updatedBy: admin.id,
      });
      expect((await providers()).saml).toBe(false);
    });
  });

  describe('a second factor removed mid-login', () => {
    it('refuses a challenge minted while 2FA was on and redeemed after it was off', async () => {
      const password = 'test-password-123';
      const user = await seedUser(ctx, { roles: ['valuation_user'] });

      const setup = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/setup',
        headers: authHeader(user.token),
      });
      expect(setup.statusCode, setup.body).toBe(200);
      const secret = setup.json().secret as string;
      const confirmed = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/confirm',
        headers: authHeader(user.token),
        payload: { code: totp(secret) },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);

      const login = await post('/api/v1/auth/login', { email: user.email, password });
      expect(login.statusCode, login.body).toBe(200);
      expect(login.json().mfa_required).toBe(true);
      const challenge = login.json().challenge as string;
      expect(challenge).toBeTruthy();

      // The factor comes off — a lost phone, a support call — from another
      // session, while this half-finished login still holds a live challenge.
      const disabled = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/disable',
        headers: authHeader(user.token),
        payload: { password },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);

      const verify = await post('/api/v1/auth/mfa/verify', { challenge, code: totp(secret) });
      // 401 rather than a session: the challenge is a promise about the account
      // as it was, and honouring it would let a code from a secret we no longer
      // hold complete a sign-in.
      expect(verify.statusCode).toBe(401);
      expect(verify.json().detail).toContain('2FA is not enabled');
    });
  });

  describe('a session whose account is no longer there', () => {
    /**
     * A token outlives the row it names. Ordinary deactivation is a flag and is
     * covered elsewhere; this is the harder case — the row is gone, so every
     * `findUserById` on a route the token still passes authentication for comes
     * back null. Each of those has to be a 401, because the alternative is a
     * 500 on a request that is merely stale.
     */
    let token: string;

    beforeAll(async () => {
      const doomed = await seedUser(ctx, { roles: ['valuation_user'] });
      token = doomed.token;
      await ctx.pool.query('DELETE FROM users WHERE id = $1', [doomed.id]);
    });

    const withToken = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      ctx.app.inject({
        method,
        url,
        headers: authHeader(token),
        ...(payload === undefined ? {} : { payload }),
      });

    it('401s the identity endpoint', async () => {
      expect((await withToken('GET', '/api/v1/auth/me')).statusCode).toBe(401);
    });

    it('401s a resend of the verification link', async () => {
      expect((await withToken('POST', '/api/v1/auth/resend-verification')).statusCode).toBe(401);
    });

    it('401s a password change rather than 500ing on the lookup', async () => {
      const res = await withToken('POST', '/api/v1/auth/change-password', {
        current_password: 'test-password-123',
        new_password: 'another-password-1',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('an invitation overtaken by a sign-up', () => {
    it('409s an accept for an address that has since registered itself', async () => {
      const email = `${newUlid().toLowerCase()}@raced.example.com`;
      const invited = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: authHeader(admin.token),
        payload: { email, roles: ['valuation_user'] },
      });
      expect(invited.statusCode, invited.body).toBe(201);

      let body = '';
      for (let i = 0; i < 40 && !body; i += 1) {
        const { rows } = await ctx.pool.query<{ body: string }>(
          `SELECT body FROM email_outbox WHERE lower(to_email) = lower($1) AND template_key = 'user_invite'`,
          [email],
        );
        body = rows[0]?.body ?? '';
        if (!body) await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const token = /\/accept-invite#token=([A-Za-z0-9_-]+)/.exec(body)?.[1];
      expect(token).toBeTruthy();

      // The invitee signs up through the front door before opening the email.
      const registered = await post('/api/v1/auth/register', {
        email,
        password: 'signed-up-first-1',
      });
      expect(registered.statusCode, registered.body).toBe(201);

      const accepted = await post('/api/v1/auth/accept-invite', {
        token,
        password: 'accepted-later-1',
      });
      // 409 rather than 400: the invitation is not invalid, and the difference
      // matters to the person reading it — "this link has expired" would send
      // them back to an administrator instead of to the sign-in page.
      expect(accepted.statusCode).toBe(409);
      expect(accepted.json().detail).toContain('already exists');
    });
  });
});
