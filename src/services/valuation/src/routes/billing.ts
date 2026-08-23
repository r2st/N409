import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, problems } from '@n409/shared';
import { renderReportPdf } from '../clients/reportRender.js';
import { isOps } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { findUserById } from '../repos/users.js';
import {
  createBillingPortalSession,
  createSubscriptionCheckoutSession,
  StripeApiError,
  verifyWebhookSignature,
} from '../payments/stripe.js';
import { checkoutAvailableTo, isSettled } from './payments.js';
import {
  billingSummary,
  cancelSubscription,
  createInvoice,
  findActiveSubscription,
  findInvoice,
  findInvoiceByStripeId,
  findPlan,
  findStripeCustomerId,
  INVOICE_PAGE_LIMIT,
  listAllInvoices,
  listAllSubscriptions,
  listInvoicesForUser,
  listPlans,
  markSubscriptionPastDue,
  nextInvoiceSequence,
  SUBSCRIPTION_PAGE_LIMIT,
  upsertSubscription,
} from '../repos/billing.js';
import { createNotifications } from '../repos/notifications.js';
import { listUserIdsWithRoles } from '../repos/users.js';
import { BILLING_ALERT_ROLES } from '../domain/roles.js';
import { stripeEventKey } from '../domain/stripeEvents.js';
import { classifyStripeEvent, recordStripeEvent } from '../repos/stripeEvents.js';
import {
  formatMoneyCents,
  invoiceNumber,
  invoicePaidMessage,
  invoicePeriod,
  invoiceSections,
  usageView,
  type InvoiceLineItem,
} from '../domain/billing.js';

/**
 * Subscription / retainer billing (feature 7). Recurring Stripe Checkout for
 * the retainer/enterprise tiers, usage-vs-limit tracking, generated invoices,
 * and an ops billing dashboard. The one-time per-valuation flow stays in
 * routes/payments.ts; this covers everything recurring.
 */

export interface BillingDeps {
  pool: pg.Pool;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  publicBaseUrl: string;
  /** A settled invoice is confirmed to the subscriber who paid it. */
  transport?: EmailTransport;
}

const billingUnavailable = (detail: string) =>
  new ApiProblem({
    status: 503,
    title: 'Billing not configured',
    type: 'urn:n409:problem:billing-unavailable',
    detail,
  });

const SubscribeBody = z.object({ plan_tier: z.string().min(1) });

/** Stripe subscription status → local status. */
function mapStatus(stripe: string): 'active' | 'trialing' | 'past_due' | 'canceled' {
  if (stripe === 'trialing') return 'trialing';
  if (stripe === 'active') return 'active';
  if (stripe === 'canceled' || stripe === 'incomplete_expired') return 'canceled';
  return 'past_due'; // past_due, unpaid, incomplete
}

const tsToDate = (v: unknown): Date | null =>
  typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : null;

export function registerBillingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  app.get('/api/v1/billing/plans', { preHandler: app.authenticate }, async (req) => ({
    plans: await listPlans(deps.pool),
    // Per-caller for the reason `checkoutAvailableTo` documents: a test key
    // opens a Checkout page that declines every card a subscriber owns. A
    // recurring plan is the worse of the two flows to get this wrong on — the
    // one-off is a failed payment, this is a subscription that never starts.
    configured: checkoutAvailableTo(deps.stripeSecretKey, requirePrincipal(req)),
  }));

  // Start a recurring subscription checkout for a retainer/enterprise plan.
  app.post('/api/v1/billing/subscribe', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!checkoutAvailableTo(deps.stripeSecretKey, principal)) {
      throw billingUnavailable('Payments are not configured');
    }
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid plan', { errors: parsed.error.issues });

    const plan = await findPlan(deps.pool, parsed.data.plan_tier);
    if (!plan) throw problems.notFound();
    if (plan.interval === 'one_time') {
      throw problems.unprocessable('The per-valuation plan is billed per valuation, not by subscription');
    }
    if (await findActiveSubscription(deps.pool, principal.id)) {
      throw problems.conflict('You already have an active subscription');
    }
    const user = await findUserById(deps.pool, principal.id);
    const base = deps.publicBaseUrl.replace(/\/$/, '');
    const session = await createSubscriptionCheckoutSession(deps.stripeSecretKey, {
      userId: principal.id,
      planTier: plan.tier,
      planName: plan.name,
      amountCents: plan.price_cents,
      currency: plan.currency,
      interval: plan.interval,
      successUrl: `${base}/settings?billing=success`,
      cancelUrl: `${base}/settings?billing=canceled`,
      customerEmail: user?.email,
    });
    return { checkout_url: session.url };
  });

  // The caller's current subscription, usage and invoices.
  app.get('/api/v1/me/subscription', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const sub = await findActiveSubscription(deps.pool, principal.id);
    const plan = sub ? await findPlan(deps.pool, sub.plan_tier) : null;
    const usage = sub
      ? usageView({ valuation_limit: plan?.valuation_limit ?? null, valuations_used: sub.valuations_used })
      : null;
    return {
      subscription: sub,
      plan,
      usage,
      invoices: await listInvoicesForUser(deps.pool, principal.id),
      // Drives the "Manage subscription" control: a customer record has to
      // exist before the portal has anything to open.
      portal_available:
        Boolean(deps.stripeSecretKey) && (await findStripeCustomerId(deps.pool, principal.id)) !== null,
    };
  });

  /**
   * Self-serve subscription management — cancel, change plan, update the card,
   * download past invoices — as a redirect into Stripe's hosted portal.
   *
   * Until this existed, `cancelSubscription` was only ever reached from a
   * Stripe-side event: there was no way for a subscriber to cancel from the
   * product at all, and a customer whose card expired had no way to fix it and
   * simply lapsed. Both are churn we caused. Handing the flow to Stripe also
   * keeps card details out of this service entirely.
   *
   * Always the caller's own customer id, never one supplied by the request —
   * a portal session for someone else's customer is their card and their
   * invoice history.
   */
  app.post('/api/v1/billing/portal', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!deps.stripeSecretKey) throw billingUnavailable('Payments are not configured');

    const customerId = await findStripeCustomerId(deps.pool, principal.id);
    if (!customerId) {
      throw problems.conflict('There is no billing account to manage yet — subscribe to a plan first.');
    }
    const base = deps.publicBaseUrl.replace(/\/$/, '');
    try {
      const session = await createBillingPortalSession(deps.stripeSecretKey, {
        customerId,
        returnUrl: `${base}/billing`,
      });
      return { portal_url: session.url };
    } catch (err) {
      if (err instanceof StripeApiError) {
        req.log.warn({ err }, 'stripe billing portal session failed');
        throw new ApiProblem({
          status: 502,
          title: 'Bad Gateway',
          type: 'urn:n409:problem:stripe',
          detail: `Stripe: ${err.message}`,
        });
      }
      throw err;
    }
  });

  // ── Admin billing dashboard ──────────────────────────────────────────────
  app.get('/api/v1/admin/billing', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Billing dashboard is operations-only');
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(SUBSCRIPTION_PAGE_LIMIT).default(SUBSCRIPTION_PAGE_LIMIT),
        invoice_limit: z.coerce.number().int().min(1).max(INVOICE_PAGE_LIMIT).default(INVOICE_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw problems.badRequest('Invalid query', { errors: parsedQuery.error.issues });
    }
    // The summary is its own query rather than a reduce over the two pages
    // below: capping what the screen lists must not move what the screen says.
    const [subscriptions, invoices, summary] = await Promise.all([
      listAllSubscriptions(deps.pool, { limit: parsedQuery.data.limit }),
      listAllInvoices(deps.pool, { limit: parsedQuery.data.invoice_limit }),
      billingSummary(deps.pool),
    ]);
    return {
      subscriptions: subscriptions.subscriptions,
      subscriptions_truncated: subscriptions.truncated,
      invoices: invoices.invoices,
      invoices_truncated: invoices.truncated,
      page_limit: SUBSCRIPTION_PAGE_LIMIT,
      invoice_page_limit: INVOICE_PAGE_LIMIT,
      summary,
    };
  });

  // Invoice PDF (feature 7). Owner or ops.
  app.get('/api/v1/billing/invoices/:id/pdf', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const invoice = await findInvoice(deps.pool, id);
    if (!invoice || (invoice.user_id !== principal.id && !isOps(principal))) throw problems.notFound();
    const user = await findUserById(deps.pool, invoice.user_id);

    const pdf = await renderReportPdf({
      title: `Invoice ${invoice.number}`,
      company_name: user?.company_name ?? user?.email ?? 'Customer',
      meta: [
        { label: 'Invoice', value: invoice.number },
        { label: 'Status', value: invoice.status },
        { label: 'Issued', value: new Date(invoice.issued_at).toISOString().slice(0, 10) },
      ],
      sections: invoiceSections({
        number: invoice.number,
        amount_cents: invoice.amount_cents,
        currency: invoice.currency,
        status: invoice.status,
        issued_at: new Date(invoice.issued_at).toISOString(),
        period_start: invoice.period_start ? new Date(invoice.period_start).toISOString() : null,
        period_end: invoice.period_end ? new Date(invoice.period_end).toISOString() : null,
        line_items: invoice.line_items,
        bill_to: { name: user?.company_name ?? user?.first_name ?? 'Customer', email: user?.email ?? '' },
        refunded_cents: Number(invoice.refunded_cents ?? 0),
      }),
    });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${invoice.number}.pdf"`)
      .send(pdf);
  });

  /**
   * Tells the subscriber their renewal failed, and the billing admins that an
   * account is at risk. Best-effort: a notification failure must not turn into
   * the 5xx that makes Stripe redeliver an event we already acted on.
   */
  async function alertPaymentFailed(
    log: FastifyBaseLogger,
    userId: string,
    amountDueCents: number,
  ): Promise<void> {
    try {
      const amount = Number.isFinite(amountDueCents) && amountDueCents > 0 ? amountDueCents : 0;
      const opsIds = await listUserIdsWithRoles(deps.pool, BILLING_ALERT_ROLES);
      // One insert for the subscriber and the whole billing-admin group. The
      // subscriber's notification is first, and stays a distinct row with its
      // own wording — they need to update a card, ops need to know a renewal
      // failed.
      await createNotifications(deps.pool, [
        {
          userId,
          type: 'subscription_payment_failed',
          title: 'Your subscription payment did not go through',
          body:
            (amount
              ? `A payment of ${formatMoneyCents(amount, 'usd')} was declined. `
              : 'A payment was declined. ') +
            'Update your card from the billing page to keep your plan active.',
        },
        ...opsIds.map((opsId) => ({
          userId: opsId,
          type: 'subscription_payment_failed',
          title: 'A subscription renewal failed',
          body: 'A subscriber’s payment was declined and the account is now past due.',
        })),
      ]);
    } catch (err) {
      log.warn({ err, userId }, 'dunning notification failed');
    }
  }

  /**
   * Confirm a settled subscription invoice to the subscriber.
   *
   * The counterpart of `alertPaymentFailed` above, which existed first. A
   * failed renewal has told the subscriber and the billing group since
   * dunning was added; a successful one told nobody, though it is the event
   * that allocates a sequenced invoice number — a numbering an auditor reads
   * as a count of what was billed, generated and then never mentioned to the
   * person billed.
   *
   * Ops are not copied: a renewal going through is the expected case and the
   * billing rollup already counts it.
   *
   * Contained like every other announcement on this path. The invoice row is
   * committed by the time this runs, so letting an exception out would 5xx the
   * webhook and Stripe's redelivery would find `already` set, skip the block
   * and never re-attempt the message.
   */
  async function announceInvoicePaid(
    log: FastifyBaseLogger,
    inv: {
      userId: string;
      number: string;
      amountCents: number;
      currency: string;
      periodStart: Date | null;
      periodEnd: Date | null;
    },
  ): Promise<void> {
    try {
      const user = await findUserById(deps.pool, inv.userId);
      const base = deps.publicBaseUrl.replace(/\/$/, '');
      const message = invoicePaidMessage({
        number: inv.number,
        amount_cents: inv.amountCents,
        currency: inv.currency,
        period_start: inv.periodStart ? inv.periodStart.toISOString() : null,
        period_end: inv.periodEnd ? inv.periodEnd.toISOString() : null,
        invoice_link: `${base}/billing`,
      });
      await createNotifications(deps.pool, [
        {
          userId: inv.userId,
          type: 'invoice_paid',
          title: message.subject,
          body: message.body.split('\n\n')[0]!,
        },
      ]);
      // Transactional, like the receipt on the engagement side: an invoice is
      // a financial record and does not consult the notification matrix.
      if (user?.email) {
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log },
          {
            toUserId: inv.userId,
            toEmail: user.email,
            templateKey: 'invoice_receipt',
            subject: message.subject,
            body: message.body,
            vars: message.vars,
          },
        );
      }
    } catch (err) {
      log.warn({ err, invoice: inv.number }, 'invoice paid announcement failed');
    }
  }

  // ── Webhook (subscription lifecycle + invoices) ──────────────────────────
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/api/v1/billing/webhook', async (req, reply) => {
      if (!deps.stripeWebhookSecret) throw billingUnavailable('Webhook not configured');
      const raw = req.body as Buffer;
      const header = req.headers['stripe-signature'];
      if (
        typeof header !== 'string' ||
        !Buffer.isBuffer(raw) ||
        !verifyWebhookSignature({ payload: raw, header, secret: deps.stripeWebhookSecret })
      ) {
        throw problems.badRequest('Invalid Stripe signature');
      }
      let event: { type?: string; data?: { object?: Record<string, unknown> } };
      try {
        event = JSON.parse(raw.toString('utf8')) as typeof event;
      } catch {
        throw problems.badRequest('Invalid webhook payload');
      }
      const obj = event.data?.object ?? {};
      const type = event.type ?? '';

      // Stripe delivers at least once and orders nothing. The handlers below
      // are each idempotent by their own means, which makes a replay harmless
      // where the handler's own state can tell — and says nothing about two
      // readings of one subscription arriving reversed, which is what its own
      // retry ladder produces. See migration 0155.
      const key = stripeEventKey(event, 'billing');
      const verdict = await classifyStripeEvent(deps.pool, key);
      if (verdict === 'duplicate') return reply.send({ received: true, duplicate: true });
      if (verdict === 'stale') {
        req.log.info({ type, eventId: key.eventId, objectId: key.objectId }, 'stale Stripe event ignored');
        await recordStripeEvent(deps.pool, key, 'stale');
        return reply.send({ received: true, stale: true });
      }

      try {
        if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          if (meta.user_id && meta.plan_tier) {
            await upsertSubscription(deps.pool, {
              userId: meta.user_id,
              planTier: meta.plan_tier,
              // Not unconditionally 'active'. A subscription started with a
              // delayed-notification method completes its Checkout Session with
              // `payment_status: 'unpaid'` and a Stripe subscription that is
              // `incomplete`, so calling it active here hands over the plan's
              // valuation quota before the first debit has cleared. 'past_due'
              // is the status mapStatus already gives `incomplete`, and
              // `customer.subscription.updated` promotes it the moment Stripe
              // says the money landed. See isSettled in routes/payments.ts.
              status: isSettled(obj.payment_status) ? 'active' : 'past_due',
              stripeSubscriptionId: typeof obj.subscription === 'string' ? obj.subscription : null,
              stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : null,
            });
          }
        } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          if (meta.user_id && meta.plan_tier && typeof obj.id === 'string') {
            await upsertSubscription(deps.pool, {
              userId: meta.user_id,
              planTier: meta.plan_tier,
              status: mapStatus(String(obj.status ?? 'active')),
              stripeSubscriptionId: obj.id,
              stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : null,
              periodStart: tsToDate(obj.current_period_start),
              periodEnd: tsToDate(obj.current_period_end),
            });
          }
        } else if (type === 'customer.subscription.deleted' && typeof obj.id === 'string') {
          await cancelSubscription(deps.pool, obj.id);
        } else if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
          const stripeSubId = typeof obj.subscription === 'string' ? obj.subscription : null;
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          let userId = meta.user_id ?? null;
          let subscriptionId: string | null = null;
          if (stripeSubId) {
            const { rows } = await deps.pool.query<{ id: string; user_id: string }>(
              'SELECT id, user_id FROM subscriptions WHERE stripe_subscription_id = $1',
              [stripeSubId],
            );
            if (rows[0]) {
              subscriptionId = rows[0].id;
              userId = rows[0].user_id;
            }
          }
          const stripeInvoiceId = typeof obj.id === 'string' ? obj.id : null;
          // Stripe delivers at least once. Checking first means a redelivery
          // costs nothing instead of allocating a sequence number it then
          // discards on the ON CONFLICT — which would leave a gap in a
          // numbering an auditor reads as a count of what was billed.
          const already = await findInvoiceByStripeId(deps.pool, stripeInvoiceId);
          if (userId && !already) {
            const issuedIso = new Date().toISOString();
            const seq = await nextInvoiceSequence(deps.pool, invoicePeriod(issuedIso));
            const amount = Number(obj.amount_paid ?? obj.amount_due ?? 0);
            const number = invoiceNumber(issuedIso, seq);
            const currency = String(obj.currency ?? 'usd');
            const periodStart = tsToDate(obj.period_start);
            const periodEnd = tsToDate(obj.period_end);
            const lineItems: InvoiceLineItem[] = [
              { description: String(obj.description ?? 'Subscription'), amount_cents: amount },
            ];
            await createInvoice(deps.pool, {
              number,
              userId,
              subscriptionId,
              amountCents: amount,
              currency,
              status: 'paid',
              periodStart,
              periodEnd,
              lineItems,
              stripeInvoiceId,
              paidAt: new Date(),
            });
            // Inside the `!already` guard, which is what makes this send once:
            // a redelivered `invoice.paid` finds the row and skips the whole
            // block, and the ledger classifies the ordinary replay before that.
            await announceInvoicePaid(req.log, {
              userId,
              number,
              amountCents: amount,
              currency,
              periodStart,
              periodEnd,
            });
          }
        } else if (type === 'invoice.payment_failed') {
          // Dunning. A renewal that does not go through is the single most
          // common way a paying customer stops paying, and it is almost always
          // an expired card rather than a decision — which makes it recoverable
          // if anyone is told. Nothing handled this event before, so the
          // subscription drifted to past_due (or not even that, for a
          // subscription carrying no metadata) and the first sign of trouble
          // was Stripe cancelling it weeks later.
          const stripeSubId = typeof obj.subscription === 'string' ? obj.subscription : null;
          if (stripeSubId) {
            const sub = await markSubscriptionPastDue(deps.pool, stripeSubId);
            if (sub) await alertPaymentFailed(req.log, sub.user_id, Number(obj.amount_due ?? 0));
          }
        }
      } catch (err) {
        // Log here for the type context, then let it out as a 5xx.
        //
        // This used to answer 200 on any failure, reasoning that a retry storm
        // was worse than a dropped event. It has the trade backwards: Stripe
        // treats 200 as "handled" and never redelivers, so a transient DB blip
        // — the one failure that would certainly have succeeded on a retry —
        // became permanent, silent loss of a paid invoice, with a log line
        // nobody reads as the only trace. That is how the invoice-numbering
        // collision stayed invisible for as long as it did.
        //
        // Stripe's redelivery is the recovery mechanism for exactly this, and
        // it backs off rather than hammering. Handlers above are idempotent
        // (findInvoiceByStripeId, ON CONFLICT, upsert), so a redelivery of an
        // event that partly landed is safe. A genuinely permanent failure now
        // ends up visible in the Stripe dashboard instead of only in our logs.
        req.log.error({ err, type }, 'billing webhook handling failed — returning 5xx for redelivery');
        throw err;
      }
      // Only after the handlers have run: an event that threw leaves no ledger
      // row, so the redelivery the 5xx above asks for is not answered as a
      // duplicate.
      await recordStripeEvent(deps.pool, key);
      return reply.send({ received: true });
    });
  });
}
