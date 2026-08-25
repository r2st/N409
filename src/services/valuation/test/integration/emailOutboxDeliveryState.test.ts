import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { enqueueEmail, markEmail, listOutbox } from '../../src/repos/emailOutbox.js';
import { recordDeliveryEvent } from '../../src/repos/emailDelivery.js';

/**
 * What the ops outbox window says became of a message.
 *
 * Migration 0163 split two facts the outbox had been conflating: `status`
 * records what the platform did with a message — queued it, handed it to the
 * relay, gave up — and the delivery columns record what the recipient's mail
 * system did with it afterwards. A hard bounce arrives *after* a successful
 * hand-off, so the row stays `status = 'sent'` for ever, and the page an
 * operator opens to ask "why did the client not get this" showed a green Sent
 * badge over a message that was rejected.
 *
 * The columns existed and `deliveryStateOf` folded them into one state from
 * the day 0163 shipped. Nothing called it: `EmailOutboxRow` did not declare the
 * columns, so no caller could reach them, and the route served the raw status.
 * These cases pin the derivation to the wire, where the page reads it.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('GET /admin/email-outbox — delivery state', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM email_delivery_events');
    await ctx.pool.query('DELETE FROM email_suppressions');
    await ctx.pool.query('DELETE FROM email_outbox');
  });

  /** A row the relay accepted — `status = 'sent'`, nothing known past that. */
  async function seedSent(toEmail = 'client@test.example.com'): Promise<string> {
    const row = await enqueueEmail(ctx.pool, {
      toEmail,
      templateKey: 'draft_ready',
      subject: 'Your 409A is ready',
      body: 'Sign in to view it.',
    });
    await markEmail(ctx.pool, row.id, 'sent');
    return row.id;
  }

  async function fetchOutbox(): Promise<
    Array<{ id: string; status: string; delivery_state: string; bounce_kind: string | null }>
  > {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/email-outbox',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().emails;
  }

  it('reports a hard bounce on a row the relay accepted', async () => {
    const id = await seedSent();
    await recordDeliveryEvent(ctx.pool, {
      outboxId: id,
      kind: 'bounced',
      occurredAt: new Date(),
      source: 'webhook:test',
      providerEventId: 'b-1',
      bounceKind: 'hard',
      detail: '550 5.1.1 unknown recipient',
    });

    const [email] = await fetchOutbox();
    // The platform's own record is unchanged and still true: it did hand the
    // message over. The bounce is the fact that arrived afterwards, and it is
    // the one an operator is looking for.
    expect(email!.status).toBe('sent');
    expect(email!.delivery_state).toBe('bounced');
    expect(email!.bounce_kind).toBe('hard');
  });

  it('carries the delivery columns the row type used to deny', async () => {
    const id = await seedSent();
    await recordDeliveryEvent(ctx.pool, {
      outboxId: id,
      kind: 'delivered',
      occurredAt: new Date(),
      source: 'webhook:test',
      providerEventId: 'd-1',
    });
    await recordDeliveryEvent(ctx.pool, {
      outboxId: id,
      kind: 'opened',
      occurredAt: new Date(),
      source: 'webhook:test',
      providerEventId: 'o-1',
    });

    const [email] = await fetchOutbox();
    expect(email!.delivery_state).toBe('opened');
    // Every column 0163 added reaches the wire. They always did — `SELECT *`
    // put them on the row — but nothing typed could read them.
    const wire = email as unknown as Record<string, unknown>;
    for (const column of [
      'delivered_at',
      'bounced_at',
      'bounce_kind',
      'bounce_detail',
      'first_opened_at',
      'last_opened_at',
      'open_count',
    ]) {
      expect(wire).toHaveProperty(column);
    }
    expect(wire.open_count).toBe(1);
  });

  it('ranks a complaint above the delivery that preceded it', async () => {
    const id = await seedSent();
    await recordDeliveryEvent(ctx.pool, {
      outboxId: id,
      kind: 'delivered',
      occurredAt: new Date('2026-07-01T10:00:00Z'),
      source: 'webhook:test',
      providerEventId: 'd-2',
    });
    await recordDeliveryEvent(ctx.pool, {
      outboxId: id,
      kind: 'complained',
      occurredAt: new Date('2026-07-03T08:00:00Z'),
      source: 'webhook:test',
      providerEventId: 'c-2',
      bounceKind: 'complaint',
    });

    const [email] = await fetchOutbox();
    // Both are true of this message. A complaint costs a sending domain, so it
    // is what the operator is shown.
    expect(email!.delivery_state).toBe('complained');
  });

  it('leaves an unremarked row reading as its platform status', async () => {
    await seedSent();
    const [email] = await fetchOutbox();
    // No downstream signal has arrived, so there is nothing to say beyond the
    // hand-off — and 'sent' must not be dressed up as a delivery.
    expect(email!.delivery_state).toBe('sent');
    expect(email!.delivery_state).not.toBe('delivered');
  });

  it('types the delivery columns on the row the repo returns', async () => {
    const id = await seedSent();
    await recordDeliveryEvent(ctx.pool, {
      outboxId: id,
      kind: 'bounced',
      occurredAt: new Date(),
      source: 'webhook:test',
      providerEventId: 'b-3',
      bounceKind: 'soft',
      detail: '452 4.2.2 mailbox full',
    });

    // Reading these off `EmailOutboxRow` is the assertion: before the interface
    // learned about migration 0163 this did not compile, which is how the
    // columns stayed unreachable for every caller downstream of the repo.
    const [row] = await listOutbox(ctx.pool, {});
    expect(row!.bounce_kind).toBe('soft');
    expect(row!.bounce_detail).toBe('452 4.2.2 mailbox full');
    expect(row!.bounced_at).toBeInstanceOf(Date);
    expect(row!.delivered_at).toBeNull();
    expect(row!.open_count).toBe(0);
  });
});
