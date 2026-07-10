import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Verification emails go out fire-and-forget — poll the outbox. */
async function waitForOutbox(
  ctx: TestApp,
  toEmail: string,
): Promise<Array<{ body: string; subject: string; status: string }>> {
  for (let i = 0; i < 40; i++) {
    const { rows } = await ctx.pool.query(
      `SELECT body, subject, status FROM email_outbox
       WHERE lower(to_email) = lower($1) AND template_key = 'email_verification'
       ORDER BY created_at ASC`,
      [toEmail],
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

async function waitForCount(ctx: TestApp, toEmail: string, n: number) {
  let mails = await waitForOutbox(ctx, toEmail);
  for (let i = 0; i < 40 && mails.length < n; i++) {
    await new Promise((r) => setTimeout(r, 50));
    mails = await waitForOutbox(ctx, toEmail);
  }
  return mails;
}

const tokenFrom = (body: string): string => {
  const match = body.match(/\/verify-email#token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no verify-email token in email body: ${body}`);
  return match[1]!;
};

const register = (ctx: TestApp, email: string, password = 'register-password-1') =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password } });

const verify = (ctx: TestApp, token: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } });

const isVerified = async (ctx: TestApp, userId: string): Promise<boolean> => {
  const { rows } = await ctx.pool.query<{ verified: boolean }>(
    'SELECT verified FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!.verified;
};

describe.skipIf(!dbUp)('email verification (gap #26)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  describe('registration → verify', () => {
    it('registers unverified and sends a verification email', async () => {
      const email = `${newUlid().toLowerCase()}@verify.example.com`;
      const res = await register(ctx, email);
      expect(res.statusCode).toBe(201);
      expect(res.json().user.verified).toBe(false);
      const mails = await waitForOutbox(ctx, email);
      expect(mails.length).toBe(1);
      expect(mails[0]!.subject).toMatch(/verify/i);
    });

    it('flips the verified flag exactly once from the emailed link', async () => {
      const email = `${newUlid().toLowerCase()}@verify.example.com`;
      const reg = await register(ctx, email);
      const userId = reg.json().user.id as string;
      const [mail] = await waitForOutbox(ctx, email);
      const token = tokenFrom(mail!.body);

      expect(await isVerified(ctx, userId)).toBe(false);
      const ok = await verify(ctx, token);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().status).toBe('verified');
      expect(await isVerified(ctx, userId)).toBe(true);

      // Single-use: the consumed link can't verify again (matches the reset flow).
      const replay = await verify(ctx, token);
      expect(replay.statusCode).toBe(400);
    });

    it('is idempotent when a still-valid link lands on an already-verified account', async () => {
      // e.g. the user verified via Google SSO after email sign-up: the emailed
      // link is still unused but the flag is already set, so it reports success.
      const email = `${newUlid().toLowerCase()}@verify.example.com`;
      const reg = await register(ctx, email);
      const userId = reg.json().user.id as string;
      const [mail] = await waitForOutbox(ctx, email);
      const token = tokenFrom(mail!.body);

      await ctx.pool.query('UPDATE users SET verified = true WHERE id = $1', [userId]);
      const res = await verify(ctx, token);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('already_verified');
    });

    it('rejects unknown, tampered, and expired tokens', async () => {
      const email = `${newUlid().toLowerCase()}@verify.example.com`;
      const reg = await register(ctx, email);
      const userId = reg.json().user.id as string;
      const [mail] = await waitForOutbox(ctx, email);
      const token = tokenFrom(mail!.body);

      expect((await verify(ctx, 'not-a-real-token')).statusCode).toBe(400);

      await ctx.pool.query(
        `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [userId],
      );
      expect((await verify(ctx, token)).statusCode).toBe(400);
      expect(await isVerified(ctx, userId)).toBe(false);
    });

    it('invalidates prior tokens when a new one is requested', async () => {
      const email = `${newUlid().toLowerCase()}@verify.example.com`;
      const reg = await register(ctx, email);
      const first = tokenFrom((await waitForOutbox(ctx, email))[0]!.body);

      // Resend mints a second token, retiring the first.
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'register-password-1' },
      });
      const token = login.json().token as string;
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: authHeader(token),
      });
      const mails = await waitForCount(ctx, email, 2);
      expect(mails.length).toBe(2);
      const second = tokenFrom(mails[1]!.body);

      expect((await verify(ctx, first)).statusCode).toBe(400);
      const ok = await verify(ctx, second);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().status).toBe('verified');
      expect(await isVerified(ctx, reg.json().user.id)).toBe(true);
    });

    it('rejects a malformed verify request body', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('resend-verification', () => {
    it('requires authentication', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
      });
      expect(res.statusCode).toBe(401);
    });

    it('is a no-op for already-verified accounts', async () => {
      // seedUser accounts are created unverified; verify one first.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query('UPDATE users SET verified = true WHERE id = $1', [user.id]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: authHeader(user.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toMatch(/already verified/i);
      expect(await waitForOutbox(ctx, user.email)).toHaveLength(0);
    });

    it('rate-limits repeated requests per user', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      for (let i = 0; i < 3; i++) {
        const ok = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/auth/resend-verification',
          headers: authHeader(user.token),
        });
        expect(ok.statusCode).toBe(200);
      }
      const limited = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: authHeader(user.token),
      });
      expect(limited.statusCode).toBe(429);
    });
  });

  describe('email change (routes/me)', () => {
    it('resets verified and dispatches a verification email to the new address', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query('UPDATE users SET verified = true WHERE id = $1', [user.id]);

      const newEmail = `${newUlid().toLowerCase()}@changed.example.com`;
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: authHeader(user.token),
        payload: { email: newEmail, current_password: 'test-password-123' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.verified).toBe(false);

      const mails = await waitForOutbox(ctx, newEmail);
      expect(mails.length).toBe(1);
      const token = tokenFrom(mails[0]!.body);
      const ok = await verify(ctx, token);
      expect(ok.statusCode).toBe(200);
      expect(await isVerified(ctx, user.id)).toBe(true);
    });

    it('refuses a link minted for a since-changed address', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const firstEmail = `${newUlid().toLowerCase()}@first.example.com`;
      await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: authHeader(user.token),
        payload: { email: firstEmail, current_password: 'test-password-123' },
      });
      const staleToken = tokenFrom((await waitForOutbox(ctx, firstEmail))[0]!.body);

      // Change again before clicking the first link.
      const secondEmail = `${newUlid().toLowerCase()}@second.example.com`;
      await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: authHeader(user.token),
        payload: { email: secondEmail, current_password: 'test-password-123' },
      });
      await waitForOutbox(ctx, secondEmail);

      // The stale token was bound to firstEmail, which the user no longer holds.
      expect((await verify(ctx, staleToken)).statusCode).toBe(400);
      expect(await isVerified(ctx, user.id)).toBe(false);
    });
  });
});
