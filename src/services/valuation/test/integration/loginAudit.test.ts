/**
 * Authentication on the audit spine — both halves of it.
 *
 * A successful sign-in (password or MFA second factor) writes a `user_login`
 * row to `admin_events`, the same append-only mechanism every other
 * admin/account action uses (see routes/auth.ts + events/adminRecord.ts).
 *
 * The attempts that signed nobody in used to write nothing at all: they were
 * counted by an in-memory sliding window and left no trace anywhere, so the
 * trail could say when a session began and nothing about the guesses before
 * it — and after a restart even the counter was gone. `user_login_failed` and
 * `user_mfa_challenge_failed` are the other half, and the tests below hold the
 * three properties that make them worth keeping: every failing branch writes
 * one (so the row is not itself an oracle for which branch it was), the reason
 * is inside the row where an operator can read it, and the throttle is what
 * bounds how many an unauthenticated caller can cause.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { totp, TOTP_PERIOD_SECONDS } from '../../src/auth/totp.js';
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

/** Any admin event of one type about one account, oldest first. */
async function eventsFor(ctx: TestApp, userId: string, type: string) {
  const { rows } = await ctx.pool.query<{
    subject_id: string | null;
    subject_label: string | null;
    payload: { reason?: string; locked_out?: boolean; factor?: string; ip?: string };
  }>(
    `SELECT subject_id, subject_label, payload FROM admin_events
      WHERE subject_id = $1 AND type = $2 ORDER BY occurred_at, id`,
    [userId, type],
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

  it('records a failed sign-in as a failure, never as a login', async () => {
    const user = await seedPasswordUser(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(await loginEventsFor(ctx, user.id)).toHaveLength(0);

    const failures = await eventsFor(ctx, user.id, 'user_login_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.subject_label).toBe(user.email);
    expect(failures[0]!.payload.reason).toBe('bad_password');
    expect(failures[0]!.payload.locked_out).toBe(false);
  });

  it('records an attempt on an address that has no account, with the address on it', async () => {
    // The row an enumeration sweep is visible in. There is no subject to key
    // it to, so it is the label that carries the address — and writing it at
    // all is what keeps the failing branches indistinguishable from outside.
    const email = `${newUlid().toLowerCase()}@no-such-account.example.com`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'whatever-it-is-1' },
    });
    expect(res.statusCode).toBe(401);

    const { rows } = await ctx.pool.query<{ subject_id: string | null; payload: { reason?: string } }>(
      `SELECT subject_id, payload FROM admin_events
        WHERE type = 'user_login_failed' AND subject_label = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject_id).toBeNull();
    expect(rows[0]!.payload.reason).toBe('unknown_account');
  });

  it('names the attempt that locked the address, and writes nothing past it', async () => {
    // The throttle is what bounds an unauthenticated route's ability to insert
    // rows, so the ceiling on attempts is the ceiling on rows: ten failures per
    // address per window, the tenth marked as the one that tripped the lock,
    // and the refusals after it recorded nowhere.
    const user = await seedPasswordUser(ctx);
    for (let i = 0; i < 12; i += 1) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: user.email, password: `wrong-${i}` },
      });
    }
    const failures = await eventsFor(ctx, user.id, 'user_login_failed');
    expect(failures).toHaveLength(10);
    expect(failures.filter((f) => f.payload.locked_out === true)).toHaveLength(1);
    expect(failures.at(-1)!.payload.locked_out).toBe(true);
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
      payload: { password: PASSWORD },
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
      // The next step's code: confirming enrolment above spent the current one.
      payload: {
        challenge: challenge.json().challenge,
        code: totp(secret, Date.now() + TOTP_PERIOD_SECONDS * 1000),
      },
    });
    expect(verify.statusCode).toBe(200);

    const rows = await loginEventsFor(ctx, user.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload.mfa).toBe(true);
  });

  it('records a wrong second factor, which is a correct password one step short', async () => {
    // The strongest signal this service emits: a challenge is only issued to a
    // caller who already presented the right password, so a wrong code here is
    // somebody holding working credentials. The throttle counted it in memory
    // and nothing else knew.
    const user = await seedPasswordUser(ctx);
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const token = first.json().token as string;
    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/setup',
      headers: authHeader(token),
      payload: { password: PASSWORD },
    });
    const { secret } = setup.json();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/confirm',
      headers: authHeader(token),
      payload: { code: totp(secret) },
    });

    const challenge = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: challenge.json().challenge, code: '000000' },
    });
    expect(verify.statusCode).toBe(401);

    const failures = await eventsFor(ctx, user.id, 'user_mfa_challenge_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload.factor).toBe('totp');
    // The password half succeeded, so nothing failed there — the two rows say
    // different things and a reader must be able to tell them apart.
    expect(await eventsFor(ctx, user.id, 'user_login_failed')).toHaveLength(0);
  });
});
