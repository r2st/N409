import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { totp, TOTP_PERIOD_SECONDS } from '../../src/auth/totp.js';
import { authHeader, isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const PASSWORD = 'mfa-password-1234';

/**
 * The code for the next time step. Confirming enrolment spends the step its
 * code belongs to (migration 0097), so a login seconds later has to use the
 * following code — which is the one the authenticator would be showing by the
 * time a real user got to the login form. Tests that enrol and immediately log
 * in are the only place the two collide.
 */
function nextStepCode(secret: string): string {
  return totp(secret, Date.now() + TOTP_PERIOD_SECONDS * 1000);
}

/** Registers a password user directly and returns id/email/token. */
async function seedPasswordUser(ctx: TestApp): Promise<{ id: string; email: string; token: string }> {
  const email = `${newUlid().toLowerCase()}@mfa.example.com`;
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

/** Runs a user through the full enrolment and returns the staged secret + backup codes. */
async function enroll(ctx: TestApp, token: string): Promise<{ secret: string; backupCodes: string[] }> {
  const setup = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/account/mfa/setup',
    headers: authHeader(token),
  });
  expect(setup.statusCode).toBe(200);
  const { secret, qr, otpauth_uri } = setup.json();
  expect(typeof secret).toBe('string');
  expect(qr).toMatch(/^data:image\/png;base64,/);
  expect(otpauth_uri).toContain('otpauth://totp/');

  const confirm = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/account/mfa/confirm',
    headers: authHeader(token),
    payload: { code: totp(secret) },
  });
  expect(confirm.statusCode).toBe(200);
  const { enabled, backup_codes } = confirm.json();
  expect(enabled).toBe(true);
  expect(backup_codes).toHaveLength(10);
  return { secret, backupCodes: backup_codes };
}

describe.skipIf(!dbUp)('MFA / 2FA (feature 2)', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  it('enrols, then requires a second factor at login', async () => {
    const user = await seedPasswordUser(ctx);
    const { secret } = await enroll(ctx, user.token);

    // Login now returns a challenge instead of a session.
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json();
    expect(body.mfa_required).toBe(true);
    expect(body.token).toBeUndefined();
    expect(typeof body.challenge).toBe('string');

    // Redeeming the challenge with a live TOTP code issues a session.
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: body.challenge, code: nextStepCode(secret) },
    });
    expect(verify.statusCode).toBe(200);
    expect(typeof verify.json().token).toBe('string');
    expect(verify.json().user.totp_enabled).toBe(true);
  });

  it('rejects a wrong second-factor code', async () => {
    const user = await seedPasswordUser(ctx);
    await enroll(ctx, user.token);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: login.json().challenge, code: '000000' },
    });
    expect(verify.statusCode).toBe(401);
  });

  it('refuses a second-factor code that has already been used (RFC 6238 §5.2)', async () => {
    const user = await seedPasswordUser(ctx);
    const { secret } = await enroll(ctx, user.token);
    const code = nextStepCode(secret);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: first.json().challenge, code },
    });
    expect(accepted.statusCode).toBe(200);

    // The same code is still inside its acceptance window here — that window is
    // exactly where a real-time phishing proxy replays what the user typed.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: second.json().challenge, code },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().token).toBeUndefined();
  });

  it('refuses the enrolment code at the login prompt straight afterwards', async () => {
    const user = await seedPasswordUser(ctx);
    // enroll() confirms with the current step's code; that step is now spent,
    // so the very same code must not also buy a session.
    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/setup',
      headers: authHeader(user.token),
    });
    const { secret } = setup.json();
    const enrolCode = totp(secret);
    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/confirm',
      headers: authHeader(user.token),
      payload: { code: enrolCode },
    });
    expect(confirm.statusCode).toBe(200);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: login.json().challenge, code: enrolCode },
    });
    expect(verify.statusCode).toBe(401);

    // ...but the next code works, so the account is not bricked.
    const recover = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: login.json().challenge, code: nextStepCode(secret) },
    });
    expect(recover.statusCode).toBe(200);
    expect(typeof recover.json().token).toBe('string');
  });

  it('accepts a one-time backup code and then rejects its reuse', async () => {
    const user = await seedPasswordUser(ctx);
    const { backupCodes } = await enroll(ctx, user.token);
    const code = backupCodes[0]!;

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const useIt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: first.json().challenge, backup_code: code },
    });
    expect(useIt.statusCode).toBe(200);

    // Same code a second time is dead.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: second.json().challenge, backup_code: code },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('remembers a trusted device so the next login skips the challenge', async () => {
    const user = await seedPasswordUser(ctx);
    const { secret } = await enroll(ctx, user.token);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge: login.json().challenge, code: nextStepCode(secret), remember_device: true },
    });
    const setCookie = verify.headers['set-cookie'];
    const deviceCookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c) => String(c))
      .find((c) => c.startsWith('n409_device='));
    expect(deviceCookie).toBeDefined();
    const cookieValue = deviceCookie!.split(';')[0]!;

    // A fresh login carrying the device cookie gets a session directly.
    const trustedLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie: cookieValue },
      payload: { email: user.email, password: PASSWORD },
    });
    expect(trustedLogin.statusCode).toBe(200);
    expect(trustedLogin.json().mfa_required).toBeUndefined();
    expect(typeof trustedLogin.json().token).toBe('string');
  });

  it('disables 2FA with the correct password and returns to single-factor login', async () => {
    const user = await seedPasswordUser(ctx);
    await enroll(ctx, user.token);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/disable',
      headers: authHeader(user.token),
      payload: { password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(400);

    const disabled = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/disable',
      headers: authHeader(user.token),
      payload: { password: PASSWORD },
    });
    expect(disabled.statusCode).toBe(200);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.json().mfa_required).toBeUndefined();
    expect(typeof login.json().token).toBe('string');
  });
});
