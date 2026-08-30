import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { DEAD_LINK_DETAIL } from '../../src/domain/linkRefusal.js';

const dbUp = await isDbAvailable();

/**
 * The public auth surfaces `authFlows.test.ts` does not reach: logout, the
 * provider advertisement, `/auth/me`, email verification and its resend, the
 * MFA challenge redemption, and the invite-info lookup.
 *
 * These are the endpoints reachable without a session, which is what makes
 * their refusals worth pinning. Several answer deliberately vaguely — an
 * unauthenticated caller must not learn from a status code whether a token, an
 * invitation or an account exists — and a route that got helpful instead would
 * be an enumeration oracle rather than a bug.
 */
describe.skipIf(!dbUp)('auth — the public surfaces', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ EMAIL_MODE: 'off' });
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const post = (url: string, payload?: unknown, token?: string) =>
    ctx.app.inject({
      method: 'POST',
      url,
      ...(token ? { headers: authHeader(token) } : {}),
      payload: payload ?? {},
    });

  // ── Logout ────────────────────────────────────────────────────────────────
  describe('logout', () => {
    it('succeeds with no token at all', async () => {
      // Public by necessity: the endpoint has to work with an expired or
      // missing token, which is exactly when somebody presses sign out.
      const res = await post('/api/v1/auth/logout');
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toMatch(/signed out/i);
    });

    it('succeeds with a garbage or expired bearer token', async () => {
      for (const header of ['Bearer not-a-jwt', 'Bearer ', 'Basic abc123']) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: { authorization: header },
        });
        expect(res.statusCode, header).toBe(200);
      }
    });

    it('invalidates every outstanding session, not only the token presented', async () => {
      // The bump is the point. Clearing one cookie leaves any other JWT the
      // user holds — a second browser, a stolen copy — working until it expires.
      const victim = await seedUser(ctx, { roles: ['valuation_user'] });
      const before = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(victim.token),
      });
      expect(before.statusCode).toBe(200);

      expect((await post('/api/v1/auth/logout', {}, victim.token)).statusCode).toBe(200);

      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(victim.token),
      });
      expect(after.statusCode).toBe(401);
    });

    it('ignores a personal access token rather than bumping the session epoch', async () => {
      // A PAT is not a session. Bumping on one would sign the user out of every
      // browser because a script logged out.
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: 'Bearer n409_pat_something' },
      });
      expect(res.statusCode).toBe(200);
      // The real session is untouched.
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(user.token),
      });
      expect(me.statusCode).toBe(200);
    });
  });

  // ── Providers ─────────────────────────────────────────────────────────────
  it('advertises which login methods the deployment offers, without a session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toBeTruthy();
    // Google is unconfigured in the test app, and the SPA needs to be told so
    // rather than rendering a button that dead-ends.
    expect(JSON.stringify(body)).toMatch(/google/i);
  });

  // ── /auth/me ──────────────────────────────────────────────────────────────
  describe('/auth/me', () => {
    it('401s without a token and answers with the caller when there is one', async () => {
      expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(user.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(user.id);
      // Never the digest, on any path that returns a user.
      expect(JSON.stringify(res.json())).not.toContain('password_digest');
    });
  });

  // ── Email verification ────────────────────────────────────────────────────
  describe('email verification', () => {
    it('400s a token that is malformed, unknown or already spent', async () => {
      for (const token of ['', 'not-a-token', 'a'.repeat(64)]) {
        const res = await post('/api/v1/auth/verify-email', { token });
        expect([400, 422]).toContain(res.statusCode);
      }
    });

    it('tells an already-verified caller so, without sending anything', async () => {
      // The short-circuit arm: it must not consume a rate-limit slot or queue
      // mail for an address that is already proven.
      await ctx.pool.query('UPDATE users SET verified = true WHERE id = $1', [user.id]);
      const res = await post('/api/v1/auth/resend-verification', {}, user.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toMatch(/already verified/i);
    });

    it('sends a fresh link to an unverified caller, then rate-limits', async () => {
      const unverified = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query('UPDATE users SET verified = false WHERE id = $1', [unverified.id]);

      const first = await post('/api/v1/auth/resend-verification', {}, unverified.token);
      expect(first.statusCode).toBe(200);
      expect(first.json().message).toMatch(/verification link/i);

      // Three per hour per user; the fourth is refused rather than mailing a
      // mailbox somebody else owns.
      await post('/api/v1/auth/resend-verification', {}, unverified.token);
      await post('/api/v1/auth/resend-verification', {}, unverified.token);
      const fourth = await post('/api/v1/auth/resend-verification', {}, unverified.token);
      expect(fourth.statusCode).toBe(429);
    });

    it('requires a session to resend', async () => {
      expect((await post('/api/v1/auth/resend-verification')).statusCode).toBe(401);
    });
  });

  // ── MFA challenge ─────────────────────────────────────────────────────────
  describe('the second-factor challenge', () => {
    it('422s a request with no challenge in it', async () => {
      for (const payload of [{}, { challenge: '' }, { challenge: 'x', code: 12345 }]) {
        const res = await post('/api/v1/auth/mfa/verify', payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('401s a challenge token that is not one', async () => {
      // One message for forged, expired and already-redeemed alike — the
      // caller is unauthenticated, and distinguishing them says which guess
      // was closer.
      const res = await post('/api/v1/auth/mfa/verify', { challenge: 'not-a-jwt', code: '123456' });
      expect(res.statusCode).toBe(401);
      expect(res.json().detail).toMatch(/invalid or has expired/i);
    });
  });

  // ── Invitation lookup ─────────────────────────────────────────────────────
  describe('invite-info', () => {
    it('422s a request carrying no token', async () => {
      for (const payload of [{}, { token: '' }, { token: 42 }]) {
        const res = await post('/api/v1/auth/invite-info', payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('400s an unknown token with the same words a revoked one gets', async () => {
      // The route answers "is this token real?" directly, so it is the
      // enumeration oracle the rate limit exists for — and the message must not
      // separate "never existed" from "no longer valid".
      const res = await post('/api/v1/auth/invite-info', { token: 'definitely-not-real' });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe(DEAD_LINK_DETAIL.invitation);
    });

    it('gives accept-invite the same refusal for the same token', async () => {
      const res = await post('/api/v1/auth/accept-invite', {
        token: 'definitely-not-real',
        password: 'correct-horse-battery-9',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe(DEAD_LINK_DETAIL.invitation);
    });

    it('422s an accept-invite whose password is too short to be one', async () => {
      const res = await post('/api/v1/auth/accept-invite', { token: 'x', password: 'short' });
      expect(res.statusCode).toBe(422);
    });
  });

  // ── Change password ───────────────────────────────────────────────────────
  describe('changing a password', () => {
    it('400s an SSO account that has none to change', async () => {
      const sso = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query(`UPDATE users SET password_digest = NULL, sso_provider = 'google' WHERE id = $1`, [
        sso.id,
      ]);
      const res = await post(
        '/api/v1/auth/change-password',
        { current_password: 'whatever-it-was', new_password: 'correct-horse-battery-9' },
        sso.token,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/Google SSO/);
    });

    it('400s a wrong current password, and 422s a new one below the floor', async () => {
      const res = await post(
        '/api/v1/auth/change-password',
        { current_password: 'not-the-password', new_password: 'correct-horse-battery-9' },
        user.token,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/current password is incorrect/i);

      const short = await post(
        '/api/v1/auth/change-password',
        { current_password: 'not-the-password', new_password: 'short1' },
        user.token,
      );
      expect(short.statusCode).toBe(422);
      // Refused on the schema's length floor, and the issue names the field so
      // the form can mark it — the current password being wrong as well does
      // not mask it.
      expect(JSON.stringify(short.json().errors)).toMatch(/new_password|password/);

      // Length is not the only rule: a passphrase with no digit in it is
      // refused too, and the message says which rule it broke rather than
      // repeating the length one.
      const noDigit = await post(
        '/api/v1/auth/change-password',
        { current_password: 'not-the-password', new_password: 'correct-horse-battery' },
        user.token,
      );
      expect(noDigit.statusCode).toBe(422);
      expect(noDigit.json().detail).toMatch(/one letter and one number/i);
    });

    it('requires a session', async () => {
      const res = await post('/api/v1/auth/change-password', {
        current_password: 'a-password',
        new_password: 'correct-horse-battery-9',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
