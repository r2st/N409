import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import { isSuppressed, releaseSuppression, suppressAddress } from '../../src/repos/emailDelivery.js';

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

    const release = async (address: string, token = admin.token) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/email/suppressions/release',
        headers: authHeader(token),
        payload: { address },
      });

    it('releases a suppression and leaves the history behind', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });

      const res = await release('gone@test.example.com');
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
      expect((await release('never@test.example.com')).statusCode).toBe(404);
    });

    /**
     * The address is carried in the body rather than the path, and this is the
     * case that forced it: fastify's router refuses a path parameter longer
     * than `maxParamLength` (100), while an address is valid to 320 and a
     * provider bounce can suppress one without any admin involved. On the old
     * `DELETE /suppressions/:address` a long address answered 414 and the
     * suppression could never be lifted — a permanent block on precisely the
     * addresses an operator most needs to unblock.
     *
     * Anything this service will suppress it must be able to release, so the
     * two are asserted as one round trip rather than as a length — the round
     * trip is the property, and it is what the old shape could not do. The
     * router's refusal itself is pinned in the blog suite, on a route that
     * still takes a path parameter; asserting it here would only prove that a
     * route which no longer exists does not exist.
     */
    it('releases an address too long to have been a path parameter', async () => {
      const long = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`;
      expect(long.length).toBeGreaterThan(100);

      const suppressed = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/email/suppressions',
        headers: authHeader(admin.token),
        payload: { address: long, reason: 'hard' },
      });
      expect(suppressed.statusCode).toBe(200);
      expect(await isSuppressed(ctx.pool, long)).not.toBeNull();

      expect((await release(long)).statusCode).toBe(204);
      expect(await isSuppressed(ctx.pool, long)).toBeNull();
    });

    it('rejects a release for something that is not an address', async () => {
      expect((await release('not-an-address')).statusCode).toBe(422);
    });

    it('keeps the release behind the same bar as the console', async () => {
      await suppressAddress(ctx.pool, { address: 'guarded@test.example.com', reason: 'hard' });
      const res = await release('guarded@test.example.com', ops.token);
      expect(res.statusCode).toBe(403);
      expect(await isSuppressed(ctx.pool, 'guarded@test.example.com')).not.toBeNull();
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
      expect(res.json()).toEqual({ applied: 1, duplicates: 0, unknown: 0 });
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

      expect((await send()).json()).toEqual({ applied: 1, duplicates: 0, unknown: 0 });
      const second = await send();
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual({ applied: 0, duplicates: 1, unknown: 0 });
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

    /**
     * A provider that batches opens routinely omits `event_id`, and every
     * provider redelivers a batch it did not get a 2xx for. Before the
     * fingerprint, `(source, NULL)` collided with nothing, so the redelivery
     * inserted the event again and `open_count` counted one open twice.
     */
    it('treats an unidentified event as a duplicate on redelivery', async () => {
      const email = await seed();
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'opened' }],
      });
      const send = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/email/testmail',
          headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
          payload: body,
        });

      expect((await send()).json()).toMatchObject({ applied: 1, duplicates: 0 });
      expect((await send()).json()).toMatchObject({ applied: 0, duplicates: 1 });
      const { rows } = await ctx.pool.query<{ open_count: number }>(
        'SELECT open_count FROM email_outbox WHERE id = $1',
        [email.id],
      );
      expect(Number(rows[0]!.open_count)).toBe(1);
    });

    /** The two ways a provider spells the same instant are the same event. */
    it('fingerprints an undated pair of spellings alike', async () => {
      const email = await seed();
      const send = (occurredAt: string) => {
        const body = JSON.stringify({
          events: [{ message_id: email.id, kind: 'opened', occurred_at: occurredAt }],
        });
        return ctx.app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/email/testmail',
          headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
          payload: body,
        });
      };

      expect((await send('2026-08-15T10:00:00Z')).json()).toMatchObject({ applied: 1 });
      expect((await send('2026-08-15T10:00:00.000Z')).json()).toMatchObject({ duplicates: 1 });
    });

    /**
     * The batch is up to 500 independent claims, and the outbox is pruned by
     * retention — so a provider reporting on a message we no longer hold is
     * ordinary, not exceptional. It used to be a foreign-key violation that
     * escaped the loop: the batch answered 500, every event after the unknown
     * one was dropped, and the redelivery reproduced the same violation at the
     * same event forever.
     */
    it('skips an event naming a message it does not have and applies the rest', async () => {
      const email = await seed();
      const body = JSON.stringify({
        events: [
          { message_id: '01JBAAAAAAAAAAAAAAAAAAAAAA', kind: 'delivered', event_id: 'gone-1' },
          { message_id: email.id, kind: 'delivered', event_id: 'after-1' },
        ],
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/email/testmail',
        headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
        payload: body,
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ applied: 1, duplicates: 0, unknown: 1 });
      const { rows } = await ctx.pool.query<{ delivered_at: Date | null }>(
        'SELECT delivered_at FROM email_outbox WHERE id = $1',
        [email.id],
      );
      expect(rows[0]!.delivered_at).not.toBeNull();
    });

    /**
     * The suppression is a second write, after the event has committed. When it
     * was skipped — a transient failure, a process that died between the two —
     * the provider's redelivery arrived as a duplicate and the old code took
     * the branch that does nothing, so a hard bounce stayed recorded and
     * unsuppressed for good.
     */
    it('suppresses on a redelivered bounce whose suppression never happened', async () => {
      const email = await seed('halfway@test.example.com');
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'bounced', event_id: 'evt-half', status: '5.1.1' }],
      });
      const send = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/email/testmail',
          headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
          payload: body,
        });

      await send();
      // The state a half-finished event leaves behind: the ledger has it, the
      // suppression list does not.
      await ctx.pool.query('DELETE FROM email_suppressions');
      const second = await send();
      expect(second.json()).toMatchObject({ applied: 0, duplicates: 1 });
      expect(await isSuppressed(ctx.pool, 'halfway@test.example.com')).not.toBeNull();
    });

    /**
     * The other direction, and the reason the redelivery cannot simply
     * re-suppress: an administrator's release is answered by the *next* bounce,
     * not by the provider sending the same one again.
     */
    it('does not undo an administrator release on a redelivered bounce', async () => {
      const email = await seed('released@test.example.com');
      const body = JSON.stringify({
        events: [{ message_id: email.id, kind: 'bounced', event_id: 'evt-rel', status: '5.1.1' }],
      });
      const send = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/email/testmail',
          headers: { 'content-type': 'application/json', 'x-n409-signature': sign(body) },
          payload: body,
        });

      await send();
      expect(await releaseSuppression(ctx.pool, 'released@test.example.com', admin.id)).toBe(true);
      await send();
      expect(await isSuppressed(ctx.pool, 'released@test.example.com')).toBeNull();
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
