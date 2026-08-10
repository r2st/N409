import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createUnsubscribeToken, unsubscribeUrl } from '../../src/domain/unsubscribeToken.js';
import { getPreferenceMatrix } from '../../src/repos/notificationPreferences.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * One-click unsubscribe (RFC 8058).
 *
 * The POST is issued by Gmail or Yahoo from their own infrastructure — no
 * cookie, no redirect followed, an `application/x-www-form-urlencoded` body the
 * endpoint does not read. What is asserted here is that this actually works
 * end to end, because every way it can fail (415 on the body, 401 on the
 * missing session, a token another user forged) looks identical from outside:
 * the provider stops showing the unsubscribe button, and the only remaining way
 * for a recipient to stop the mail is to report it as spam.
 */

const SECRET = 'integration-test-secret-0123456789abcdef';

describe.skipIf(!dbUp)('one-click unsubscribe', () => {
  let ctx: TestApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const marketingPref = async (userId: string) =>
    (await getPreferenceMatrix(ctx.pool, userId)).find((p) => p.event_type === 'marketing')!;

  const tokenFor = (userId: string) => createUnsubscribeToken({ userId, scope: 'marketing' }, SECRET);

  it('turns marketing email off from the POST a mailbox provider makes', async () => {
    const user = await seedUser(ctx, { roles: ['client'] });
    expect((await marketingPref(user.id)).email).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe?token=${encodeURIComponent(tokenFor(user.id))}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    // A 415 here is the failure this endpoint exists to avoid: Fastify parses
    // JSON and text only, so the form body would be refused before the handler.
    expect(res.statusCode).toBe(200);
    expect((await marketingPref(user.id)).email).toBe(false);
  });

  it('leaves notifications about the client’s own valuation alone', async () => {
    const user = await seedUser(ctx, { roles: ['client'] });
    await app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe?token=${encodeURIComponent(tokenFor(user.id))}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    const matrix = await getPreferenceMatrix(ctx.pool, user.id);
    for (const pref of matrix.filter((p) => p.event_type !== 'marketing')) {
      expect(pref.email).toBe(true);
    }
    // And the in-app marketing switch is untouched — the header promised to
    // stop the email, not to change a setting nobody complained about.
    expect((await marketingPref(user.id)).in_app).toBe(true);
  });

  it('serves a human an HTML confirmation from the footer link', async () => {
    const user = await seedUser(ctx, { roles: ['client'] });
    const res = await app.inject({
      method: 'GET',
      url: unsubscribeUrl('', tokenFor(user.id)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('unsubscribed');
    expect((await marketingPref(user.id)).email).toBe(false);
  });

  it('ignores a forged or foreign-signed token without saying which it was', async () => {
    const user = await seedUser(ctx, { roles: ['client'] });
    const forged = createUnsubscribeToken({ userId: user.id, scope: 'marketing' }, 'a-different-secret-x');

    const res = await app.inject({ method: 'GET', url: `/api/v1/unsubscribe?token=${forged}` });
    // 200 either way: an error page from a two-year-old email converts a
    // resolved complaint into a spam report, and distinguishing "forged" from
    // "expired" tells a prober which one they achieved.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('expired');
    expect((await marketingPref(user.id)).email).toBe(true);
  });

  it('cannot be pointed at another account by editing the payload', async () => {
    const victim = await seedUser(ctx, { roles: ['client'] });
    const attacker = await seedUser(ctx, { roles: ['client'] });
    const [, signature] = tokenFor(attacker.id).split('.');
    const swapped = Buffer.from(
      JSON.stringify({ u: victim.id, s: 'marketing', e: Date.now() + 60_000 }),
    ).toString('base64url');

    const res = await app.inject({ method: 'GET', url: `/api/v1/unsubscribe?token=${swapped}.${signature}` });
    expect(res.statusCode).toBe(200);
    expect((await marketingPref(victim.id)).email).toBe(true);
  });

  it('answers a missing or malformed token without erroring', async () => {
    for (const url of [
      '/api/v1/unsubscribe',
      '/api/v1/unsubscribe?token=',
      '/api/v1/unsubscribe?token=junk',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    }
    const post = await app.inject({ method: 'POST', url: '/api/v1/unsubscribe?token=junk' });
    expect(post.statusCode).toBe(200);
  });

  it('is idempotent — a provider that retries must not see a failure', async () => {
    const user = await seedUser(ctx, { roles: ['client'] });
    const token = tokenFor(user.id);
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/unsubscribe?token=${token}` });
      expect(res.statusCode).toBe(200);
    }
    expect((await marketingPref(user.id)).email).toBe(false);
  });

  it('leaves the account otherwise reachable — the user can still sign in and read their settings', async () => {
    const user = await seedUser(ctx, { roles: ['client'] });
    await app.inject({ method: 'POST', url: `/api/v1/unsubscribe?token=${tokenFor(user.id)}` });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/notification-preferences',
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { preferences: Array<{ event_type: string; email: boolean }> };
    expect(body.preferences.find((p) => p.event_type === 'marketing')?.email).toBe(false);
  });
});
