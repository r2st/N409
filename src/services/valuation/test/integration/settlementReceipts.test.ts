import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayment } from '../../src/repos/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * What the platform says when money arrives.
 *
 * Every other outcome already told somebody: a declined renewal notifies the
 * subscriber and the billing group, a refund and a chargeback alert ops, a
 * bounced bank debit alerts both. Settlement told nobody. The payment was
 * marked, the engagement flipped to paid, an invoice took a sequence number an
 * auditor reads as a count of what was billed — and the person charged heard
 * nothing from us at all.
 *
 * Both confirmations are transactional, so what is asserted here is the outbox
 * row: `sendTransactionalEmail` writes it before it hands anything to a
 * transport, and the retry ladder owns it from that point. The count matters as
 * much as the content — Stripe delivers at least once, and a receipt is a thing
 * a client reads as a second charge when it arrives twice.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_settlement_test';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

describe.skipIf(!dbUp)('settlement confirmations', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };

  const outboxFor = async (email: string, templateKey: string) => {
    const { rows } = await ctx.pool.query<{ subject: string; body: string; status: string }>(
      `SELECT subject, body, status FROM email_outbox
        WHERE lower(to_email) = lower($1) AND template_key = $2
        ORDER BY created_at ASC`,
      [email, templateKey],
    );
    return rows;
  };

  const notificationsOf = async (userId: string, type: string) => {
    const { rows } = await ctx.pool.query<{ title: string; body: string }>(
      'SELECT title, body FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at ASC',
      [userId, type],
    );
    return rows;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  // ── One-off engagement payments ────────────────────────────────────────────

  describe('engagement payment', () => {
    const createValuation = async (companyName: string): Promise<string> => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: companyName },
      });
      expect(res.statusCode).toBe(201);
      return res.json().valuation.id as string;
    };

    /** A pending checkout, ready for the webhook to settle. */
    const pendingCheckout = async (company: string, sessionId: string, express = false) => {
      const vid = await createValuation(company);
      await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId,
        amountCents: 119_000,
        currency: 'USD',
        createdBy: ops.id,
        express,
      });
      return vid;
    };

    const deliverCompleted = async (sessionId: string, eventId: string) => {
      const payload = JSON.stringify({
        id: eventId,
        type: 'checkout.session.completed',
        data: { object: { id: sessionId, payment_status: 'paid', amount_total: 119_000 } },
      });
      return ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(payload),
        payload,
      });
    };

    it('sends the payer a receipt naming the engagement and the amount', async () => {
      const vid = await pendingCheckout('Receipt Co', 'cs_receipt_1');
      expect((await deliverCompleted('cs_receipt_1', 'evt_receipt_1')).statusCode).toBe(200);

      const mail = await outboxFor(ops.email, 'payment_receipt');
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toContain('Receipt Co');
      expect(mail[0]!.body).toContain('$1,190.00');
      // The itemisation is an authenticated page, not an attachment: a PDF
      // mailed to whatever address is on the account outlives our control of it.
      expect(mail[0]!.body).toContain(`/valuations/${vid}`);

      const notes = await notificationsOf(ops.id, 'payment_received');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.title).toContain('Receipt Co');
    });

    it('does not send a second receipt when Stripe redelivers the event', async () => {
      await pendingCheckout('Replay Co', 'cs_replay_1');
      await deliverCompleted('cs_replay_1', 'evt_replay_1');
      // Same event again — the ordinary retry-ladder redelivery.
      expect((await deliverCompleted('cs_replay_1', 'evt_replay_1')).statusCode).toBe(200);
      // And a *different* event id for the same settled session, which the
      // duplicate ledger cannot answer. What stops this one is the
      // compare-and-set on the payment row, which has already left `pending`.
      expect((await deliverCompleted('cs_replay_1', 'evt_replay_2')).statusCode).toBe(200);

      const mail = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_outbox
          WHERE lower(to_email) = lower($1) AND template_key = 'payment_receipt'
            AND subject LIKE '%Replay Co%'`,
        [ops.email],
      );
      expect(mail.rows[0]!.n).toBe(1);
    });

    it('states express delivery only when it was bought', async () => {
      await pendingCheckout('Plain Co', 'cs_plain_1', false);
      await deliverCompleted('cs_plain_1', 'evt_plain_1');
      await pendingCheckout('Express Co', 'cs_express_1', true);
      await deliverCompleted('cs_express_1', 'evt_express_1');

      const mail = await outboxFor(ops.email, 'payment_receipt');
      const plain = mail.find((m) => m.subject.includes('Plain Co'));
      const express = mail.find((m) => m.subject.includes('Express Co'));
      expect(plain?.body).not.toContain('Express');
      expect(express?.body).toContain('Express');
    });

    it('receipts a second charge on an engagement that was already paid', async () => {
      // The engagement crosses the payment gate once; the money can arrive more
      // than once. An add-on bought after the fact is still a charge, and the
      // announcement hangs off the settled payment rather than off the gate.
      const vid = await pendingCheckout('Addon Co', 'cs_addon_1');
      await deliverCompleted('cs_addon_1', 'evt_addon_1');
      await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_addon_2',
        amountCents: 50_000,
        currency: 'USD',
        createdBy: ops.id,
      });
      await deliverCompleted('cs_addon_2', 'evt_addon_2');

      const mail = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_outbox
          WHERE lower(to_email) = lower($1) AND template_key = 'payment_receipt'
            AND subject LIKE '%Addon Co%'`,
        [ops.email],
      );
      expect(mail.rows[0]!.n).toBe(2);
    });
  });

  // ── Subscription invoices ──────────────────────────────────────────────────

  describe('subscription invoice', () => {
    const deliverInvoicePaid = async (args: {
      eventId: string;
      invoiceId: string;
      userId: string;
      amountPaid?: number;
    }) => {
      const payload = JSON.stringify({
        id: args.eventId,
        type: 'invoice.paid',
        data: {
          object: {
            id: args.invoiceId,
            amount_paid: args.amountPaid ?? 9_900,
            currency: 'usd',
            description: 'Growth plan',
            period_start: Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000),
            period_end: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000),
            metadata: { user_id: args.userId },
          },
        },
      });
      return ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: signedHeaders(payload),
        payload,
      });
    };

    it('confirms the invoice it just numbered, to the subscriber it billed', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await deliverInvoicePaid({
        eventId: 'evt_inv_1',
        invoiceId: 'in_settle_1',
        userId: user.id,
      });
      expect(res.statusCode).toBe(200);

      const { rows: invoices } = await ctx.pool.query<{ number: string }>(
        'SELECT number FROM invoices WHERE stripe_invoice_id = $1',
        ['in_settle_1'],
      );
      expect(invoices).toHaveLength(1);

      const mail = await outboxFor(user.email, 'invoice_receipt');
      expect(mail).toHaveLength(1);
      // The number in the message is the number that was allocated, not one
      // rendered from a second reading of the sequence.
      expect(mail[0]!.subject).toContain(invoices[0]!.number);
      expect(mail[0]!.body).toContain('$99.00');
      expect(mail[0]!.body).toContain('2026-08-01 to 2026-09-01');

      const notes = await notificationsOf(user.id, 'invoice_paid');
      expect(notes).toHaveLength(1);
    });

    it('does not confirm the same invoice twice', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await deliverInvoicePaid({ eventId: 'evt_inv_2', invoiceId: 'in_settle_2', userId: user.id });
      // A fresh event id for an invoice already recorded — `invoice.paid` and
      // `invoice.payment_succeeded` are both emitted for one payment, so this
      // is the normal case rather than a retry.
      const again = await deliverInvoicePaid({
        eventId: 'evt_inv_3',
        invoiceId: 'in_settle_2',
        userId: user.id,
      });
      expect(again.statusCode).toBe(200);

      expect(await outboxFor(user.email, 'invoice_receipt')).toHaveLength(1);
      expect(await notificationsOf(user.id, 'invoice_paid')).toHaveLength(1);
    });
  });
});
