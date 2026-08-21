import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import {
  deliveryStats,
  isSuppressed,
  listDeliveryEvents,
  recordDeliveryEvent,
  recordSendFailure,
  releaseSuppression,
  suppressAddress,
} from '../../src/repos/emailDelivery.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

/**
 * Delivery tracking and the suppression list (migration 0163).
 *
 * The subsystem exists because the outbox recorded a handoff and called it a
 * delivery, and because the 0159 retry ladder could not tell a relay that was
 * down from a mailbox that does not exist. The cases below are organised around
 * the two ways that costs something real: a dead address burning the ladder
 * over and over, and — the more expensive one — a live client's address being
 * suppressed for a failure that was ours.
 */

const dbUp = await isDbAvailable();

/** What `sendSmtp` throws: a message, the stage, and the reply code. */
class FakeSmtpError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly replyCode: number | null,
  ) {
    super(message);
  }
}

describe.skipIf(!dbUp)('email delivery tracking', () => {
  let ctx: TestApp;
  /** The administrator whose name goes on a released suppression. */
  let admin: { id: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM email_delivery_events');
    await ctx.pool.query('DELETE FROM email_suppressions');
    await ctx.pool.query('DELETE FROM email_outbox');
  });

  async function seed(overrides: Partial<{ toEmail: string; templateKey: string }> = {}) {
    return enqueueEmail(ctx.pool, {
      toEmail: overrides.toEmail ?? 'client@test.example.com',
      templateKey: overrides.templateKey ?? 'draft_ready',
      subject: 'Your 409A is ready',
      body: 'Sign in to view it.',
    });
  }

  /** Fail a row and clear its ladder stamp, so a sweep may take it now. */
  async function failAndMakeDue(id: string, error: string): Promise<void> {
    await markEmail(ctx.pool, id, 'failed', error);
    await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [id]);
  }

  async function reread(id: string): Promise<EmailOutboxRow> {
    const { rows } = await ctx.pool.query<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = $1', [id]);
    return rows[0]!;
  }

  describe('a permanent rejection of the recipient', () => {
    it('stops the ladder and suppresses the address', async () => {
      const email = await seed({ toEmail: 'gone@test.example.com' });
      const err = new FakeSmtpError('SMTP RCPT failed: 550 5.1.1 Recipient address rejected', 'rcpt', 550);

      await failAndMakeDue(email.id, err.message);
      const kind = await recordSendFailure(ctx.pool, email, err);

      expect(kind).toBe('hard');
      const row = await reread(email.id);
      expect(row.bounce_kind).toBe('hard');
      expect(row.bounced_at).not.toBeNull();
      expect(await isSuppressed(ctx.pool, 'gone@test.example.com')).not.toBeNull();
    });

    /**
     * The behavioural claim, made against the sweep rather than against the
     * column: a bounced row must not be handed to the transport again. Before
     * 0163 this row had five more attempts over eight and a half hours, every
     * one of them a fresh connection to a relay that had already refused it.
     */
    it('is never claimed by a later sweep', async () => {
      const email = await seed({ toEmail: 'gone@test.example.com' });
      const err = new FakeSmtpError('SMTP RCPT failed: 550 no such user', 'rcpt', 550);
      await failAndMakeDue(email.id, err.message);
      await recordSendFailure(ctx.pool, email, err);

      const attempts: string[] = [];
      const spy: EmailTransport = {
        async send(row) {
          attempts.push(row.id);
        },
      };
      const result = await retryFailedEmails({ pool: ctx.pool, transport: spy });

      expect(attempts).toEqual([]);
      expect(result.attempted).toBe(0);
    });

    it('records a ledger entry naming what the relay said', async () => {
      const email = await seed();
      const err = new FakeSmtpError('SMTP RCPT failed: 550 5.1.1 unknown mailbox', 'rcpt', 550);
      await recordSendFailure(ctx.pool, email, err);

      const events = await listDeliveryEvents(ctx.pool, email.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('bounced');
      expect(events[0]!.bounce_kind).toBe('hard');
      expect(events[0]!.source).toBe('smtp');
      expect(events[0]!.detail).toMatch(/unknown mailbox/);
    });
  });

  describe('a failure that is ours', () => {
    /**
     * The case that would be worst to get wrong. A relay whose credentials we
     * have wrong answers 535 to every message in the outbox; suppressing on it
     * would take out every client with mail in flight during the outage, and
     * they would then stop receiving reports with nothing saying why.
     */
    it('never suppresses the recipient for an auth failure', async () => {
      const email = await seed({ toEmail: 'live-client@test.example.com' });
      const err = new FakeSmtpError('SMTP AUTH failed: 535 5.7.8 bad credentials', 'auth', 535);

      const kind = await recordSendFailure(ctx.pool, email, err);

      expect(kind).toBe('soft');
      const row = await reread(email.id);
      expect(row.bounce_kind).toBeNull();
      expect(await isSuppressed(ctx.pool, 'live-client@test.example.com')).toBeNull();
    });

    it('leaves such a row on the ladder', async () => {
      const email = await seed({ toEmail: 'live-client@test.example.com' });
      const err = new FakeSmtpError('SMTP AUTH failed: 535 bad credentials', 'auth', 535);
      await failAndMakeDue(email.id, err.message);
      await recordSendFailure(ctx.pool, email, err);

      const attempts: string[] = [];
      await retryFailedEmails({
        pool: ctx.pool,
        transport: {
          async send(row) {
            attempts.push(row.id);
          },
        },
      });
      expect(attempts).toEqual([email.id]);
    });

    it('leaves an unclassifiable error alone entirely', async () => {
      const email = await seed();
      const kind = await recordSendFailure(ctx.pool, email, new Error('socket hang up'));
      expect(kind).toBeNull();
      expect((await reread(email.id)).bounce_kind).toBeNull();
      expect(await listDeliveryEvents(ctx.pool, email.id)).toHaveLength(0);
    });

    it('treats a transient rejection of the recipient as soft', async () => {
      const email = await seed({ toEmail: 'busy@test.example.com' });
      const err = new FakeSmtpError('SMTP RCPT failed: 450 mailbox busy', 'rcpt', 450);
      expect(await recordSendFailure(ctx.pool, email, err)).toBe('soft');
      expect(await isSuppressed(ctx.pool, 'busy@test.example.com')).toBeNull();
    });
  });

  describe('the suppression list at enqueue', () => {
    it('records a skipped row rather than sending to a suppressed address', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });

      const email = await seed({ toEmail: 'gone@test.example.com' });

      expect(email.status).toBe('skipped');
      expect(email.error).toMatch(/suppressed \(hard\)/);
    });

    it('matches an address regardless of case', async () => {
      await suppressAddress(ctx.pool, { address: 'Gone@Test.Example.com', reason: 'hard' });
      const email = await seed({ toEmail: 'gone@test.example.com' });
      expect(email.status).toBe('skipped');
    });

    /**
     * A suppression stops mail to a dead address; it must not lock a user out
     * of the product. Verification is the one message that exists to prove an
     * address works, so it is the way back — without this exemption a
     * suppression could only ever be cleared by an administrator.
     */
    it('still sends the verification mail that proves the address works', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });
      const email = await seed({
        toEmail: 'gone@test.example.com',
        templateKey: 'email_verification',
      });
      expect(email.status).toBe('queued');
    });

    it('sends again once an administrator releases the address', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });
      expect((await seed({ toEmail: 'gone@test.example.com' })).status).toBe('skipped');

      expect(await releaseSuppression(ctx.pool, 'gone@test.example.com', admin.id)).toBe(true);

      expect((await seed({ toEmail: 'gone@test.example.com' })).status).toBe('queued');
    });

    it('leaves an unrelated address alone', async () => {
      await suppressAddress(ctx.pool, { address: 'gone@test.example.com', reason: 'hard' });
      expect((await seed({ toEmail: 'fine@test.example.com' })).status).toBe('queued');
    });
  });

  describe('folding provider events', () => {
    it('records a delivery distinctly from a send', async () => {
      const email = await seed();
      await markEmail(ctx.pool, email.id, 'sent');
      expect((await reread(email.id)).delivered_at).toBeNull();

      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'delivered',
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        source: 'webhook:test',
        providerEventId: 'evt-1',
      });

      const row = await reread(email.id);
      expect(row.status).toBe('sent');
      expect(row.delivered_at).not.toBeNull();
    });

    /**
     * A provider that does not get a 2xx inside its timeout redelivers, and it
     * will redeliver something we already stored. Applying it twice would
     * report two opens for one read.
     */
    it('ignores a redelivered event it has already stored', async () => {
      const email = await seed();
      const event = {
        outboxId: email.id,
        kind: 'opened' as const,
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        source: 'webhook:test',
        providerEventId: 'evt-open-1',
      };

      expect(await recordDeliveryEvent(ctx.pool, event)).toBe(true);
      expect(await recordDeliveryEvent(ctx.pool, event)).toBe(false);

      expect((await reread(email.id)).open_count).toBe(1);
      expect(await listDeliveryEvents(ctx.pool, email.id)).toHaveLength(1);
    });

    /**
     * Events arrive out of order — a bounce from a forwarding hop can beat the
     * delivery notification from the first one. The final row must not depend
     * on which arrived first.
     */
    it('lands on the same row whichever order two events arrive in', async () => {
      const earlier = new Date('2026-08-15T10:00:00Z');
      const later = new Date('2026-08-15T10:05:00Z');

      const a = await seed();
      await recordDeliveryEvent(ctx.pool, {
        outboxId: a.id,
        kind: 'delivered',
        occurredAt: earlier,
        source: 'webhook:test',
        providerEventId: 'a-1',
      });
      await recordDeliveryEvent(ctx.pool, {
        outboxId: a.id,
        kind: 'bounced',
        occurredAt: later,
        source: 'webhook:test',
        providerEventId: 'a-2',
        bounceKind: 'hard',
      });

      const b = await seed();
      await recordDeliveryEvent(ctx.pool, {
        outboxId: b.id,
        kind: 'bounced',
        occurredAt: later,
        source: 'webhook:test',
        providerEventId: 'b-2',
        bounceKind: 'hard',
      });
      await recordDeliveryEvent(ctx.pool, {
        outboxId: b.id,
        kind: 'delivered',
        occurredAt: earlier,
        source: 'webhook:test',
        providerEventId: 'b-1',
      });

      const rowA = await reread(a.id);
      const rowB = await reread(b.id);
      expect(rowA.delivered_at?.toISOString()).toBe(rowB.delivered_at?.toISOString());
      expect(rowA.bounced_at?.toISOString()).toBe(rowB.bounced_at?.toISOString());
      expect(rowA.bounce_kind).toBe(rowB.bounce_kind);
      expect(rowA.bounce_kind).toBe('hard');
    });

    it('does not let a soft bounce downgrade a hard one', async () => {
      const email = await seed();
      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'bounced',
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        source: 'webhook:test',
        providerEventId: 'hard-1',
        bounceKind: 'hard',
      });
      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'bounced',
        occurredAt: new Date('2026-08-15T10:05:00Z'),
        source: 'webhook:test',
        providerEventId: 'soft-1',
        bounceKind: 'soft',
      });
      expect((await reread(email.id)).bounce_kind).toBe('hard');
    });

    it('lets a complaint supersede a hard bounce', async () => {
      const email = await seed();
      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'bounced',
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        source: 'webhook:test',
        providerEventId: 'h-1',
        bounceKind: 'hard',
      });
      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'complained',
        occurredAt: new Date('2026-08-15T10:05:00Z'),
        source: 'webhook:test',
        providerEventId: 'c-1',
        bounceKind: 'complaint',
      });
      expect((await reread(email.id)).bounce_kind).toBe('complaint');
    });

    it('counts repeated opens and keeps the first and last', async () => {
      const email = await seed();
      for (const [i, at] of ['10:00:00', '11:00:00', '09:00:00'].entries()) {
        await recordDeliveryEvent(ctx.pool, {
          outboxId: email.id,
          kind: 'opened',
          occurredAt: new Date(`2026-08-15T${at}Z`),
          source: 'pixel',
          providerEventId: `open-${i}`,
        });
      }
      const row = await reread(email.id);
      expect(row.open_count).toBe(3);
      expect(row.first_opened_at?.toISOString()).toBe('2026-08-15T09:00:00.000Z');
      expect(row.last_opened_at?.toISOString()).toBe('2026-08-15T11:00:00.000Z');
    });

    /**
     * An open is proof of delivery no delivery notification was needed for.
     * Providers that report opens but not deliveries are common, and a message
     * somebody demonstrably read must not sit in the stats as merely 'sent'.
     */
    it('treats an open as evidence of delivery', async () => {
      const email = await seed();
      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'opened',
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        source: 'pixel',
        providerEventId: null,
      });
      expect((await reread(email.id)).delivered_at).not.toBeNull();
    });

    it('stores a deferral without changing the row', async () => {
      const email = await seed();
      await markEmail(ctx.pool, email.id, 'sent');
      await recordDeliveryEvent(ctx.pool, {
        outboxId: email.id,
        kind: 'deferred',
        occurredAt: new Date('2026-08-15T10:00:00Z'),
        source: 'webhook:test',
        providerEventId: 'def-1',
      });
      const row = await reread(email.id);
      expect(row.delivered_at).toBeNull();
      expect(row.bounced_at).toBeNull();
      expect(await listDeliveryEvents(ctx.pool, email.id)).toHaveLength(1);
    });
  });

  describe('the stats a dashboard reads', () => {
    it('counts each outcome once over the window', async () => {
      const delivered = await seed({ toEmail: 'a@test.example.com' });
      await markEmail(ctx.pool, delivered.id, 'sent');
      await recordDeliveryEvent(ctx.pool, {
        outboxId: delivered.id,
        kind: 'delivered',
        occurredAt: new Date(),
        source: 'webhook:test',
        providerEventId: 's-1',
      });

      const bounced = await seed({ toEmail: 'b@test.example.com' });
      await recordDeliveryEvent(ctx.pool, {
        outboxId: bounced.id,
        kind: 'bounced',
        occurredAt: new Date(),
        source: 'webhook:test',
        providerEventId: 's-2',
        bounceKind: 'hard',
      });

      const complained = await seed({ toEmail: 'c@test.example.com' });
      await recordDeliveryEvent(ctx.pool, {
        outboxId: complained.id,
        kind: 'complained',
        occurredAt: new Date(),
        source: 'webhook:test',
        providerEventId: 's-3',
        bounceKind: 'complaint',
      });

      const stats = await deliveryStats(ctx.pool, 30);
      expect(stats.total).toBe(3);
      expect(stats.delivered).toBe(1);
      // A complaint is counted as a complaint and not also as a bounce, so the
      // buckets sum to the total rather than double-counting.
      expect(stats.bounced).toBe(1);
      expect(stats.complained).toBe(1);
    });

    it('counts addresses currently suppressed, not ones since released', async () => {
      await suppressAddress(ctx.pool, { address: 'x@test.example.com', reason: 'hard' });
      await suppressAddress(ctx.pool, { address: 'y@test.example.com', reason: 'complaint' });
      expect((await deliveryStats(ctx.pool, 30)).suppressed_addresses).toBe(2);

      expect(await releaseSuppression(ctx.pool, 'x@test.example.com', admin.id)).toBe(true);
      expect((await deliveryStats(ctx.pool, 30)).suppressed_addresses).toBe(1);
    });
  });
});
