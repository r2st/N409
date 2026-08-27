/**
 * The account's own side of the audit spine.
 *
 * `loginAudit.test.ts` covers the door in. This covers the rest of what an
 * account does to itself and what a credential change looks like on the trail:
 * signing out, changing a password, redeeming a reset link, enrolling and
 * removing a second factor, minting and revoking an API token, and taking a
 * copy of one's own personal data. Every one of these wrote nothing before
 * R159, while the administrator's equivalent of each wrote a row — so the
 * trail described the console and not the account.
 *
 * `identityAuditCensus.test.ts` states the rule over the source. This asserts
 * the rows actually land, with the actor and subject filled in: a census can
 * see a `recordAdminEvent(` call and cannot see that it is reached.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createUser } from '../../src/repos/users.js';
import { createPasswordResetToken } from '../../src/repos/passwordResets.js';
import { hashPassword } from '../../src/auth/password.js';
import { totp } from '../../src/auth/totp.js';
import { authHeader, isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const PASSWORD = 'identity-audit-password-1';

interface EventRow {
  type: string;
  actor_id: string | null;
  actor_type: string;
  source: string | null;
  subject_id: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
}

describe.skipIf(!dbUp)('identity and credential events reach the audit spine', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  /** A fresh password account plus a live session token for it. */
  async function seedAccount(): Promise<{ id: string; email: string; token: string }> {
    const email = `${newUlid().toLowerCase()}@identity-audit.example.com`;
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
    expect(res.statusCode).toBe(200);
    return { id: user.id, email, token: res.json().token as string };
  }

  async function eventsFor(userId: string, type: string): Promise<EventRow[]> {
    const { rows } = await ctx.pool.query<EventRow>(
      `SELECT type, actor_id, actor_type, source, subject_id, subject_label, payload
         FROM admin_events WHERE subject_id = $1 AND type = $2 ORDER BY occurred_at`,
      [userId, type],
    );
    return rows;
  }

  it('records a sign-out, which the trail could never see the end of', async () => {
    const user = await seedAccount();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);

    const rows = await eventsFor(user.id, 'user_logout');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(user.id);
  });

  it('writes nothing for a sign-out with no readable session', async () => {
    // The route is public and must work with an expired or missing token, so
    // there is a branch where nothing can be named. A row saying "somebody
    // signed out" is not a record of anything, and an unauthenticated endpoint
    // that appends one per call is a write amplifier besides.
    const before = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_events WHERE type = 'user_logout'`,
    );
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(200);
    const after = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_events WHERE type = 'user_logout'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('records a password change, and says the other sessions went with it', async () => {
    const user = await seedAccount();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(user.token),
      payload: { current_password: PASSWORD, new_password: 'identity-audit-password-2' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await eventsFor(user.id, 'user_password_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ method: 'change', sessions_revoked: true });
    expect(rows[0]!.subject_label).toBe(user.email);
  });

  it('records a reset completed through the link, where nobody is signed in', async () => {
    const user = await seedAccount();
    const secret = await createPasswordResetToken(ctx.pool, user.id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token: secret, password: 'identity-audit-password-3' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await eventsFor(user.id, 'user_password_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ method: 'reset' });
    // The token is the whole authority here, so the subject is also the actor —
    // and naming them is the point: `resetPasswordWithToken` used to return a
    // bare boolean, which is a fact about the request and not about anybody.
    expect(rows[0]!.actor_id).toBe(user.id);
    expect(rows[0]!.source).toBe('password_reset');
  });

  it('records a reset *request* whether or not the address has an account', async () => {
    // Both branches, because the alternative is one extra insert on the round
    // trip only when the address exists — the timing oracle this route is
    // written to avoid. Recording the misses is also the only way a run of
    // resets requested against addresses with no account is visible at all.
    const user = await seedAccount();
    for (const email of [user.email, `${newUlid().toLowerCase()}@nobody.example.com`]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email },
      });
      expect(res.statusCode).toBe(202);
    }
    const { rows } = await ctx.pool.query<EventRow>(
      `SELECT type, subject_id, subject_label, payload FROM admin_events
        WHERE type = 'user_password_reset_sent' AND payload->>'self_service' = 'true'
          AND (subject_id = $1 OR subject_label LIKE '%@nobody.example.com')
        ORDER BY occurred_at`,
      [user.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.subject_id).toBe(user.id);
    expect(rows[0]!.payload).toMatchObject({ sent: true });
    // The miss is recorded with the address and no subject — there is nobody
    // to name, which is exactly what the row is saying.
    expect(rows[1]!.subject_id).toBeNull();
    expect(rows[1]!.payload).toMatchObject({ sent: false });
  });

  it('records enrolling a second factor, and removing one, differently', async () => {
    const user = await seedAccount();

    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/setup',
      headers: authHeader(user.token),
    });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;

    // Staging writes nothing — the exemption the census holds a reason for.
    expect(await eventsFor(user.id, 'user_mfa_enabled')).toHaveLength(0);

    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/confirm',
      headers: authHeader(user.token),
      payload: { code: totp(secret) },
    });
    expect(confirm.statusCode).toBe(200);
    const enabled = await eventsFor(user.id, 'user_mfa_enabled');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.payload).toMatchObject({ method: 'totp' });

    const codes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/backup-codes',
      headers: authHeader(user.token),
      payload: { password: PASSWORD },
    });
    expect(codes.statusCode).toBe(200);
    expect(await eventsFor(user.id, 'user_mfa_backup_codes_regenerated')).toHaveLength(1);

    const disable = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/account/mfa/disable',
      headers: authHeader(user.token),
      payload: { password: PASSWORD },
    });
    expect(disable.statusCode).toBe(200);
    // The one an owner would want to be asked about afterwards.
    expect(await eventsFor(user.id, 'user_mfa_disabled')).toHaveLength(1);
  });

  it('records a personal API token being minted and revoked', async () => {
    const user = await seedAccount();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: authHeader(user.token),
      // Re-authenticated since R185.
      payload: { name: 'audit-fixture', current_password: PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    const tokenId = created.json().token.id as string;

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${tokenId}`,
      headers: authHeader(user.token),
    });
    expect(revoked.statusCode).toBe(204);

    // Keyed on the token, not the user — the credential is the subject, which
    // is what makes "this token existed for four minutes" answerable at all.
    const { rows } = await ctx.pool.query<EventRow>(
      `SELECT type, actor_id, subject_id, subject_label, payload FROM admin_events
        WHERE subject_id = $1 ORDER BY occurred_at`,
      [tokenId],
    );
    expect(rows.map((r) => r.type)).toEqual(['api_token_created', 'api_token_revoked']);
    expect(rows[0]!.actor_id).toBe(user.id);
    expect(rows[0]!.subject_label).toBe('audit-fixture');
    expect(rows[0]!.payload).toMatchObject({ personal: true });
  });

  it('records a person exporting their own data, not only an admin doing it for them', async () => {
    const user = await seedAccount();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/data-export',
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);

    const rows = await eventsFor(user.id, 'user_data_exported');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(user.id);
    expect(rows[0]!.payload).toMatchObject({ self_service: true });
  });

  it('records a self-service registration as a created account', async () => {
    const email = `${newUlid().toLowerCase()}@identity-audit.example.com`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, first_name: 'Ada', last_name: 'Lovelace' },
    });
    expect(res.statusCode).toBe(201);
    const userId = res.json().user.id as string;

    const rows = await eventsFor(userId, 'user_created');
    expect(rows).toHaveLength(1);
    // One type per question, with the door in the payload — the same row an
    // administrator minting a seat writes, and the same row SAML JIT and SCIM
    // write, so "how did this account appear" is one query.
    expect(rows[0]!.payload).toMatchObject({ method: 'self_service' });
  });

  it('records a profile change by field name and never by value', async () => {
    const user = await seedAccount();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: authHeader(user.token),
      payload: { first_name: 'Grace' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await eventsFor(user.id, 'user_updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ self_service: true, email_changed: false });
    expect(rows[0]!.payload.fields).toEqual(['first_name']);
    // The trail sits beside the personal data; it is not a second copy of it.
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('Grace');
  });
});
