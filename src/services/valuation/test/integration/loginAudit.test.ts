/**
 * Login events on the audit spine: a successful sign-in (password or MFA
 * second-factor) writes a `user_login` row to admin_events, same
 * append-only mechanism used for every other admin/account action (see
 * routes/auth.ts + events/adminRecord.ts). A failed login never writes one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { totp } from '../../src/auth/totp.js';
import { authHeader, isDbAvailable, setupTestApp, type TestApp } from './helpers.js';
import { newUlid } from '@n409/shared';

const dbUp = await isDbAvailable();
const PASSWORD = 'login-audit-password-1';

async function seedPasswordUser(ctx: TestApp): Promise<{ id: string; email: string }> {
  const email = `${newUlid().toLowerCase()}@login-audit.example.com`;
  const user = await createUser(ctx.pool, {
    email,
    passwordDigest: await hashPassword(PASSWORD),
    roles: ['valuation_user'],
  });
  return { id: user.id, email };
}

async function loginEventsFor(ctx: TestApp, userId: string) {
  const { rows } = await ctx.pool.query<{
    type: string;
    actor_id: string;
    subject_id: string;
    subject_label: string;
    payload: { method?: string; mfa?: boolean };
  }>(
    `SELECT type, actor_id, subject_id, subject_label, payload FROM admin_events
      WHERE subject_id = $1 AND type = 'user_login' ORDER BY occurred_at`,
    [userId],
  );
  return rows;
}

describe.skipIf(!dbUp)('login audit events', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  it('records a user_login event on successful password sign-in', async () => {
    const user = await seedPasswordUser(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);

    const rows = await loginEventsFor(ctx, user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(user.id);
    expect(rows[0]!.subject_label).toBe(user.email);
    expect(rows[0]!.payload.method).toBe('password');
  });

  it('does not record a login event on a failed sign-in', async () => {
    const user = await seedPasswordUser(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(await loginEventsFor(ctx, user.id)).toHaveLength(0);
  });

  it('records the login event after MFA verification, not at the challenge step', async () => {
    const user = await seedPasswordUser(ctx);
    const initialLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const token = initialLogin.json().token as string;

    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/setup',
      headers: authHeader(token),
    });
    const { secret } = setup.json();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/confirm',
      headers: authHeader(token),
      payload: { code: totp(secret) },
    });
    // Baseline: the pre-enrolment login above already logged one event.
    expect(await loginEventsFor(ctx, user.id)).toHaveLength(1);

    const challenge = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    expect(challenge.json().mfa_required).toBe(true);
    // The challenge step is not itself a completed login.
    expect(await loginEventsFor(ctx, user.id)).toHaveLength(1);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: challenge.json().challenge, code: totp(secret) },
    });
    expect(verify.statusCode).toBe(200);

    const rows = await loginEventsFor(ctx, user.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload.mfa).toBe(true);
  });
});
