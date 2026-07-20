import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createUser } from '../../src/repos/users.js';
import { newUlid } from '@n409/shared';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** httpOnly session cookie auth (audit F-2). */
describe.skipIf(!dbUp)('session cookie auth', () => {
  let ctx: TestApp;
  const password = 'cookie-test-password-1';
  let email: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    email = `${newUlid().toLowerCase()}@cookie.example.com`;
    await createUser(ctx.pool, {
      email,
      passwordDigest: await hashPassword(password),
      roles: ['valuation_user'],
    });
  });
  afterAll(async () => ctx?.teardown());

  const login = () =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

  it('sets an httpOnly, SameSite=Strict session cookie on login', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    // Body still carries the token for API clients.
    expect(typeof res.json().token).toBe('string');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieStr).toContain(`${SESSION_COOKIE}=`);
    expect(cookieStr.toLowerCase()).toContain('httponly');
    expect(cookieStr.toLowerCase()).toContain('samesite=strict');
    expect(cookieStr.toLowerCase()).toContain('path=/');
  });

  it('authenticates a request using only the cookie (no Authorization header)', async () => {
    const res = await login();
    const token = res.json().token as string;
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email.toLowerCase()).toBe(email);
  });

  it('rejects an absent/empty bearer with no cookie', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    const empty = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer ' },
    });
    expect(empty.statusCode).toBe(401);
  });

  it('still accepts the Authorization bearer header', async () => {
    const token = (await login()).json().token as string;
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('logout clears the session cookie', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieStr).toContain(`${SESSION_COOKIE}=`);
    // Cleared cookies carry an expiry in the past / max-age 0.
    expect(cookieStr.toLowerCase()).toMatch(/expires=|max-age=0/);
  });
});
