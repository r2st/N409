import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, SEEDED_PASSWORD, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The password policy has to hold on every route that sets a password.
 *
 * `assertPasswordStrong` reads `password_min_length` from system settings on
 * each call, precisely so an administrator can tighten it without a restart —
 * and it was wired into register, reset-password and change-password but not
 * accept-invite. Invitation is how every seat inside a firm is created, so the
 * one route that skipped the policy was the one most accounts come in through:
 * raising the minimum to 16 secured self-service sign-ups and left invited
 * colleagues on the schema's 10-character floor, still able to choose an
 * all-letters password that register would have refused outright.
 *
 * These assertions are written against the *policy*, not the schema — the
 * complexity rule fails at any length, so it cannot be satisfied by the zod
 * `min(10)` that was doing all the work before.
 */

const dbUp = await isDbAvailable();

async function waitForOutbox(ctx: TestApp, toEmail: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const { rows } = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM email_outbox
        WHERE lower(to_email) = lower($1) AND template_key = 'user_invite'
        ORDER BY created_at ASC LIMIT 1`,
      [toEmail],
    );
    if (rows.length > 0) return rows[0]!.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no invitation email for ${toEmail}`);
}

const tokenFrom = (body: string): string => {
  const match = body.match(/\/accept-invite#token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no accept-invite token in: ${body}`);
  return match[1]!;
};

describe.skipIf(!dbUp)('accept-invite enforces the password policy', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  /** Invite a fresh address and return the token from the delivered email. */
  const inviteToken = async (): Promise<{ email: string; token: string }> => {
    const email = `${newUlid().toLowerCase()}@invitee.example.com`;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: authHeader(admin.token),
      payload: { current_password: SEEDED_PASSWORD, email, roles: ['valuation_user'] },
    });
    expect(created.statusCode).toBe(201);
    return { email, token: tokenFrom(await waitForOutbox(ctx, email)) };
  };

  const accept = (token: string, password: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: { token, password, first_name: 'Ada' },
    });

  it('refuses a long password with no digit, exactly as register does', async () => {
    const { token } = await inviteToken();
    const res = await accept(token, 'passwordonly');
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/at least one letter and one number/i);

    // The invitation is untouched — a rejected password must not burn the link.
    const retry = await accept(token, 'invitee-password-1');
    expect(retry.statusCode).toBe(201);
  });

  /** Through the admin route, so the settings cache invalidates as in production. */
  const setMinLength = async (n: number) => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: authHeader(admin.token),
      payload: { password_min_length: n },
    });
    expect(res.statusCode).toBe(200);
  };

  it('applies an administrator-raised minimum length', async () => {
    await setMinLength(24);
    try {
      const { token } = await inviteToken();
      const short = await accept(token, 'invitee-password-1'); // 19 chars: fine at 10, not at 24
      expect(short.statusCode).toBe(422);
      expect(short.json().detail).toMatch(/at least 24 characters/i);

      const long = await accept(token, 'invitee-password-1-and-then-some');
      expect(long.statusCode).toBe(201);
    } finally {
      await setMinLength(10);
    }
  });

  it('still accepts a password that satisfies the policy', async () => {
    const { email, token } = await inviteToken();
    const res = await accept(token, 'invitee-password-1');
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe(email);
  });
});
