import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import type { GoogleOidc } from '../../src/auth/google.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { totp, TOTP_PERIOD_SECONDS } from '../../src/auth/totp.js';
import { authHeader, isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const PASSWORD = 'sso-second-factor-1234';

/**
 * THE SECOND FACTOR, ON THE TWO DOORS THAT NEVER ASKED FOR IT (R354, M6).
 *
 * `POST /auth/login` answers a 2FA-enabled account with a challenge rather than
 * a session, and `POST /auth/mfa/verify` is the only thing that turns one into
 * the other. Both SSO doors issued the session outright.
 *
 * `upsertGoogleUser` matches on the address alone. An account created here with
 * a password, which then enrolled TOTP here, is *linked* the first time that
 * address arrives from Google: its `password_digest` and its `totp_secret` are
 * left as they were and `sso_provider` is stamped on the way past. So the
 * factor its owner enrolled — and which `require_mfa` will not let them remove
 * — was skipped in full by the button beside the password box, and whoever
 * controls the Google identity for that address held the account. The SAML ACS
 * matched the same account the same way.
 *
 * Nothing about it was visible either: the bypass arrives on the spine as an
 * ordinary `user_login`, and every refusal and hand-off on these routes is a
 * 302 that `http_requests_total` counts beside every other redirect.
 *
 * The code the challenge is redeemed with is the *next* step's, for the reason
 * `mfa.test.ts` gives: confirming enrolment spends the step its own code
 * belongs to (migration 0097).
 */
function nextStepCode(secret: string): string {
  return totp(secret, Date.now() + TOTP_PERIOD_SECONDS * 1000);
}

describe.skipIf(!dbUp)('SSO hand-off — an account with 2FA is challenged, not signed in', () => {
  let ctx: TestApp;
  const identity = { sub: 'google-oidc-sub-mfa', email: '', emailVerified: true };

  const stubGoogle = {
    authorizationUrl: (state: string) =>
      `https://accounts.example.test/o/oauth2?state=${encodeURIComponent(state)}`,
    exchangeCode: async () => 'stub-id-token',
    verifyIdToken: async () => ({ ...identity }),
  } as unknown as GoogleOidc;

  beforeAll(async () => {
    ctx = await setupTestApp({}, { google: stubGoogle });
  });
  afterAll(async () => ctx?.teardown());

  async function freshState(): Promise<string> {
    const start = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/google' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    if (!state) throw new Error(`no state in ${start.headers.location as string}`);
    return state;
  }

  const callback = async (headers: Record<string, string> = { accept: 'text/html' }) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=stub-code&state=${encodeURIComponent(await freshState())}`,
      headers,
    });

  /** A password account that has completed enrolment, as its owner would. */
  async function seedEnrolled(): Promise<{ id: string; email: string; secret: string }> {
    const email = `${newUlid().toLowerCase()}@sso-mfa.example.com`;
    const user = await createUser(ctx.pool, {
      email,
      passwordDigest: await hashPassword(PASSWORD),
      roles: ['valuation_user'],
    });
    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    const token = signIn.json().token as string;
    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/setup',
      headers: authHeader(token),
      payload: { password: PASSWORD },
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
    return { id: user.id, email, secret };
  }

  it('hands a browser a challenge in the fragment rather than a session token', async () => {
    const enrolled = await seedEnrolled();
    identity.email = enrolled.email;

    const res = await callback();
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    // The whole of the finding: this used to be `#token=…`, a full session for
    // an account whose owner had enrolled a second factor here.
    expect(location).toContain('#mfa=');
    expect(location).not.toContain('#token=');
    // And no session by the other route out either.
    expect(res.headers['set-cookie']).toBeUndefined();

    // The challenge is the one `/auth/mfa/verify` redeems, and redeeming it is
    // what issues the session — so the factor is required, not merely displayed.
    const challenge = decodeURIComponent(location.split('#mfa=')[1]!);
    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { challenge, code: nextStepCode(enrolled.secret) },
    });
    expect(verified.statusCode).toBe(200);
    expect(typeof verified.json().token).toBe('string');
  });

  it('answers an API caller with the same shape the password door uses', async () => {
    // Whether the second factor is asked for must not depend on whether the
    // caller happened to send `Accept: text/html` — the asymmetry R273 found on
    // the refusal half of this route.
    const enrolled = await seedEnrolled();
    identity.email = enrolled.email;

    const res = await callback({ accept: 'application/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mfa_required: true });
    expect(res.json().token).toBeUndefined();
    expect(typeof res.json().challenge).toBe('string');
  });

  it('records no sign-in for a hand-off that issued no session', async () => {
    const enrolled = await seedEnrolled();
    identity.email = enrolled.email;
    await callback();

    const { rows } = await ctx.pool.query<{ type: string }>(
      `SELECT type FROM admin_events WHERE subject_id = $1 AND type IN ('user_login', 'user_login_failed')`,
      [enrolled.id],
    );
    // `user_mfa_enabled` and the password sign-in that preceded enrolment are
    // this account's history; the Google hand-off adds nothing, because nobody
    // has signed in yet. Before R354 it added a `user_login` naming a session
    // that never met the second factor.
    expect(rows.filter((r) => r.type === 'user_login')).toHaveLength(1);
  });

  it('still signs an account with no second factor straight in', async () => {
    // The change is scoped to accounts that enrolled one. Everybody else keeps
    // the one-hop hand-off they had.
    identity.email = `${newUlid().toLowerCase()}@sso-mfa.example.com`;
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('#token=');
  });
});
