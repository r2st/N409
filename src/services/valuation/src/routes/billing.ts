import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, logUnretried, problems } from '@n409/shared';
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
import { checkoutAvailableTo, isSettled, stripeProblem } from './payments.js';
import {
  billingSummary,
  cancelSubscription,
  findActiveSubscription,
  findInvoice,
  findInvoiceByStripeId,
  findPlan,
  findPlanByPrice,
  findPlanForSubscription,
  findStripeCustomerId,
  findSubscriptionByStripeCustomerId,
  findSubscriptionByStripeId,
  INVOICE_PAGE_LIMIT,
  listAllInvoices,
  listAllSubscriptions,
  listInvoicesForUser,
  listPlans,
  markSubscriptionPastDue,
  recordPaidInvoice,
  SUBSCRIPTION_PAGE_LIMIT,
  upsertSubscription,
} from '../repos/billing.js';
import { createNotifications } from '../repos/notifications.js';
import { listUserIdsWithRoles } from '../repos/users.js';
import { BILLING_ALERT_ROLES } from '../domain/roles.js';
import { parseStripeEvent, stripeEventKey } from '../domain/stripeEvents.js';
import { diffRecords, type AdminEventType } from '../domain/auditTrail.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import type { EventActor } from '../events/record.js';
import { classifyStripeEvent, recordStripeEvent } from '../repos/stripeEvents.js';
import {
  formatMoneyCents,
  invoiceLineItems,
  invoicePaidMessage,
  invoiceSections,
  localSubscriptionStatus,
  quotaAwaitsRenewal,
  subscriptionCanceledMessage,
  subscriptionPrice,
  trialEndingMessage,
  usageView,
  type InvoiceLineItem,
  type LocalSubscriptionStatus,
} from '../domain/billing.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { fitsInt4 } from '../domain/int4.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';

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
  /** Answers `{{support_email}}` in an ops-authored override of that copy. */
  settings?: SupportEmailSource;
}

/**
 * What a subscriber reads when this deployment cannot take a recurring card.
 *
 * Both sites here answered `Payments are not configured` — a statement about
 * our environment, addressed to somebody trying to buy a plan. The frontend
 * shows a problem's `detail` verbatim on this button (`ApiError.message`), so
 * that sentence was the whole of what the customer got: no remedy, and no
 * indication that a plan can still be arranged.
 *
 * Deliberately not the per-valuation flow's wording, which promises an invoice
 * for the engagement in front of them. A retainer is not a thing we can invoice
 * out of band on the strength of a button press, and the empty plan grid this
 * same screen falls back to has said "contact us and we'll set your account up
 * directly" since it was written. This is that sentence, on the path that gets
 * as far as pressing Subscribe.
 */
const PLANS_UNAVAILABLE_DETAIL =
  'Subscription plans cannot be started from here at the moment, and you have not been ' +
  'charged. Contact us and we will set the plan up on your account directly.';

/**
 * And when there is a plan but the portal behind "Manage subscription" cannot
 * open. Different situation, different sentence: the subscription is live and
 * unaffected, which is the fact that stops a customer assuming their plan has
 * broken along with the button.
 */
const PORTAL_UNAVAILABLE_DETAIL =
  'Subscription management is unavailable at the moment. Your plan and billing are unaffected — ' +
  'contact us to change a plan, update a card, or cancel, and we will do it for you.';

const billingUnavailable = (detail: string) =>
  new ApiProblem({
    status: 503,
    title: 'Billing not configured',
    type: 'urn:n409:problem:billing-unavailable',
    detail,
  });

/**
 * `plan_tier` was `z.string().min(1)` — any length, any bytes — which reached
 * a lookup and, since the refusal below names the tier back, a response body.
 * Bounded to what a catalogue key is: the seeded ones are `per_valuation` and
 * `annual_retainer` (migration 0080), and `plan_limits.tier` is the target of
 * a foreign key, not free text.
 */
const SubscribeBody = z.object({
  plan_tier: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'A plan tier is lower-case letters, digits, underscores and hyphens'),
});

/**
 * Stripe subscription status → local status, with a status nobody has
 * considered reported rather than absorbed.
 *
 * The mapping itself is `domain/billing.ts`, where the reading given to each of
 * Stripe's eight is written down — including the two that are served
 * indefinitely without anything being owed. See STRIPE_STATUS_MAP.
 */
function mapStatus(log: FastifyBaseLogger, stripe: string): LocalSubscriptionStatus {
  const { status, known } = localSubscriptionStatus(stripe);
  if (!known) {
    log.warn(
      { alert: true, actorType: 'system', source: 'stripe', stripeStatus: stripe, heldAs: status },
      'unrecognised Stripe subscription status — held as past_due, which is a served status',
    );
  }
  return status;
}

const tsToDate = (v: unknown): Date | null =>
  typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : null;

export function registerBillingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  /**
   * One row on the billing spine, subjected to the *account* rather than to the
   * subscription or the invoice.
   *
   * The question this feed is asked is "what happened to this customer's
   * billing", and `admin_events` is filterable by `subject_id`; a subscription
   * id as the subject would scatter one account's history across as many
   * subjects as it has ever held subscriptions, and an account that resubscribed
   * after lapsing has two. The subscription and invoice ids travel in the
   * payload, where they are still searchable and no longer split the timeline.
   */
  const audit = (args: {
    type: AdminEventType;
    actor: EventActor;
    userId: string | null;
    label?: string | null;
    payload?: Record<string, unknown>;
  }) =>
    recordAdminEvent(deps.pool, {
      type: args.type,
      actor: args.actor,
      subjectType: 'user',
      subjectId: args.userId,
      subjectLabel: args.label ?? null,
      payload: args.payload,
    });

  /**
   * {@link audit} for the two request-driven routes, where the outward action
   * has already happened by the time we get here.
   *
   * A Checkout Session or a portal session exists at Stripe before this runs,
   * and the caller is about to be redirected into it. Turning a failed audit
   * insert into a 500 would leave them staring at an error for a flow that
   * succeeded, so these two are contained the way `recordAdminEvent`'s contract
   * describes: fire-after-success, the mutation not held hostage. The webhook
   * paths below do the opposite on purpose — see the note there.
   */
  const auditRequest = async (log: FastifyBaseLogger, args: Parameters<typeof audit>[0]) => {
    try {
      await audit(args);
    } catch (err) {
      log.warn({ err, type: args.type }, 'billing audit event not recorded');
    }
  };

  /**
   * Stripe is not one of our principals, so a webhook-written row says so.
   * What keeps that from being a dead end is `stripe_event_id` on every such
   * payload plus the `checkout_started` / `billing_portal_opened` rows that
   * name the human who walked into Stripe in the first place.
   */
  const STRIPE_ACTOR: EventActor = { actorType: 'system', actorId: null, source: 'stripe' };

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
      throw billingUnavailable(PLANS_UNAVAILABLE_DETAIL);
    }
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid plan', parsed.error);

    const plan = await findPlan(deps.pool, parsed.data.plan_tier);
    if (!plan) {
      /*
       * A tier `findPlan` cannot see is one of two things and the sentence has
       * to cover both: a name that never existed — an API caller's typo — or,
       * more often, one that has just been retired from the catalogue, because
       * this filters `active`. The second is the case a subscriber actually
       * hits: the plan grid was drawn from `listPlans` and the tier came off a
       * card they were looking at when it was withdrawn.
       *
       * They read the bare 404, which is the reason phrase and nothing else:
       * "Not Found", on a button labelled Subscribe. Refreshing is the whole of
       * the remedy and it was the one thing the answer did not say.
       */
      throw problems.notFound(
        `There is no plan called “${parsed.data.plan_tier}” on sale. If it was on the page a moment ` +
          'ago it has just been withdrawn — reload the billing page for the current plans, or ' +
          'contact us and we will set the plan you wanted up directly.',
      );
    }
    if (plan.interval === 'one_time') {
      throw problems.unprocessable(
        'The per-valuation plan is not a subscription — it is charged when you start each ' +
          'valuation, so there is nothing to sign up for here. Start a valuation to be quoted ' +
          'for it, or choose one of the subscription plans instead.',
      );
    }
    if (await findActiveSubscription(deps.pool, principal.id)) {
      throw problems.conflict(
        'You already have an active subscription, so this would be a second one. ' +
          'To move to a different plan or change how you pay, open “Manage subscription” on the ' +
          'billing page (/billing) rather than subscribing again.',
      );
    }
    const user = await findUserById(deps.pool, principal.id);
    const base = deps.publicBaseUrl.replace(/\/$/, '');
    /**
     * The only one of the three Stripe routes with no catch at all.
     *
     * Every failure of this call — Stripe rejecting the parameters, Stripe
     * being down, our own deadline — came back as `500` with an empty body, on
     * the button that starts a paid subscription. The other two routes already
     * answered a rejection properly; this one answered nothing, so a subscriber
     * who could not start a plan had no way to tell a transient outage from a
     * misconfigured price and neither did support.
     */
    let session;
    try {
      session = await createSubscriptionCheckoutSession(deps.stripeSecretKey, {
        userId: principal.id,
        planTier: plan.tier,
        planName: plan.name,
        amountCents: plan.price_cents,
        currency: plan.currency,
        interval: plan.interval,
        /*
         * Both legs return to the billing page, which is where a subscription
         * is. They pointed at `/settings?billing=…` — a route that renders no
         * subscription card, no plan, no invoice list, and reads neither query
         * parameter. So a customer who had just committed to a recurring
         * charge was returned to their profile settings with nothing anywhere
         * on the page acknowledging it, and a customer who backed out of
         * Checkout landed in the same silence; the only way to see whether the
         * plan had started was to find `/billing` unaided.
         *
         * The one-time flow has had `/payment/success` and `/payment/cancel`
         * since it was written. This is the recurring flow's version of them.
         */
        successUrl: `${base}/billing?subscription=success`,
        cancelUrl: `${base}/billing?subscription=canceled`,
        customerEmail: user?.email,
      });
    } catch (err) {
      if (err instanceof StripeApiError) {
        req.log.warn({ err, unreachable: err.unreachable, planTier: plan.tier }, 'stripe subscribe failed');
        throw stripeProblem(err);
      }
      throw err;
    }
    // The human half of the pair. Everything Stripe says about this
    // subscription afterwards arrives as `system`/`stripe`, so this is the
    // only row that names who asked for the plan; the Checkout Session id is
    // what joins it to the `subscription_started` the webhook writes.
    await auditRequest(req.log, {
      type: 'checkout_started',
      actor: { actorType: 'human', actorId: principal.id },
      userId: principal.id,
      label: user?.email ?? null,
      payload: {
        plan_tier: plan.tier,
        amount_cents: plan.price_cents,
        currency: plan.currency,
        interval: plan.interval,
        checkout_session_id: session.id,
      },
    });
    return { checkout_url: session.url };
  });

  // The caller's current subscription, usage and invoices.
  app.get('/api/v1/me/subscription', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const sub = await findActiveSubscription(deps.pool, principal.id);
    // The plan this subscription is *on*, not the one still on sale. A tier
    // retired from the catalogue leaves its subscribers where they are, and
    // looking theirs up through `findPlan` — which filters `active = true` —
    // returned null, which `usageView` reads as *unlimited*. See
    // findPlanForSubscription.
    const plan = sub ? await findPlanForSubscription(deps.pool, sub.plan_tier) : null;
    const invoicePage = await listInvoicesForUser(deps.pool, principal.id);
    const usage = sub
      ? usageView({ valuation_limit: plan?.valuation_limit ?? null, valuations_used: sub.valuations_used })
      : null;
    return {
      subscription: sub,
      plan,
      usage,
      /**
       * Which period `usage` is counting, when it is not the one `subscription`
       * is showing.
       *
       * True only after a declined renewal, which moves the period and leaves
       * the counter on the last one paid for — so the two figures this payload
       * puts side by side are about different periods and the screen said so
       * nowhere. See `quotaAwaitsRenewal`.
       */
      quota_awaiting_renewal: sub ? quotaAwaitsRenewal(sub) : false,
      invoices: invoicePage.invoices,
      // A subscriber accrues an invoice a month, so this list is long for the
      // customers who have been here longest — exactly the ones most likely to
      // be looking for an old one.
      invoices_truncated: invoicePage.truncated,
      invoice_page_limit: INVOICE_PAGE_LIMIT,
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
    if (!deps.stripeSecretKey) throw billingUnavailable(PORTAL_UNAVAILABLE_DETAIL);

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
      // The portal is where a subscriber cancels, swaps plan or replaces a
      // card, and every one of those comes back to us as a webhook with no
      // principal on it. This row is the only place the person is named — the
      // `subscription_changed` an hour later can say what moved and never who
      // moved it.
      await auditRequest(req.log, {
        type: 'billing_portal_opened',
        actor: { actorType: 'human', actorId: principal.id },
        userId: principal.id,
        payload: { stripe_customer_id: customerId, portal_session_id: session.id },
      });
      return { portal_url: session.url };
    } catch (err) {
      if (err instanceof StripeApiError) {
        req.log.warn({ err, unreachable: err.unreachable }, 'stripe billing portal session failed');
        throw stripeProblem(err);
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
      throw invalidQuery(parsedQuery.error);
    }
    // The summary is its own query rather than a reduce over the two pages
    // below: capping what the screen lists must not move what the screen says.
    const [subscriptions, invoices, summary] = await Promise.all([
      listAllSubscriptions(deps.pool, { limit: parsedQuery.data.limit }),
      listAllInvoices(deps.pool, { limit: parsedQuery.data.invoice_limit }),
      billingSummary(deps.pool),
    ]);
    return {
      // The same flag `/me/subscription` carries, on the screen that is read to
      // decide who to chase: a past-due row's usage cell states the count for
      // the period that was last paid for, not the one the row is showing.
      subscriptions: subscriptions.subscriptions.map((sub) => ({
        ...sub,
        quota_awaiting_renewal: quotaAwaitsRenewal(sub),
      })),
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
    if (!invoice || (invoice.user_id !== principal.id && !isOps(principal))) {
      // One sentence for the missing invoice and for somebody else's, which is
      // what keeps the second from being distinguishable from the first — and
      // it is still a better answer than the reason phrase, on a link the
      // customer reached from their own invoice table.
      throw problems.notFound(
        'That invoice is not on your account. If you reached this from your billing page, reload ' +
          'it for the current list — and if the invoice is still missing, contact us with the ' +
          'invoice number and we will send you a copy.',
      );
    }
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
    currency: string,
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
          // The sentence below names the page; the notification centre could
          // not open it. Every engagement-scoped notification has carried a
          // link since it had a `valuation_id` to point at — an account-scoped
          // one had nowhere to point until migration 0188.
          link: '/billing',
          title: 'Your subscription payment did not go through',
          body:
            (amount
              ? `A payment of ${formatMoneyCents(amount, currency)} was declined. `
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
      logUnretried(log, err, { userId }, 'dunning notification failed');
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
          link: '/billing',
          title: message.subject,
          body: message.body.split('\n\n')[0]!,
        },
      ]);
      // Transactional, like the receipt on the engagement side: an invoice is
      // a financial record and does not consult the notification matrix.
      if (user?.email) {
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log, settings: deps.settings },
          {
            toUserId: inv.userId,
            toEmail: user.email,
            recipientName: user.first_name,
            templateKey: 'invoice_receipt',
            subject: message.subject,
            body: message.body,
            vars: message.vars,
          },
        );
      }
    } catch (err) {
      logUnretried(log, err, { invoice: inv.number }, 'invoice paid announcement failed');
    }
  }

  /**
   * Tell the subscriber their plan has ended.
   *
   * Contained like every other announcement on this path, and for the same
   * reason: the cancellation is committed by the time this runs, so letting an
   * exception out would 5xx the webhook and Stripe's redelivery would find the
   * row already cancelled, skip the block and never re-attempt the message.
   *
   * Called only where the write itself says this delivery is the one that ended
   * the subscription. Stripe sends `customer.subscription.updated` with
   * `status: 'canceled'` *and* `customer.subscription.deleted` for one
   * cancellation, in no guaranteed order, so gating on the status read back
   * would send two — and gating on only one of the two event types would send
   * none whenever the other landed first.
   */
  async function announceSubscriptionCanceled(
    log: FastifyBaseLogger,
    sub: { user_id: string; plan_tier: string; canceled_at: Date | null },
  ): Promise<void> {
    try {
      const [user, plan] = await Promise.all([
        findUserById(deps.pool, sub.user_id),
        findPlanForSubscription(deps.pool, sub.plan_tier),
      ]);
      const base = deps.publicBaseUrl.replace(/\/$/, '');
      const message = subscriptionCanceledMessage({
        // The plan a subscription was *on*, so a tier retired from the
        // catalogue is still named rather than leaving the sentence to read
        // "Your subscription has ended" twice over. See findPlanForSubscription.
        plan_name: plan?.name ?? 'subscription',
        ended_at: (sub.canceled_at ?? new Date()).toISOString(),
        billing_link: `${base}/billing`,
      });
      await createNotifications(deps.pool, [
        {
          userId: sub.user_id,
          type: 'subscription_canceled',
          link: '/billing',
          title: message.subject,
          body: message.body.split('\n\n')[0]!,
        },
      ]);
      if (user?.email) {
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log, settings: deps.settings },
          {
            toUserId: sub.user_id,
            toEmail: user.email,
            recipientName: user.first_name,
            templateKey: 'subscription_canceled',
            subject: message.subject,
            body: message.body,
            vars: message.vars,
          },
        );
      }
    } catch (err) {
      logUnretried(log, err, { userId: sub.user_id }, 'subscription cancellation announcement failed');
    }
  }

  /**
   * Tell the subscriber their trial is about to convert.
   *
   * Stripe fires `customer.subscription.trial_will_end` three days out, and the
   * transition it warns about is the one a customer is most likely to want to
   * act before: `trialing` is a served status here, so the trial ends either as
   * a card charge they were not expecting or — with no card on file — as the
   * quota silently stopping.
   *
   * Only for a subscription this platform actually carries and has not already
   * ended, and only once: Stripe sends this event once per trial, and a
   * redelivery of it is collapsed by the event ledger before the handler runs.
   *
   * Contained like the other announcements on this path: this writes nothing,
   * so a failure here must not become a 5xx that has Stripe redeliver an event
   * with no work left to do.
   */
  async function announceTrialEnding(
    log: FastifyBaseLogger,
    sub: { user_id: string; plan_tier: string },
    trialEndsAt: Date,
  ): Promise<void> {
    try {
      const [user, plan] = await Promise.all([
        findUserById(deps.pool, sub.user_id),
        findPlanForSubscription(deps.pool, sub.plan_tier),
      ]);
      // No plan row means no price to quote, and a trial-ending notice whose
      // whole job is to say what will be charged is worse than none.
      if (!plan) {
        log.warn({ userId: sub.user_id, planTier: sub.plan_tier }, 'trial ending: no plan to quote');
        return;
      }
      const base = deps.publicBaseUrl.replace(/\/$/, '');
      const message = trialEndingMessage({
        plan_name: plan.name,
        trial_ends_at: trialEndsAt.toISOString(),
        price_cents: plan.price_cents,
        currency: plan.currency,
        billing_link: `${base}/billing`,
      });
      await createNotifications(deps.pool, [
        {
          userId: sub.user_id,
          type: 'subscription_trial_ending',
          link: '/billing',
          title: message.subject,
          body: message.body.split('\n\n')[0]!,
        },
      ]);
      if (user?.email) {
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log, settings: deps.settings },
          {
            toUserId: sub.user_id,
            toEmail: user.email,
            recipientName: user.first_name,
            templateKey: 'subscription_trial_ending',
            subject: message.subject,
            body: message.body,
            vars: message.vars,
          },
        );
      }
    } catch (err) {
      logUnretried(log, err, { userId: sub.user_id }, 'trial ending announcement failed');
    }
  }

  /**
   * The one-live-subscription-per-user index refusing a second one.
   *
   * `subscriptions_one_active_per_user` (migration 0080) is a partial UNIQUE
   * over the served statuses, and it is what keeps quota accounting honest —
   * two live rows for one account is two limits, two usage counters and no
   * answer to which one `findActiveSubscription` should return.
   */
  const isSecondLiveSubscription = (err: unknown): boolean => {
    const e = err as { code?: string; constraint?: string } | null;
    return e?.code === '23505' && e?.constraint === 'subscriptions_one_active_per_user';
  };

  /**
   * Record a subscription, or report that this account already has one.
   *
   * Uncaught, that index violation was a bare 500 on the webhook — which to
   * Stripe is not an answer but a delivery to retry for three days, every
   * retry failing identically. Meanwhile the customer is being charged for a
   * subscription this platform holds no row for: no quota, no plan on the
   * Billing screen, and `invoice.paid` cannot find the subscription either, so
   * the renewals go unrecorded too.
   *
   * It is not a rare shape. `POST /billing/subscribe` guards on a read, so two
   * checkouts for different plans started before either completes both
   * succeed; a subscription added from the Stripe dashboard for an existing
   * subscriber does it; and the ordinary way is a customer in dunning who
   * believes their plan has lapsed — `past_due` is a served status, so their
   * old row still holds the slot — and subscribes again.
   *
   * Answered rather than retried. The conflicting row is ours, not the event's,
   * so redelivery cannot resolve it and would only replay the alert; and the
   * choice of which subscription survives is a refund decision somebody has to
   * make in Stripe. So the delivery is accepted, the ledger records it, and the
   * fact lands where it can be acted on: an `alert: true` line carrying the
   * Stripe subscription id, and a notification to the billing group.
   */
  async function alertSecondLiveSubscription(
    log: FastifyBaseLogger,
    userId: string,
    stripeSubscriptionId: string | null,
  ): Promise<void> {
    log.error(
      { alert: true, actorType: 'system', source: 'stripe', userId, stripeSubscriptionId },
      'account already holds a live subscription — the new one was not recorded',
    );
    try {
      const opsIds = await listUserIdsWithRoles(deps.pool, BILLING_ALERT_ROLES);
      if (opsIds.length === 0) return;
      await createNotifications(
        deps.pool,
        opsIds.map((opsId) => ({
          userId: opsId,
          type: 'subscription_conflict',
          title: 'An account started a second subscription',
          body:
            `Stripe subscription ${stripeSubscriptionId ?? '(unknown)'} could not be recorded — ` +
            'the account already has a live one. Both are being billed until one is cancelled in Stripe.',
        })),
      );
    } catch (err) {
      logUnretried(log, err, { userId }, 'second-subscription alert failed');
    }
  }

  /**
   * The audit row for one subscription write, decided by what the write says
   * it did rather than by which Stripe event carried it.
   *
   * Two events describe one new subscription (`checkout.session.completed` and
   * `customer.subscription.created`) and two describe one cancellation
   * (`customer.subscription.updated` with `status: 'canceled'`, and
   * `.deleted`), in no guaranteed order. Keying the row off the event type
   * would write "Subscription started" twice for one plan and
   * "Subscription cancelled" twice for one ending — so `inserted` and
   * `newly_canceled`, both derived inside the statement that moved the row,
   * are what choose the type here.
   *
   * A delivery that moved nothing writes nothing. Stripe re-sends
   * `customer.subscription.updated` for changes this platform does not carry —
   * a default payment method, an invoice setting — and a row per one of those
   * turns the billing trail into a feed nobody reads.
   *
   * Not contained: a failure here leaves the ledger row unwritten too, so the
   * 5xx this becomes is answered by a Stripe redelivery that runs the whole
   * handler again. The state writes are idempotent and the announcements are
   * gated on `newly_canceled` / `created`, so the retry re-attempts the audit
   * insert and nothing else. Swallowing it would be the one outcome that loses
   * the row for good.
   */
  const SUBSCRIPTION_AUDIT_COLUMNS = ['plan_tier', 'status', 'cancel_at_period_end'] as const;

  async function auditSubscriptionWrite(
    stripeEventId: string | null,
    written: Awaited<ReturnType<typeof upsertSubscription>>,
    before: { plan_tier: string; status: string; cancel_at_period_end: boolean } | null,
    /**
     * The Checkout Session this write came out of, on the one delivery that
     * knows it.
     *
     * The catalogue entry for these rows says `checkout_started` and the
     * webhook row it precedes are "the join between 'a person clicked Manage
     * subscription' and 'the plan changed an hour later'" — and the field that
     * would join them was written on one side only. `checkout_started` carries
     * `checkout_session_id`; `subscription_started` carried the Stripe event
     * id, the subscription id and the customer, none of which appear on the
     * request-side row. So the documented join was in fact "same user, roughly
     * the same minute", which is exactly the reasoning that fails on the
     * account that started two checkouts before either completed — the account
     * `alertSecondLiveSubscription` exists for.
     *
     * Only `checkout.session.completed` carries it. A `customer.subscription.*`
     * event names no session, and stamping the field null there would say the
     * subscription came from no checkout rather than from a delivery that
     * cannot see which.
     */
    checkoutSessionId?: string | null,
  ): Promise<void> {
    const common = {
      stripe_event_id: stripeEventId,
      subscription_id: written.id,
      stripe_subscription_id: written.stripe_subscription_id,
      ...(checkoutSessionId ? { checkout_session_id: checkoutSessionId } : {}),
    };
    if (written.newly_canceled) {
      await audit({
        type: 'subscription_canceled',
        actor: STRIPE_ACTOR,
        userId: written.user_id,
        payload: {
          ...common,
          plan_tier: written.plan_tier,
          canceled_at: written.canceled_at?.toISOString() ?? null,
        },
      });
      return;
    }
    if (written.inserted) {
      await audit({
        type: 'subscription_started',
        actor: STRIPE_ACTOR,
        userId: written.user_id,
        payload: {
          ...common,
          plan_tier: written.plan_tier,
          status: written.status,
          period_start: written.current_period_start?.toISOString() ?? null,
          period_end: written.current_period_end?.toISOString() ?? null,
        },
      });
      return;
    }
    if (!before) return;
    // `{ changes }` rather than a flat payload, because that is the shape
    // `extractChanges` reads: the activity log renders these as field-level
    // from/to rows without the billing surface needing a renderer of its own.
    const changes = diffRecords(
      before as unknown as Record<string, unknown>,
      written as unknown as Record<string, unknown>,
      SUBSCRIPTION_AUDIT_COLUMNS,
    );
    if (Object.keys(changes).length === 0) return;
    await audit({
      type: 'subscription_changed',
      actor: STRIPE_ACTOR,
      userId: written.user_id,
      payload: { ...common, changes },
    });
  }

  /** {@link upsertSubscription}, with the conflict above reported instead of thrown. */
  async function recordSubscription(
    log: FastifyBaseLogger,
    input: Parameters<typeof upsertSubscription>[1],
  ): Promise<Awaited<ReturnType<typeof upsertSubscription>> | null> {
    try {
      return await upsertSubscription(deps.pool, input);
    } catch (err) {
      if (!isSecondLiveSubscription(err)) throw err;
      await alertSecondLiveSubscription(log, input.userId, input.stripeSubscriptionId ?? null);
      return null;
    }
  }

  // ── Webhook (subscription lifecycle + invoices) ──────────────────────────
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/api/v1/billing/webhook', async (req, reply) => {
      if (!deps.stripeWebhookSecret) throw billingUnavailable('Billing webhooks are not configured.');
      const raw = req.body as Buffer;
      const header = req.headers['stripe-signature'];
      if (
        typeof header !== 'string' ||
        !Buffer.isBuffer(raw) ||
        !verifyWebhookSignature({ payload: raw, header, secret: deps.stripeWebhookSecret })
      ) {
        throw problems.badRequest('Invalid Stripe signature');
      }
      // Parsed, not cast — see domain/stripeEvents.ts. A body of `null` was a
      // TypeError here (`event.data` on nothing), and a NUL byte in the event
      // id or the object id was a 500 out of the ledger insert below, which to
      // Stripe is a delivery it retries for days rather than an answer.
      const envelope = parseStripeEvent(raw);
      if ('error' in envelope) throw problems.badRequest(envelope.error);
      const event = envelope.raw as { type?: string; data?: { object?: Record<string, unknown> } };
      const obj = envelope.object;
      const type = envelope.type;

      // Stripe delivers at least once and orders nothing. The handlers below
      // are each idempotent by their own means, which makes a replay harmless
      // where the handler's own state can tell — and says nothing about two
      // readings of one subscription arriving reversed, which is what its own
      // retry ladder produces. See migration 0155.
      const key = stripeEventKey(event, 'billing');
      // The id the Stripe dashboard indexes this delivery by, on every line
      // below rather than only on the 'stale' one — see the note on the
      // payments webhook for what its absence cost there. Bound as a child so
      // no path out of the handler can be the one that forgets it.
      const log = req.log.child({ stripeEventId: key.eventId, stripeEventType: key.type });
      const verdict = await classifyStripeEvent(deps.pool, key);
      if (verdict === 'duplicate') {
        // Same reason as the payments webhook: without this the redelivery is a
        // 200 in Stripe's dashboard and nothing at all on this side.
        log.info('stripe event already handled — duplicate delivery ignored');
        return reply.send({ received: true, duplicate: true });
      }
      if (verdict === 'stale') {
        log.info({ objectId: key.objectId }, 'stale Stripe event ignored');
        await recordStripeEvent(deps.pool, key, 'stale');
        return reply.send({ received: true, stale: true });
      }

      try {
        if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          const checkoutSessionId = typeof obj.id === 'string' ? obj.id : null;
          if (meta.user_id && meta.plan_tier) {
            const started = await recordSubscription(log, {
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
            if (started) {
              await auditSubscriptionWrite(key.eventId, started, null, checkoutSessionId);
              log.info(
                {
                  actorType: 'system',
                  source: 'stripe',
                  userId: started.user_id,
                  subscriptionId: started.id,
                  stripeSubscriptionId: started.stripe_subscription_id,
                  checkoutSessionId,
                  planTier: started.plan_tier,
                  status: started.status,
                  inserted: started.inserted,
                },
                'subscription checkout completed',
              );
            }
          } else {
            /**
             * A subscription checkout of ours that completed with nothing on it
             * to attribute.
             *
             * `createSubscriptionCheckoutSession` stamps `user_id` and
             * `plan_tier` into the session's metadata and into
             * `subscription_data.metadata`, so a session missing either is not
             * one this code opened — most often it is another integration's, on
             * a Stripe account that delivers every event to this endpoint, and
             * silence has always been right for those.
             *
             * The exception is the discriminator the payments webhook already
             * uses for a settled session with no payment row:
             * `client_reference_id` is set to the user's id on every session we
             * open, and no stranger's session carries a ULID of ours. When it
             * is there and the metadata is not, a subscriber has been put on a
             * recurring charge that this platform recorded nothing for — no
             * row, no quota, no plan on the Billing screen, and `invoice.paid`
             * will not find the subscription either, so the renewals go
             * unrecorded after it. That was dropped without a word.
             *
             * Acknowledged rather than 5xx'd, for the reason the unreconciled
             * settlement is: redelivery cannot put the metadata back, and a
             * retry loop for days would bury the one line worth reading.
             */
            const claimedUserId =
              typeof obj.client_reference_id === 'string' && isUlid(obj.client_reference_id)
                ? obj.client_reference_id
                : null;
            if (claimedUserId) {
              log.error(
                {
                  alert: true,
                  actorType: 'system',
                  source: 'stripe',
                  userId: claimedUserId,
                  checkoutSessionId,
                  stripeSubscriptionId: typeof obj.subscription === 'string' ? obj.subscription : null,
                  stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : null,
                  paymentStatus: typeof obj.payment_status === 'string' ? obj.payment_status : null,
                },
                'a subscription checkout of ours completed carrying no plan we could attribute — no subscription recorded',
              );
            }
          }
        } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          if (meta.user_id && meta.plan_tier && typeof obj.id === 'string') {
            /**
             * The tier Stripe is actually billing, not the one the metadata was
             * stamped with at checkout.
             *
             * A plan change in the hosted portal swaps the subscription's item
             * and leaves `metadata.plan_tier` alone, so writing the metadata
             * back is how an upgrade or a downgrade stayed invisible to
             * everything downstream of `subscriptions.plan_tier` — the quota
             * join, the Billing screen, the ops MRR. See `subscriptionPrice`.
             *
             * Falls back to the metadata when the item names no tier we can
             * identify, which is the pre-existing behaviour and the only
             * answer available. That fallback is *reported* when it disagrees
             * with the price being charged, because a subscription billing an
             * amount no catalogue row matches is a plan sold outside this
             * system and the quota it is being granted is a guess.
             */
            const priced = subscriptionPrice(obj);
            const billed = priced ? await findPlanByPrice(deps.pool, priced) : null;
            const planTier = billed?.tier ?? meta.plan_tier;
            if (billed && billed.tier !== meta.plan_tier) {
              log.info(
                { subscriptionId: obj.id, metadataTier: meta.plan_tier, billedTier: billed.tier },
                'subscription plan changed in Stripe — tier resolved from the billed price',
              );
            } else if (!billed && priced) {
              const stamped = await findPlanForSubscription(deps.pool, meta.plan_tier);
              if (
                stamped &&
                (stamped.price_cents !== priced.amount_cents ||
                  stamped.currency.toLowerCase() !== priced.currency ||
                  stamped.interval !== priced.interval)
              ) {
                log.warn(
                  {
                    alert: true,
                    actorType: 'system',
                    source: 'stripe',
                    subscriptionId: obj.id,
                    metadataTier: meta.plan_tier,
                    billedAmountCents: priced.amount_cents,
                    billedCurrency: priced.currency,
                    billedInterval: priced.interval,
                  },
                  'subscription bills a price no plan matches — quota is being granted from stale metadata',
                );
              }
            }
            // Read before the write, so the audit row can say what moved
            // rather than only where it landed. The `from` side is a read and
            // the upsert is a separate statement, so two concurrent deliveries
            // for one subscription can leave it one delivery behind — the
            // event ledger narrows that window rather than closing it. The
            // `to` side and `inserted` come from the write itself and are
            // exact; `stripe_event_id` names which delivery this was.
            const before = await findSubscriptionByStripeId(deps.pool, obj.id);
            const written = await recordSubscription(log, {
              userId: meta.user_id,
              planTier,
              status: mapStatus(log, String(obj.status ?? 'active')),
              stripeSubscriptionId: obj.id,
              stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : null,
              periodStart: tsToDate(obj.current_period_start),
              periodEnd: tsToDate(obj.current_period_end),
              // The subscription object is the only event that reports this, so
              // it is the only place it is read. A self-serve cancellation is
              // this flag going true and the status staying 'active' — see
              // migration 0187.
              cancelAtPeriodEnd:
                typeof obj.cancel_at_period_end === 'boolean' ? obj.cancel_at_period_end : undefined,
            });
            if (written) await auditSubscriptionWrite(key.eventId, written, before);
            /**
             * A renewal that granted the next period's quota, which nothing
             * said either.
             *
             * The reset lives inside `upsertSubscription`'s statement, gated on
             * the money as well as the date — `quota_period_start` moves, and
             * the counter goes back to zero, only on an event whose status says
             * a renewal cleared. That gate is subtle enough to have been got
             * wrong twice (see migration 0190), and its two failure modes are
             * invisible from outside: a grant that should not have happened
             * hands a free period, and a grant that never happens leaves a
             * paid-for period exhausted. Both are silent, and the second
             * surfaces only as the refusal logged in routes/valuations.ts —
             * with nothing to say whether the period it names was ever granted.
             *
             * Off the two rows rather than out of the SQL: the statement cannot
             * report what it replaced, and `before` is already read here for the
             * audit row's `from` side. A racing delivery can make this line
             * miss a grant it did not perform, which is the right way round for
             * something that reports rather than decides.
             */
            // By instant, not by reference: both sides are `Date` objects the
            // driver built separately, so `!==` is true for two readings of one
            // timestamp and this would have fired on every subscription update.
            const grantedAt = written?.quota_period_start?.getTime() ?? null;
            const grantedBefore = before?.quota_period_start?.getTime() ?? null;
            if (written && before && grantedAt !== grantedBefore) {
              log.info(
                {
                  actorType: 'system',
                  source: 'stripe',
                  userId: written.user_id,
                  subscriptionId: written.id,
                  stripeSubscriptionId: written.stripe_subscription_id,
                  planTier: written.plan_tier,
                  status: written.status,
                  quotaPeriodStart: written.quota_period_start?.toISOString() ?? null,
                  previousQuotaPeriodStart: before.quota_period_start?.toISOString() ?? null,
                  valuationsUsedBefore: before.valuations_used,
                },
                'plan quota granted for a new billing period',
              );
            }
            // The other writer of a cancellation, and the one that lands first
            // about as often as not.
            if (written?.newly_canceled) await announceSubscriptionCanceled(log, written);
          } else if (typeof obj.id === 'string') {
            /**
             * A subscription event about a subscription we do carry, arriving
             * with nothing on it that says whose or which plan.
             *
             * The guard above is the whole handler: no `user_id` and
             * `plan_tier` in the metadata and the delivery does nothing at all.
             * For a subscription this platform has never seen that is right and
             * always was — a shared Stripe account carries other integrations'
             * subscriptions, and an enterprise plan somebody added in the
             * dashboard is not ours to write.
             *
             * A subscription id we hold a row for is the other case, and it was
             * silent in exactly the same way. Our own sessions stamp
             * `subscription_data.metadata`, so the state that reaches here is a
             * subscription whose metadata was edited away in the Stripe
             * dashboard — after which *every* event about it is ignored: a
             * plan swap, a card recovered out of past_due, and a cancellation
             * that then reaches this platform only if the separate `.deleted`
             * delivery lands. The row sits at whatever status it last held and
             * keeps granting quota from it.
             *
             * Reported rather than guessed at. The row names the user and the
             * tier, so this handler could fill the metadata's job in — but
             * `plan_tier` off the row is the stale value that
             * `subscriptionPrice` above exists to stop being trusted, and
             * writing a status through on a guess is how an ended plan comes
             * back. A person putting the metadata back in Stripe is the fix,
             * and the redelivery that follows it lands normally.
             */
            const carried = await findSubscriptionByStripeId(deps.pool, obj.id);
            if (carried) {
              log.error(
                {
                  alert: true,
                  actorType: 'system',
                  source: 'stripe',
                  userId: carried.user_id,
                  subscriptionId: carried.id,
                  stripeSubscriptionId: obj.id,
                  stripeStatus: typeof obj.status === 'string' ? obj.status : null,
                  heldStatus: carried.status,
                  heldPlanTier: carried.plan_tier,
                },
                'a subscription we carry sent an update with no metadata to attribute it — nothing was written',
              );
            }
          }
        } else if (type === 'customer.subscription.trial_will_end' && typeof obj.id === 'string') {
          const sub = await findSubscriptionByStripeId(deps.pool, obj.id);
          const trialEnd = tsToDate(obj.trial_end);
          // A cancelled subscription's trial is not going to convert, and a
          // subscription id we do not carry is not our customer to write to.
          if (sub && sub.status !== 'canceled' && trialEnd) {
            /**
             * Nor is a trial the customer has already cancelled.
             *
             * A self-serve cancellation during a trial is `cancel_at_period_end`
             * going true with the status left at 'trialing' (see migration
             * 0187), and Stripe goes on firing `trial_will_end` for it — the
             * event is about the trial's date, not about whether the plan will
             * continue. The notice this sends says "unless you cancel before
             * then, the plan continues and you will be charged", and for this
             * subscriber both halves are false: they have cancelled, and no
             * charge is coming. Its whole content is a claim about a conversion
             * that is not going to happen.
             *
             * Silence is the right answer rather than a second wording, because
             * they are not left uninformed: Stripe confirmed the cancellation,
             * the Billing screen already reads "your plan ends on … and will
             * not renew" off the same flag, and `subscription_canceled` reaches
             * them when it does end.
             */
            if (sub.cancel_at_period_end) {
              log.info(
                { subscriptionId: obj.id, userId: sub.user_id },
                'trial ending on a cancelled subscription — no conversion notice sent',
              );
            } else {
              await announceTrialEnding(log, sub, trialEnd);
            }
          }
        } else if (type === 'customer.subscription.deleted' && typeof obj.id === 'string') {
          const ended = await cancelSubscription(deps.pool, obj.id);
          // Only the delivery that ended it, for the reason the announcement
          // is gated the same way: Stripe sends `customer.subscription.updated`
          // with `status: 'canceled'` *and* `customer.subscription.deleted` for
          // one cancellation, and a trail with two "Subscription cancelled"
          // rows for one cancellation is a trail that cannot be counted.
          if (ended?.newly_canceled) {
            await audit({
              type: 'subscription_canceled',
              actor: STRIPE_ACTOR,
              userId: ended.user_id,
              payload: {
                stripe_event_id: key.eventId,
                subscription_id: ended.id,
                stripe_subscription_id: ended.stripe_subscription_id,
                plan_tier: ended.plan_tier,
                canceled_at: ended.canceled_at?.toISOString() ?? null,
              },
            });
            await announceSubscriptionCanceled(log, ended);
          }
        } else if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
          const stripeSubId = typeof obj.subscription === 'string' ? obj.subscription : null;
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          let userId = typeof meta.user_id === 'string' ? meta.user_id : null;
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
          /**
           * The amount, checked before anything is written.
           *
           * `invoices.amount_cents` is an `integer` holding whole minor units,
           * and this was `Number(obj.amount_paid ?? obj.amount_due ?? 0)` fed
           * straight to it. A field that is not a whole number of cents — a
           * fraction, a string that does not parse, an object — became NaN or a
           * decimal that the driver refuses, which surfaced as a bare 500 out
           * of the insert. To Stripe a 500 is not an answer, it is a delivery
           * to retry for days; and every retry allocated another invoice number
           * on its way to the same failure. So one unstorable amount walked the
           * sequence forward indefinitely and was never reported to anyone.
           *
           * 400 instead: an amount this system cannot store is a permanent
           * property of the event, redelivery cannot fix it, and Stripe records
           * the refusal and stops. The log line is the one that says a payment
           * went unrecorded, which is the fact worth waking somebody for.
           *
           * `fitsInt4` rather than `Number.isInteger`, which is the range half
           * of the same sentence and was missing from it. 2147483648 is a whole
           * number of minor units and is still not storable — the driver
           * answers `22003 value out of range for type integer` — so the guard
           * written to end this exact loop passed the one amount that is both
           * well-formed and unstorable straight into it. See domain/int4.ts.
           */
          const rawAmount = obj.amount_paid ?? obj.amount_due ?? 0;
          const amount = typeof rawAmount === 'number' ? rawAmount : NaN;
          if (!fitsInt4(amount) || amount < 0) {
            log.error(
              { alert: true, actorType: 'system', source: 'stripe', stripeInvoiceId, amount: rawAmount },
              'stripe invoice carried an amount this system cannot store — not recorded',
            );
            throw problems.badRequest(
              'Invalid webhook payload: invoice amount is not a storable whole number of minor units',
            );
          }
          /**
           * And the account it belongs to.
           *
           * `meta.user_id` is whatever the event says. When the subscription
           * lookup above answers, that is the authority and this never applies;
           * when it does not — an invoice raised outside a subscription, or one
           * against a subscription this platform never recorded — the metadata
           * was written into `invoices.user_id` unchecked. That column is a
           * `ulid` with a foreign key to `users`, so a value in neither shape
           * was the same permanent 5xx-and-burn-a-number loop as the amount
           * above, on an event that is very often simply not ours: a webhook
           * endpoint receives every invoice on the Stripe account.
           *
           * Resolved to a real user or dropped. Dropping is the pre-existing
           * behaviour for an invoice with no user at all (`if (userId && …)`),
           * and it is the right one — there is no account to bill, so there is
           * nothing to record.
           */
          const owner = userId && isUlid(userId) ? await findUserById(deps.pool, userId) : null;
          userId = owner?.id ?? null;
          // Stripe delivers at least once, and sends both `invoice.paid` and
          // `invoice.payment_succeeded` for one payment. Reading first keeps a
          // sequential redelivery cheap; `recordPaidInvoice` is what makes the
          // concurrent one safe, by re-reading under a lock it holds through
          // the allocation and the insert.
          const already = await findInvoiceByStripeId(deps.pool, stripeInvoiceId);
          if (userId && !already) {
            const currency = String(obj.currency ?? 'usd');
            const periodStart = tsToDate(obj.period_start);
            const periodEnd = tsToDate(obj.period_end);
            // The invoice as Stripe itemised it, when the items add up to what
            // was charged. A mid-cycle plan change is prorated as a credit for
            // the plan left and a charge for the plan joined, and those two
            // lines are the customer's only explanation of the figure. See
            // `invoiceLineItems` for when it declines to itemise.
            const lineItems: InvoiceLineItem[] = invoiceLineItems(
              obj,
              amount,
              typeof obj.description === 'string' && obj.description.trim() !== ''
                ? obj.description.trim()
                : 'Subscription',
            );
            const { invoice: saved, created } = await recordPaidInvoice(deps.pool, {
              userId,
              subscriptionId,
              amountCents: amount,
              currency,
              periodStart,
              periodEnd,
              lineItems,
              stripeInvoiceId,
            });
            // Announced from the row that was actually stored, and only by the
            // delivery that stored it.
            //
            // The `!already` guard above is a read followed by a write with
            // nothing between them. Stripe sends both `invoice.paid` and
            // `invoice.payment_succeeded` for one payment, with different event
            // ids the ledger cannot collapse, and fans them out together — so
            // both deliveries routinely read `already` as null and both arrive
            // here. The announcement ran on both paths and quoted a locally
            // allocated number rather than the stored one, so the subscriber
            // got two receipts for one renewal, one of them naming an invoice
            // number that exists nowhere.
            //
            // `created` is the write itself saying which delivery wrote the
            // row — decided inside `recordPaidInvoice`'s transaction, under the
            // lock that also stops the loser allocating a number it will not
            // use. See that function for what the loser's allocation cost.
            if (created) {
              // Same gate as the announcement, and for the same reason: both
              // `invoice.paid` and `invoice.payment_succeeded` reach here for
              // one payment, and an audit trail that counts one renewal twice
              // is not a record of what was billed.
              await audit({
                type: 'invoice_paid',
                actor: STRIPE_ACTOR,
                userId: saved.user_id,
                payload: {
                  stripe_event_id: key.eventId,
                  invoice_id: saved.id,
                  invoice_number: saved.number,
                  stripe_invoice_id: stripeInvoiceId,
                  subscription_id: subscriptionId,
                  amount_cents: Number(saved.amount_cents),
                  currency: saved.currency,
                },
              });
              /*
               * And the renewal that went through, so the decline logged below
               * has a denominator.
               *
               * A settled renewal allocates a sequenced invoice number an
               * auditor reads as a count of what was billed, and it said
               * nothing here — while `invoice.payment_failed` now says a great
               * deal. A log carrying only the failures of a recurring charge
               * cannot answer the question anyone actually asks of it, which is
               * what share of renewals are failing.
               *
               * Behind `created`, which is the write itself saying which of the
               * two deliveries Stripe sends for one payment stored the row.
               */
              log.info(
                {
                  actorType: 'system',
                  source: 'stripe',
                  userId: saved.user_id,
                  subscriptionId,
                  stripeInvoiceId,
                  invoiceNumber: saved.number,
                  amountCents: Number(saved.amount_cents),
                  currency: saved.currency,
                },
                'subscription invoice settled',
              );
              await announceInvoicePaid(log, {
                userId: saved.user_id,
                number: saved.number,
                amountCents: Number(saved.amount_cents),
                currency: saved.currency,
                periodStart: saved.period_start,
                periodEnd: saved.period_end,
              });
            }
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
          const failedInvoiceId = typeof obj.id === 'string' ? obj.id : null;
          const amountDueCents = Number(obj.amount_due ?? 0);
          const failedCurrency = String(obj.currency ?? 'usd');
          if (stripeSubId) {
            const sub = await markSubscriptionPastDue(deps.pool, stripeSubId);
            // The invoice's own currency, not the platform's. The amount is
            // read off the Stripe event and the currency sits beside it on the
            // same object; passing 'usd' regardless rendered a declined €480
            // renewal as "$480.00" in the one message whose whole job is to
            // tell the subscriber which payment to go and fix.
            if (sub) {
              // Unconditional, unlike the subscription writes above: a second
              // declined renewal on an account that is already past due is a
              // second failed payment, not a repeat of the first, and the run
              // of them is what dunning is read for. The event ledger is what
              // stops one delivery being counted twice.
              await audit({
                type: 'subscription_payment_failed',
                actor: STRIPE_ACTOR,
                userId: sub.user_id,
                payload: {
                  stripe_event_id: key.eventId,
                  subscription_id: sub.id,
                  stripe_subscription_id: stripeSubId,
                  stripe_invoice_id: typeof obj.id === 'string' ? obj.id : null,
                  amount_due_cents: Number(obj.amount_due ?? 0),
                  currency: String(obj.currency ?? 'usd'),
                  status: sub.status,
                },
              });
              /**
               * And said out loud, which it was not.
               *
               * A declined renewal wrote an audit row and two notifications
               * and produced no log line at all — the function called
               * `alertPaymentFailed` logs only when the notification insert
               * *fails*. So the one billing transition that predicts churn was
               * legible in the trail and in the notification centre and
               * invisible to every log-side view of this service: no way to
               * count declines over a window, no way to see a run of them
               * against one account or one card BIN, and nothing to correlate
               * with the `evt_…` the Stripe dashboard is showing.
               *
               * `warn` and no `alert: true`, on the contract's own reasoning
               * rather than by feel. `logFailure` reserves the flag for a
               * failure no retry is coming for, and a declined renewal is the
               * opposite: Stripe's own dunning schedule re-attempts the
               * invoice for weeks, the subscriber has been told to fix the
               * card, the billing group has been told a renewal failed, and
               * the plan is still served throughout ('past_due' is a served
               * status). The permanent one is the branch below, which nobody
               * is retrying and nobody has been told about.
               *
               * Fields are the ones a reconciliation needs and the ones the
               * audit row carries, so the two read as one story: which
               * account, which subscription, which invoice, how much, and the
               * status the row now holds.
               */
              log.warn(
                {
                  actorType: 'system',
                  source: 'stripe',
                  userId: sub.user_id,
                  subscriptionId: sub.id,
                  stripeSubscriptionId: stripeSubId,
                  stripeInvoiceId: failedInvoiceId,
                  amountDueCents,
                  currency: failedCurrency,
                  status: sub.status,
                  attemptCount: typeof obj.attempt_count === 'number' ? obj.attempt_count : null,
                },
                'subscription renewal payment failed — account marked past due',
              );
              await alertPaymentFailed(log, sub.user_id, amountDueCents, failedCurrency);
            } else {
              /**
               * A declined renewal we hold no live subscription for.
               *
               * `markSubscriptionPastDue` answers null for two situations and
               * this branch did not exist for either: a subscription id we
               * carry no row for, and one whose row is already `canceled`. The
               * second is ordinary — Stripe raises a final invoice against a
               * subscription that has ended and it declines, and there is
               * nothing to mark past due. The first is not: a subscriber is
               * being billed for a plan this platform has no record of, so no
               * status moves, nobody is told, and the account keeps whatever
               * entitlement it has until Stripe gives up weeks later. That is
               * the shape `alertSecondLiveSubscription` exists for, arriving
               * through the money side instead.
               *
               * Told apart by the same discriminator `handleInvoiceRefund`
               * uses for a refund against an invoice that is not on file: a
               * webhook endpoint receives every event on the Stripe account,
               * so a failed invoice by itself says only that *somebody's*
               * renewal declined. A customer we hold a subscription for — in
               * any state, because the interesting case is precisely a row
               * that has drifted out of step — is our money; one we have never
               * seen is another integration's and stays silent, which is the
               * pre-existing behaviour for it.
               *
               * `alert: true` here and not above: no retry of ours is coming,
               * the customer has not been told (there is no user to tell), and
               * only a person reconciling this against Stripe can resolve it.
               */
              const known = await findSubscriptionByStripeId(deps.pool, stripeSubId);
              const customerId = typeof obj.customer === 'string' ? obj.customer : null;
              // Asked of the subscription id first, not of the customer: a
              // subscriber who resubscribed has two rows and the newest is not
              // the one this invoice is about, so reading the customer alone
              // would call an ordinary final invoice on a cancelled plan an
              // unreconciled one.
              const ours =
                !known && customerId ? await findSubscriptionByStripeCustomerId(deps.pool, customerId) : null;
              if (ours) {
                log.error(
                  {
                    alert: true,
                    actorType: 'system',
                    source: 'stripe',
                    userId: ours.user_id,
                    stripeSubscriptionId: stripeSubId,
                    stripeCustomerId: customerId,
                    stripeInvoiceId: failedInvoiceId,
                    amountDueCents,
                    currency: failedCurrency,
                  },
                  'a renewal failed for a subscriber of ours against a subscription we hold no row for — nothing marked past due',
                );
              } else {
                log.info(
                  {
                    stripeSubscriptionId: stripeSubId,
                    stripeInvoiceId: failedInvoiceId,
                    currency: failedCurrency,
                  },
                  'invoice payment failed for a subscription that is not live here — nothing to mark past due',
                );
              }
            }
          } else {
            log.info(
              { stripeInvoiceId: failedInvoiceId, currency: failedCurrency },
              'invoice payment failed outside a subscription — nothing to mark past due',
            );
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
        log.error({ err }, 'billing webhook handling failed — returning 5xx for redelivery');
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
