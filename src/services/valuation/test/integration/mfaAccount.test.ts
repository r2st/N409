import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { totp } from '../../src/auth/totp.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

const PASSWORD = 'mfa-account-password-1234';

/**
 * The self-service half of MFA: the status endpoint the account page reads, and
 * the password-gated disable / backup-code routes. `mfa.test.ts` covers the
 * login-side challenge; these cover the account-side routes it never touches,
 * and in particular the branches that decide whether a second factor can be
 * removed at all.
 */
describe.skipIf(!dbUp)('MFA — account self-service routes', () => {
  let ctx: TestApp;

  async function seedPasswordUser(): Promise<{ id: string; email: string; token: string }> {
    const email = `${newUlid().toLowerCase()}@mfa-account.example.com`;
    const user = await createUser(ctx.pool, {
      email,
      passwordDigest: await hashPassword(PASSWORD),
      roles: ['valuation_user'],
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    return { id: user.id, email, token: res.json().token as string };
  }

  /**
   * A session on an account that has since become SSO-only. Logging in needs a
   * password, so the digest is stripped afterwards — which is also the sharper
   * test: the route has to re-read the user rather than trust the principal.
   */
  async function seedThenStripPassword(): Promise<{ id: string; token: string }> {
    const user = await seedPasswordUser();
    await ctx.pool.query('UPDATE users SET password_digest = NULL, sso_provider = $2 WHERE id = $1', [
      user.id,
      'google',
    ]);
    return { id: user.id, token: user.token };
  }

  async function enroll(token: string): Promise<string[]> {
    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/setup',
      headers: authHeader(token),
    });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;
    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/confirm',
      headers: authHeader(token),
      payload: { code: totp(secret) },
    });
    expect(confirm.statusCode).toBe(200);
    return confirm.json().backup_codes as string[];
  }

  const status = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/account/mfa', headers: authHeader(token) });

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  describe('GET /api/v1/account/mfa', () => {
    it('reports a password account as enrollable but not enabled', async () => {
      const user = await seedPasswordUser();
      const res = await status(user.token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        enabled: false,
        confirmed_at: null,
        backup_codes_remaining: 0,
        required: false,
        can_enroll: true,
      });
    });

    it('reports the live backup-code count once enrolled', async () => {
      const user = await seedPasswordUser();
      await enroll(user.token);
      const res = await status(user.token);
      expect(res.json().enabled).toBe(true);
      expect(res.json().confirmed_at).not.toBeNull();
      expect(res.json().backup_codes_remaining).toBe(10);
    });

    it('marks an SSO-only account as not enrollable', async () => {
      const sso = await seedThenStripPassword();
      const res = await status(sso.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().can_enroll).toBe(false);
      expect(res.json().enabled).toBe(false);
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/account/mfa' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/account/mfa/setup', () => {
    it('refuses a second enrolment while 2FA is already on', async () => {
      const user = await seedPasswordUser();
      await enroll(user.token);
      const again = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/setup',
        headers: authHeader(user.token),
      });
      expect(again.statusCode).toBe(409);
    });

    it('does not turn the factor off when it is enabled between the read and the write', async () => {
      /*
       * The refusal above is a read on one connection and the staging write is
       * a statement on another, and the write cleared `totp_enabled` on its way
       * past. So a `/setup` overtaken by the `/confirm` that finishes an
       * enrolment — two tabs, a re-opened setup page, a retried request — saw an
       * un-enrolled account and then switched the second factor back off. No
       * `user_mfa_disabled` on the admin trail, no answer to the user, and the
       * backup codes `/confirm` had just shown them still in their hand.
       *
       * Staged by enrolling from inside the hook, immediately before the
       * staging UPDATE, which is the interleaving itself rather than a
       * simulation of it.
       */
      const user = await seedPasswordUser();
      let staged = false;
      const restore = interceptPoolQueries(ctx.pool, async (sql, phase) => {
        if (phase !== 'before' || staged || !sql.includes('totp_confirmed_at = NULL')) return undefined;
        staged = true;
        await enroll(user.token);
        return undefined;
      });
      let res;
      try {
        res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/account/mfa/setup',
          headers: authHeader(user.token),
        });
      } finally {
        restore();
      }
      expect(staged).toBe(true);
      expect(res.statusCode).toBe(409);

      // The factor the winner switched on is still on, with the secret it
      // confirmed — not the loser's staged one.
      expect((await status(user.token)).json()).toMatchObject({ enabled: true });
      const { rows } = await ctx.pool.query<{ totp_enabled: boolean; totp_confirmed_at: Date | null }>(
        'SELECT totp_enabled, totp_confirmed_at FROM users WHERE id = $1',
        [user.id],
      );
      expect(rows[0]!.totp_enabled).toBe(true);
      expect(rows[0]!.totp_confirmed_at).not.toBeNull();
    });

    it('refuses enrolment on an SSO-only account', async () => {
      const sso = await seedThenStripPassword();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/setup',
        headers: authHeader(sso.token),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('Google SSO');
    });
  });

  describe('POST /api/v1/account/mfa/confirm', () => {
    it('rejects a body with no code', async () => {
      const user = await seedPasswordUser();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/confirm',
        headers: authHeader(user.token),
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });

    it('refuses to confirm when no enrolment was staged', async () => {
      const user = await seedPasswordUser();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/confirm',
        headers: authHeader(user.token),
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('Start setup first');
    });

    it('refuses a wrong code and leaves 2FA off', async () => {
      const user = await seedPasswordUser();
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/setup',
        headers: authHeader(user.token),
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/confirm',
        headers: authHeader(user.token),
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(400);
      expect((await status(user.token)).json().enabled).toBe(false);
    });
  });

  describe('POST /api/v1/account/mfa/backup-codes', () => {
    it('regenerates a fresh set and invalidates the old one', async () => {
      const user = await seedPasswordUser();
      const original = await enroll(user.token);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/backup-codes',
        headers: authHeader(user.token),
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const fresh = res.json().backup_codes as string[];
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toEqual(original);
      // The count is back to a full set, not 20 — the old codes are gone.
      expect((await status(user.token)).json().backup_codes_remaining).toBe(10);

      // A code from the superseded set no longer buys a session.
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: user.email, password: PASSWORD },
      });
      const replay = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        payload: { challenge: login.json().challenge, code: original[0]! },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('refuses a wrong password', async () => {
      const user = await seedPasswordUser();
      await enroll(user.token);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/backup-codes',
        headers: authHeader(user.token),
        payload: { password: 'not-the-password' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('Password is incorrect');
    });

    it('refuses an empty password body', async () => {
      const user = await seedPasswordUser();
      await enroll(user.token);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/backup-codes',
        headers: authHeader(user.token),
        payload: { password: '' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('refuses when 2FA was never enabled', async () => {
      const user = await seedPasswordUser();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/backup-codes',
        headers: authHeader(user.token),
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('2FA is not enabled');
    });
  });

  describe('POST /api/v1/account/mfa/disable', () => {
    it('disables with the right password', async () => {
      const user = await seedPasswordUser();
      await enroll(user.token);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/disable',
        headers: authHeader(user.token),
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
      expect((await status(user.token)).json().enabled).toBe(false);
    });

    it('refuses a wrong password and leaves the factor in place', async () => {
      const user = await seedPasswordUser();
      await enroll(user.token);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/disable',
        headers: authHeader(user.token),
        payload: { password: 'not-the-password' },
      });
      expect(res.statusCode).toBe(400);
      expect((await status(user.token)).json().enabled).toBe(true);
    });

    it('is a no-op when 2FA is already off', async () => {
      const user = await seedPasswordUser();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/account/mfa/disable',
        headers: authHeader(user.token),
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
    });

    it('cannot be disabled while an administrator requires 2FA', async () => {
      const admin = await seedUser(ctx, { roles: ['admin'] });
      const user = await seedPasswordUser();
      await enroll(user.token);

      const set = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/settings',
        headers: authHeader(admin.token),
        payload: { require_mfa: true },
      });
      expect(set.statusCode).toBe(200);

      try {
        expect((await status(user.token)).json().required).toBe(true);
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/account/mfa/disable',
          headers: authHeader(user.token),
          payload: { password: PASSWORD },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().detail).toContain('administrator requires 2FA');
        expect((await status(user.token)).json().enabled).toBe(true);
      } finally {
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers: authHeader(admin.token),
          payload: { require_mfa: false },
        });
      }
    });
  });
});
