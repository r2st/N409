import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import { isSuppressed, suppressAddress } from '../../src/repos/emailDelivery.js';

/**
 * The operator's half of delivery tracking (0163): the figures, the suppression
 * list, and the one authenticated way a downstream signal gets in.
 */

const dbUp = await isDbAvailable();

/** At least 32 chars — the config schema refuses anything shorter. */
const WEBHOOK_SECRET = 'email-webhook-test-secret-0123456789';

function sign(body: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

describe.skipIf(!dbUp)('email delivery routes', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let admin: { id: string; token: string };
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ EMAIL_WEBHOOK_SECRET: WEBHOOK_SECRET });
    // `reviewer` is operations but not a user administrator — the boundary the
    // write routes below are supposed to enforce.
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM email_delivery_events');
    await ctx.pool.query('DELETE FROM email_suppressions');
    await ctx.pool.query('DELETE FROM email_outbox');
  });

  async function seed(toEmail = 'client@test.example.com'): Promise<EmailOutboxRow> {
    return enqueueEmail(ctx.pool, {
      toEmail,
      templateKey: 'draft_ready',
      subject: 'Your 409A is ready',
      body: 'Sign in to view it.',
    });
  }

  describe('GET /admin/email/delivery-stats', () => {
    it('is refused to a client', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/delivery-stats',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('is refused without authentication', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/delivery-stats',
      });
      expect(res.statusCode).toBe(401);
    });

    it('reports the counts an operator reads', async () => {
      const a = await seed('a@test.example.com');
      await markEmail(ctx.pool, a.id, 'sent');
      await seed('b@test.example.com');

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/delivery-stats?days=30',
        headers: authHeader(ops.token),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totals.total).toBe(2);
      expect(body.totals.sent).toBe(1);
      expect(body.totals.queued).toBe(1);
      expect(body.by_template).toEqual([expect.objectContaining({ template_key: 'draft_ready', total: 2 })]);
    });

    /**
     * Two messages is not a delivery rate. A dashboard that reports "0%
     * delivered" off a denominator that small sends somebody to investigate an
     * outage that is not happening.
     */
    it('declines to state a rate off a denominator too small to mean one', async () => {
      const a = await seed();
      await markEmail(ctx.pool, a.id, 'sent');

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/delivery-stats',
        headers: authHeader(ops.token),
      });
      expect(res.json().rates.delivered).toBeNull();
    });

    it('rejects a window outside the bounds', async () => {
      for (const days of ['0', '400', 'abc']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/admin/email/delivery-stats?days=${days}`,
          headers: authHeader(ops.token),
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe('the suppression list', () => {
    it('lets operations read it and refuses a client', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });

      const allowed = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/suppressions',
        headers: authHeader(ops.token),
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().suppressions).toHaveLength(1);

      const refused = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/suppressions',
        headers: authHeader(client.token),
      });
      expect(refused.statusCode).toBe(403);
    });

    it('lets an administrator suppress an address, and refuses a mere operator', async () => {
      const refused = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/email/suppressions',
        headers: authHeader(ops.token),
        payload: { address: 'bad@test.example.com', reason: 'hard' },
      });
      expect(refused.statusCode).toBe(403);

      const allowed = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/email/suppressions',
        headers: authHeader(admin.token),
        payload: { address: 'bad@test.example.com', reason: 'hard' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(await isSuppressed(ctx.pool, 'bad@test.example.com')).not.toBeNull();
    });

    it('rejects something that is not an address', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/email/suppressions',
        headers: authHeader(admin.token),
        payload: { address: 'not-an-address', reason: 'hard' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('releases a suppression and leaves the history behind', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/email/suppressions/gone@test.example.com',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(204);
      expect(await isSuppressed(ctx.pool, 'gone@test.example.com')).toBeNull();

      // Released, not deleted.
      const listed = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/email/suppressions?include_released=true',
        headers: authHeader(admin.token),
      });
      expect(listed.json().suppressions).toHaveLength(1);
      expect(listed.json().suppressions[0].released_by).toBe(admin.id);
    });

    it('answers 404 when there is nothing to release', async () => {
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/email/suppressions/never@test.example.com',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /webhooks/email/:provider', () => {
    it('refuses an unsigned request', async () => {
      const email = await seed();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ events: [{ message_id: email.id, kind: 'delivered' }] }),
      });
      expect(res.statusCode).toBe(401);
    });

    /**
     * The reason the signature exists. Without it, anyone on the internet could
     * mark a named client's address as bounced — which suppresses it, and stops
     * that client receiving their own valuation reports.
     */
    it('refuses a wrongly-signed request', async () => {
      const email = await seed();
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'bounced', bounce_kind: 'hard' }],
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json', 'x-n409-signature': sign(`${body} `) },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect((await ctx.pool.query('SELECT * FROM email_suppressions')).rowCount).toBe(0);
    });

    it('records a signed delivery', async () => {
      const email = await seed();
      const body = JSON.stringify({
        events: [
          {
            message_id: email.id,
            kind: 'delivered',
            event_id: 'evt-1',
            occurred_at: '2026-08-15T10:00:00.000Z',
          },
        ],
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
        payload: body,
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ applied: 1, duplicates: 0 });
      const { rows } = await ctx.pool.query<{ delivered_at: Date | null }>(
        'SELECT delivered_at FROM email_outbox WHERE id = $1',
        [email.id],
      );
      expect(rows[0]!.delivered_at).not.toBeNull();
    });

    it('answers 2xx to a redelivery rather than making the provider escalate', async () => {
      const email = await seed();
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'delivered', event_id: 'evt-dupe' }],
      });
      const send = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/email/testmail',
          headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
          payload: body,
        });

      expect((await send()).json()).toEqual({ applied: 1, duplicates: 0 });
      const second = await send();
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual({ applied: 0, duplicates: 1 });
    });

    it('suppresses the address the outbox row names on a hard bounce', async () => {
      const email = await seed('dead@test.example.com');
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'bounced', event_id: 'evt-b', status: '5.1.1' }],
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
        payload: body,
      });

      expect(res.statusCode).toBe(202);
      expect(await isSuppressed(ctx.pool, 'dead@test.example.com')).not.toBeNull();
    });

    /**
     * An unqualified "bounced" with no status and no classification is the
     * shape most likely to be a soft failure a provider has not characterised.
     * Suppressing on it is the false positive this subsystem is most likely to
     * produce, so it does not.
     */
    it('does not suppress on a bounce the provider did not qualify', async () => {
      const email = await seed('maybe@test.example.com');
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'bounced', event_id: 'evt-vague' }],
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
        payload: body,
      });
      expect(await isSuppressed(ctx.pool, 'maybe@test.example.com')).toBeNull();
    });

    it('rejects a payload that is not the shape it accepts', async () => {
      const body = JSON.stringify({ events: [{ message_id: 'not-a-ulid', kind: 'delivered' }] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
        payload: body,
      });
      expect(res.statusCode).toBe(422);
    });
  });
});

/**
 * With no secret configured — which is what this deployment runs — the route
 * exists and refuses everything. Registered rather than absent so `routeAudit`
 * has a site to audit; refusing before it reads the body so it can never
 * accept an unsigned delivery claim. Its own app, because the secret is read
 * at construction.
 */
describe.skipIf(!dbUp)('the delivery webhook without a secret', () => {
  it('refuses every call, signed or not', async () => {
    const bare = await setupTestApp();
    try {
      const body = JSON.stringify({ events: [] });
      for (const headers of [
        { 'content-type': 'application/json' },
        { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
      ]) {
        const res = await bare.app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/email/testmail',
          headers,
          payload: body,
        });
        expect(res.statusCode).toBe(503);
      }
    } finally {
      await bare.teardown();
    }
  });
});
