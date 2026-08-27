import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { renderReportPdf } from '../clients/reportRender.js';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { formatMoneyCents, paymentReceivedMessage, receiptSections } from '../domain/billing.js';
import {
  addonFlags,
  EXPRESS_DELIVERY_DAYS,
  priceForKind as priceForKindImpl,
  quoteLines,
  quotePrice as quotePriceImpl,
  type AddonSelection,
} from '../domain/pricing.js';
import { findValuationById, patchValuation, type ValuationRow } from '../repos/valuations.js';
import {
  createPayment,
  findLiveCheckout,
  findPaymentByChargeOrIntent,
  BILLING_PAYMENT_PAGE_LIMIT,
  findPaymentBySessionId,
  findPaymentForValuation,
  listPayments,
  listPaymentsForScope,
  listUnpaidValuationsForScope,
  markPayment,
  recordDispute,
  recordRefund,
  setPaymentReceipt,
  type PaymentRow,
} from '../repos/payments.js';
import { valuationScope } from '../auth/rbac.js';
import {
  createCheckoutSession,
  expireCheckoutSession,
  retrieveReceipt,
  stripeKeyMode,
  StripeApiError,
  verifyWebhookSignature,
} from '../payments/stripe.js';
import { requirePrincipal } from '../plugins/auth.js';
import { collectedTotals, disputeStatusOf, refundState, type DisputeStatus } from '../domain/payments.js';
import { createNotifications } from '../repos/notifications.js';
import { recordInvoiceRefund } from '../repos/billing.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import { onStateChanged, type EmailTransport, type SupportEmailSource } from '../hooks/stateChange.js';
import { findUserById, listUserIdsWithRoles } from '../repos/users.js';
import { BILLING_ALERT_ROLES } from '../domain/roles.js';
import { parseStripeEvent, stripeEventKey } from '../domain/stripeEvents.js';
import { classifyStripeEvent, recordStripeEvent } from '../repos/stripeEvents.js';

/**
 * Stripe payment processing (remaining-gaps §3 #1 / §6 P0 #2).
 *
 * Checkout: the client (or ops on their behalf) opens a Stripe-hosted page;
 * we persist a pending `payments` row keyed by the session id. Webhook:
 * `checkout.session.completed` flips the row and the valuation's paid fields
 * — the webhook is the source of truth, never the browser redirect.
 */

/**
 * Prices live in domain/pricing.ts, which the public calculator reads too.
 * Re-exported here because every caller and test in the service already knows
 * this module as the place the number comes from.
 */
export {
  DEFAULT_PRICE_CENTS,
  FALLBACK_PRICE_CENTS,
  priceForKind,
  quotePrice,
  RAISE_BANDS,
} from '../domain/pricing.js';
import { invalidBody } from '../domain/validationProblem.js';

const paymentsUnavailable = (detail: string) =>
  new ApiProblem({
    status: 503,
    title: 'Service Unavailable',
    type: 'urn:n409:problem:payments-unconfigured',
    detail,
  });

const stripeUpstream = (detail: string) =>
  new ApiProblem({
    status: 502,
    title: 'Bad Gateway',
    type: 'urn:n409:problem:stripe',
    detail,
  });

/**
 * The client-facing answer for a failed Stripe call, whichever way it failed.
 *
 * Two failures wearing one error type, and they owe the reader different
 * sentences. A rejection carries Stripe's own wording and that wording is the
 * useful part — "Your card was declined", "No such customer" — so it is passed
 * through. An unreachable Stripe carries ours, because the transport's message
 * names a hostname and a syscall; what the person clicking "Pay" needs from it
 * is the one fact the message does not contain, which is that no money moved.
 *
 * Both are 502 `urn:n409:problem:stripe`. The status is the same because the
 * caller's options are the same — wait and try again — and because a status
 * split here would put a second thing in the contract to get wrong. What the
 * body distinguishes is what the person does next, and that is the `detail`.
 *
 * Exported so `routes/billing.ts` answers subscriptions and the billing portal
 * the same way; three routes had three different answers, and one of them had
 * none at all.
 */
export function stripeProblem(err: StripeApiError): ApiProblem {
  if (err.unreachable) {
    return stripeUpstream(
      'Stripe could not be reached, so the payment was not started. Nothing has been charged — try again in a moment.',
    );
  }
  return stripeUpstream(`Stripe: ${err.message}`);
}

/**
 * Does this Checkout Session's `payment_status` mean the money is in?
 *
 * `paid` and `no_payment_required` (a 100%-discounted session) are settled;
 * `unpaid` is a delayed-notification method that has not cleared yet. Anything
 * else — including the field being absent — is treated as settled, because the
 * only sessions that report `unpaid` are the ones Stripe follows up on with an
 * async event, and withholding a paid-for report on an unrecognised value would
 * be the more damaging way to guess wrong.
 */
export function isSettled(paymentStatus: unknown): boolean {
  return paymentStatus !== 'unpaid';
}

/**
 * Whether this deployment's Stripe key may take a *client's* money.
 *
 * A test key is fully functional — it opens a real Checkout page and settles
 * real-looking sessions — which is exactly the problem. It accepts `4242…` and
 * declines every card a client actually holds, and neither end says why: the
 * client sees a card decline they will blame on their bank, and our records
 * show a session that expired. So a test key counts as configured for ops, who
 * are the people deliberately exercising the pipeline end to end, and counts as
 * *unconfigured* for everyone else, who then get the honest invoice fallback
 * that a deployment with no key at all gives them.
 *
 * `unknown` (a key in neither Stripe shape) is treated as live. A malformed
 * key fails loudly at the API call, which is a better outcome than silently
 * withholding checkout from every client because a prefix was unrecognised.
 */
export function checkoutAvailableTo(
  secretKey: string | undefined,
  principal: Principal,
): secretKey is string {
  if (!secretKey) return false;
  return stripeKeyMode(secretKey) !== 'test' || isOps(principal);
}

/**
 * Whether this engagement may still be charged for.
 *
 * A retired engagement may not. `listUnpaidValuationsForScope` already stopped
 * offering one on the billing page — "this list is not a report, it is a demand
 * for money with a button beside it" — but the button itself was never gated,
 * and the demand can be reached without the list: the engagement's own page
 * still loads (`findValuationById` is deliberately id-addressable, so ops can
 * work a retired file), so its pay panel rendered, quoted a price, and opened a
 * live Stripe Checkout Session. A client with that page open when the sweep ran,
 * or with the URL bookmarked, could pay real money for work the firm has
 * withdrawn — and getting it back is a refund somebody has to notice and issue
 * by hand.
 *
 * The receipt and history routes deliberately do *not* apply this. Those are
 * records of money that really moved, and it did not stop moving because the
 * engagement was later retired.
 */
export function payableEngagement(valuation: Pick<ValuationRow, 'archived_at' | 'paid_status'>): boolean {
  return valuation.archived_at === null && valuation.paid_status === 'unpaid';
}

const CheckoutBody = z
  .object({
    // Ops-only override; clients always pay list price.
    amount_cents: z.number().int().positive().max(10_000_000).optional(),
    // Add-ons the client picked. Priced by domain/pricing.ts, never by the
    // browser — the amount is recomputed here from the flags, so a tampered
    // total cannot buy express delivery for nothing.
    express: z.boolean().optional(),
    qsbs_letter: z.boolean().optional(),
  })
  .default({});

export interface PaymentDeps {
  pool: pg.Pool;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  publicBaseUrl: string;
  /** Answers `{{support_email}}` when a state-change template is re-rendered. */
  settings?: SupportEmailSource;
  /** Settlement can move the workflow, and a state change sends mail. */
  transport?: EmailTransport;
}

async function loadAuthorized(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  ) {
    throw problems.notFound();
  }
  return valuation;
}

export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentDeps): void {
  app.post(
    '/api/v1/valuations/:id/payments/checkout',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id } = req.params as { id: string };
      const valuation = await loadAuthorized(deps.pool, principal, id);

      // Ahead of the Stripe-configuration checks: whether this engagement can
      // be charged for is a fact about the engagement, and answering "payments
      // are not configured" to someone trying to pay for a retired file would
      // send them back to try again tomorrow.
      if (valuation.archived_at !== null) {
        throw problems.conflict('This engagement has been retired and can no longer be paid for.');
      }

      if (!deps.stripeSecretKey) {
        throw paymentsUnavailable('Payments are not configured (STRIPE_SECRET_KEY unset)');
      }
      if (!checkoutAvailableTo(deps.stripeSecretKey, principal)) {
        // Same problem type and status as an unset key, deliberately: to a
        // client the two situations are the same situation — we cannot take
        // their card today — and the pay panel already renders that one
        // sentence. A separate code would only give the browser a new branch
        // to get wrong, and the fact worth recording is in the log line.
        req.log.warn(
          { valuation_id: valuation.id },
          'checkout refused: Stripe is in test mode and the caller is not ops',
        );
        throw paymentsUnavailable('Payments are not configured (Stripe is in test mode)');
      }
      if (valuation.paid_status !== 'unpaid') {
        throw problems.conflict(`Valuation is already ${valuation.paid_status}`);
      }

      const parsed = CheckoutBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw invalidBody('Invalid checkout', parsed.error);
      }
      // The quote is computed from the flags on every checkout, never taken
      // from the client. `amount_cents` remains an ops-only override and now
      // replaces the *total*: an ops-agreed price is a negotiated figure, and
      // adding a band uplift on top of one would silently overcharge.
      const quote = quotePriceImpl({
        kind: valuation.kind,
        amountRaisedCents: valuation.amount_raised_cents,
        addons: parsed.data as AddonSelection,
      });
      const override = isOps(principal) ? parsed.data.amount_cents : undefined;
      const amountCents = override ?? quote.amount_cents;
      const flags = addonFlags(quote);

      /*
       * At most one live Checkout Session per engagement.
       *
       * A Session URL stays payable for 24 hours, and this route used to mint a
       * fresh one on every POST. A client who double-clicked Pay, opened the
       * engagement in two tabs, or came back to a tab left open that morning
       * therefore held two live ways to be charged for one piece of work —
       * and the duplicate is close to invisible on this side. The second
       * webhook finds the valuation already paid and leaves it alone, so all
       * that survives is a second charge on the client's statement with nothing
       * here to reconcile it against.
       *
       * Identical quote: hand back the session we already opened. Reopening
       * that URL is exactly what a client returning to an abandoned checkout is
       * trying to do, and if they have in fact already paid it, Stripe's own
       * page says so rather than taking the money twice.
       *
       * Different quote — they ticked express since — the old session must not
       * stay payable at the old price, so it is expired at Stripe first. A
       * refusal there is not "already gone": the likeliest reason is that the
       * session has just been *completed*, which is a settlement whose webhook
       * is in flight. Opening a second session on top of that is precisely the
       * double charge, so the caller is turned away and asked to try again once
       * the payment in progress has landed.
       */
      const live = await findLiveCheckout(deps.pool, valuation.id);
      if (live) {
        const sameQuote =
          Number(live.amount_cents) === amountCents &&
          live.express === flags.express &&
          live.qsbs_letter === flags.qsbs_letter;
        if (sameQuote) {
          return reply.status(200).send({ payment: live, checkout_url: live.checkout_url, quote });
        }
        const closed = await expireCheckoutSession(deps.stripeSecretKey, live.session_id).catch(() => false);
        if (!closed) {
          req.log.warn(
            { valuationId: valuation.id, sessionId: live.session_id },
            'stripe refused to expire the open checkout session — refusing to open a second one',
          );
          throw problems.conflict(
            'A payment for this engagement is already in progress. Finish it, or try again in a few minutes.',
          );
        }
        await markPayment(deps.pool, live.id, 'expired', { from: ['pending'] });
      }

      const base = deps.publicBaseUrl.replace(/\/$/, '');
      let session;
      try {
        session = await createCheckoutSession(deps.stripeSecretKey, {
          valuationId: valuation.id,
          productName:
            `${valuation.kind.toUpperCase()} valuation — ${valuation.company_name}` +
            (quote.addons.length > 0 ? ` (${quote.addons.map((a) => a.label).join(', ')})` : ''),
          amountCents,
          currency: valuation.currency || 'USD',
          successUrl: `${base}/payment/success?valuation=${valuation.id}`,
          cancelUrl: `${base}/payment/cancel?valuation=${valuation.id}`,
        });
      } catch (err) {
        if (err instanceof StripeApiError) {
          req.log.warn({ err, unreachable: err.unreachable }, 'stripe checkout session failed');
          throw stripeProblem(err);
        }
        throw err;
      }

      const payment = await createPayment(deps.pool, {
        valuationId: valuation.id,
        sessionId: session.id,
        amountCents,
        currency: valuation.currency || 'USD',
        checkoutUrl: session.url,
        createdBy: principal.id,
        express: flags.express,
        qsbsLetter: flags.qsbs_letter,
        // An ops override replaces the total, so the itemisation it came from
        // would not add up to what was charged. Recording the override as its
        // own single line keeps the breakdown honest about that.
        priceBreakdown:
          override === undefined
            ? quoteLines(quote)
            : [{ key: 'agreed', label: 'Agreed price', amount_cents: override }],
      });
      return reply.status(201).send({ payment, checkout_url: session.url, quote });
    },
  );

  app.get('/api/v1/valuations/:id/payments', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorized(deps.pool, principal, id);
    return { ...(await listPayments(deps.pool, id)), page_limit: BILLING_PAYMENT_PAGE_LIMIT };
  });

  /**
   * The receipt for a settled engagement payment, itemised.
   *
   * Only a succeeded payment has one. A pending checkout is an intention and a
   * failed one is nothing at all, and issuing a document headed "Receipt" for
   * either is how a client comes to believe they have paid.
   */
  app.get(
    '/api/v1/valuations/:id/payments/:paymentId/receipt.pdf',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, paymentId } = req.params as { id: string; paymentId: string };
      const valuation = await loadAuthorized(deps.pool, principal, id);
      if (!isUlid(paymentId)) throw problems.notFound();
      const payment = await findPaymentForValuation(deps.pool, id, paymentId);
      if (!payment) throw problems.notFound();
      if (payment.status !== 'succeeded') {
        throw problems.conflict('No receipt: this payment has not settled.');
      }

      const pdf = await renderReportPdf({
        title: `Receipt ${valuation.number}`,
        company_name: valuation.company_name,
        meta: [
          { label: 'Receipt', value: valuation.number },
          { label: 'Status', value: payment.dispute_status ? 'disputed' : 'paid' },
          { label: 'Paid', value: new Date(payment.updated_at).toISOString().slice(0, 10) },
        ],
        sections: receiptSections({
          reference: valuation.number,
          company_name: valuation.company_name,
          amount_cents: Number(payment.amount_cents),
          currency: payment.currency,
          paid_at: new Date(payment.updated_at).toISOString(),
          lines: (payment.price_breakdown ?? []).map((l) => ({
            description: l.label,
            amount_cents: l.amount_cents,
          })),
          refunded_cents: Number(payment.refunded_cents ?? 0),
          dispute_status: payment.dispute_status,
          express: payment.express,
        }),
      });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="receipt-${valuation.number}.pdf"`)
        .send(pdf);
    },
  );

  /**
   * Price transparency: what "Pay now" will charge, before opening Stripe.
   *
   * Add-ons come in as query flags so the pay screen can re-quote as the
   * client ticks the boxes without creating anything. The same
   * `quotePrice` call backs this and the checkout, so the figure shown is by
   * construction the figure charged — the two cannot disagree.
   */
  app.get('/api/v1/valuations/:id/payments/quote', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(deps.pool, principal, id);
    const q = req.query as Record<string, unknown>;
    const flag = (name: string) => q[name] === 'true' || q[name] === '1' || q[name] === true;
    const quote = quotePriceImpl({
      kind: valuation.kind,
      amountRaisedCents: valuation.amount_raised_cents,
      addons: { express: flag('express'), qsbs_letter: flag('qsbs_letter') },
    });
    return {
      quote: {
        ...quote,
        lines: quoteLines(quote),
        currency: valuation.currency || 'USD',
        // false → the UI shows the invoice-fallback messaging up front. It is
        // per-caller rather than per-deployment because a test key is usable
        // by ops and not by a client; the checkout applies the same predicate,
        // so the panel never offers a button the POST would refuse.
        configured: checkoutAvailableTo(deps.stripeSecretKey, principal),
        // The other half of that invariant, and about this engagement rather
        // than this deployment: a retired or already-settled one is quoted —
        // the price is a fact, and ops reading a closed file should see it —
        // but not offered. Folding it into `configured` would have the panel
        // say "we will invoice you instead" about work nobody is going to
        // invoice for.
        payable: payableEngagement(valuation),
        // Sent only when it is true and only to the caller who can act on it.
        // An ops user about to click "Pay now" against a test key needs to know
        // no money will move; a client is never shown the button at all, and
        // telling them which Stripe account this deployment holds would be
        // internal detail leaking onto a payment screen.
        ...(isOps(principal) && stripeKeyMode(deps.stripeSecretKey) === 'test' ? { test_mode: true } : {}),
      },
    };
  });

  // Account-level billing rollup (P2 #13): every payment across the caller's
  // accessible valuations — client: own, partner: org, ops: all — plus the
  // unpaid engagements the page turns into a pay-now call-to-action.
  app.get('/api/v1/me/billing', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const scope = valuationScope(principal);
    const [{ payments, truncated: paymentsTruncated }, { unpaid, truncated: unpaidTruncated }] =
      await Promise.all([
        listPaymentsForScope(deps.pool, scope),
        listUnpaidValuationsForScope(deps.pool, scope),
      ]);
    return {
      billing: {
        payments,
        // Both caps are reported rather than assumed unreachable, because the
        // page derives figures from these rows and not only rows from them —
        // see `collectedTotals` below and BILLING_PAYMENT_PAGE_LIMIT.
        payments_truncated: paymentsTruncated,
        unpaid_truncated: unpaidTruncated,
        // Quoted at the band, so the pay-now call-to-action shows the price
        // the checkout will actually open with rather than the entry price.
        unpaid_valuations: unpaid.map((v) => ({
          ...v,
          amount_cents: quotePriceImpl({ kind: v.kind, amountRaisedCents: v.amount_raised_cents })
            .amount_cents,
          base_cents: priceForKindImpl(v.kind),
        })),
        // Net of refunds and lost chargebacks. Summing the 'succeeded' rows
        // gross, as this did, told a refunded client they had paid us money
        // their own card statement says came back.
        totals: collectedTotals(payments),
      },
    };
  });

  /**
   * Tells the people who can act about money that came back.
   *
   * The engagement owner, because their report is no longer paid for and they
   * are the one who has to decide whether to pay again; and the billing-admin
   * group, because a chargeback runs against a Stripe response deadline and a
   * refund needs reconciling. Best-effort by design — a notification failure
   * must never turn into a 5xx that makes Stripe redeliver a refund we have
   * already recorded.
   */
  async function alertBilling(
    log: FastifyBaseLogger,
    args: { valuationId: string; ownerId: string | null; type: string; title: string; body: string },
  ): Promise<void> {
    try {
      const opsIds = await listUserIdsWithRoles(deps.pool, BILLING_ALERT_ROLES);
      const recipients = new Set([...(args.ownerId ? [args.ownerId] : []), ...opsIds]);
      // One insert, not one per recipient. This runs inside a Stripe webhook
      // handler working against a redelivery deadline, and the recipient list
      // is a role lookup that grows with the billing team.
      await createNotifications(
        deps.pool,
        [...recipients].map((userId) => ({
          userId,
          valuationId: args.valuationId,
          type: args.type,
          title: args.title,
          body: args.body,
        })),
      );
    } catch (err) {
      log.warn({ err, valuationId: args.valuationId }, 'billing alert notification failed');
    }
  }

  /**
   * Takes a valuation's paid status back after money was returned in full.
   *
   * Straight to 'unpaid' rather than a new 'refunded' status: 'unpaid' is what
   * the whole system already reads — the unpaid work queue, the billing page's
   * pay-now call to action, the ops filter — and a client who charged back and
   * still wants the report should be able to buy it again. The forensic detail
   * (how much came back, when, and whether it was a refund or a lost dispute)
   * lives on the payments row, and patchValuation writes the transition into
   * the audit trail attributed to Stripe rather than to a person.
   */
  async function revokePaidStatus(
    log: FastifyBaseLogger,
    payment: PaymentRow,
    reason: string,
  ): Promise<void> {
    const valuation = await findValuationById(deps.pool, payment.valuation_id);
    if (!valuation) return;
    if (valuation.paid_status === 'paid') {
      await patchValuation(
        deps.pool,
        valuation,
        { paid_status: 'unpaid', paid_at: null },
        { actorType: 'system', source: 'stripe' },
      );
    }
    await alertBilling(log, {
      valuationId: valuation.id,
      ownerId: valuation.user_id,
      type: 'payment_reversed',
      title: `Payment reversed — ${valuation.company_name}`,
      body:
        `${reason} The ${valuation.kind.toUpperCase()} valuation for ${valuation.company_name} ` +
        `is marked unpaid again.`,
    });
  }

  /**
   * Tell the payer their money arrived.
   *
   * Ops are deliberately not copied. A successful charge is the expected case
   * and the billing group has the rollup; the reversals alert them because
   * those need somebody to act.
   *
   * Wrapped whole, like `alertBilling` above and for a sharper reason. This
   * runs after the compare-and-set in `fulfill` has already claimed the row, so
   * the settlement is committed: an exception escaping here would 5xx the
   * webhook, and Stripe's redelivery would find the payment no longer
   * `pending`, take the `!claimed` early return, and never reach this code
   * again. The announcement would be lost by the retry that exists to save it.
   * Once `sendTransactionalEmail` has written the outbox row the retry ladder
   * owns delivery, so the only thing this can swallow is the enqueue itself.
   */
  async function announcePaymentReceived(
    log: FastifyBaseLogger,
    payment: PaymentRow,
    valuation: ValuationRow,
  ): Promise<void> {
    try {
      const owner = await findUserById(deps.pool, valuation.user_id);
      const base = deps.publicBaseUrl.replace(/\/$/, '');
      const message = paymentReceivedMessage({
        reference: String(valuation.number),
        company_name: valuation.company_name,
        kind: valuation.kind,
        amount_cents: Number(payment.amount_cents),
        currency: payment.currency,
        express: payment.express,
        receipt_link: `${base}/valuations/${valuation.id}`,
      });
      await createNotifications(deps.pool, [
        {
          userId: valuation.user_id,
          valuationId: valuation.id,
          type: 'payment_received',
          title: message.subject,
          body: message.body.split('\n\n')[0]!,
        },
      ]);
      // A receipt is a financial record, not a preference: it goes through the
      // transactional path, which ignores the notification matrix and the
      // marketing opt-out, exactly like the invitation and the password reset.
      if (owner?.email) {
        await sendTransactionalEmail(
          { pool: deps.pool, transport: deps.transport, log },
          {
            toUserId: valuation.user_id,
            toEmail: owner.email,
            templateKey: 'payment_receipt',
            subject: message.subject,
            body: message.body,
            vars: message.vars,
          },
        );
      }
    } catch (err) {
      log.warn({ err, paymentId: payment.id }, 'payment receipt announcement failed');
    }
  }

  /**
   * The subscription half of `charge.refunded`.
   *
   * Reached only when the charge matches no engagement payment, which is what a
   * subscription charge looks like from here. Stripe puts the invoice id on the
   * charge, so the invoice is found the same way the payment would have been.
   *
   * A refund does not move a Stripe invoice's status — it stays `paid` and the
   * money comes back off the charge — so this records an amount rather than a
   * state, and `recordInvoiceRefund` is idempotent by assignment for the same
   * reason the payment path is: `amount_refunded` is a running total, so a
   * redelivery writes the number that is already there.
   *
   * The subscriber is told, and ops with it. A renewal refund is usually ours
   * to explain — a proration, a goodwill credit, a plan corrected after the
   * fact — and the client's own card statement will show it either way; the
   * damaging version is the one where it shows there and nowhere here.
   */
  async function handleInvoiceRefund(
    log: FastifyBaseLogger,
    charge: Record<string, unknown>,
  ): Promise<{ received: boolean; ignored?: string; refunded?: boolean }> {
    const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : null;
    if (!invoiceId) return { received: true, ignored: 'unknown charge' };
    const refundedCents = Number(charge.amount_refunded ?? 0);
    if (!Number.isFinite(refundedCents) || refundedCents <= 0) {
      return { received: true, ignored: 'no refunded amount' };
    }
    const invoice = await recordInvoiceRefund(deps.pool, invoiceId, refundedCents);
    // Null means the invoice is unknown to us, or the figure is not news. Both
    // are ordinary — a Stripe account can carry invoices this platform never
    // created — and neither is worth an alert.
    if (!invoice) return { received: true, ignored: 'unknown or already-recorded invoice' };

    const amount = formatMoneyCents(
      Math.min(Number(invoice.refunded_cents), Number(invoice.amount_cents)),
      invoice.currency,
    );
    const full = Number(invoice.refunded_cents) >= Number(invoice.amount_cents);
    try {
      const opsIds = await listUserIdsWithRoles(deps.pool, BILLING_ALERT_ROLES);
      await createNotifications(deps.pool, [
        {
          userId: invoice.user_id,
          type: 'invoice_refunded',
          title: `Refund issued — invoice ${invoice.number}`,
          body:
            `${amount} has been refunded against invoice ${invoice.number}. ` +
            'It will appear on your statement in a few business days.',
        },
        ...opsIds
          .filter((id) => id !== invoice.user_id)
          .map((userId) => ({
            userId,
            type: 'invoice_refunded',
            title: `${full ? 'Full' : 'Partial'} refund — invoice ${invoice.number}`,
            body: `${amount} was refunded against a subscription invoice.`,
          })),
      ]);
    } catch (err) {
      log.warn({ err, invoice: invoice.number }, 'invoice refund notification failed');
    }
    return { received: true, refunded: full };
  }

  /**
   * `charge.refunded` — the charge object carries the running total refunded,
   * so this is idempotent by assignment. A partial refund is recorded but does
   * not revoke: the client still bought the report and still holds it.
   */
  async function handleRefund(
    log: FastifyBaseLogger,
    charge: Record<string, unknown>,
  ): Promise<{ received: boolean; ignored?: string; refunded?: boolean }> {
    const payment = await findPaymentByChargeOrIntent(deps.pool, {
      chargeId: typeof charge.id === 'string' ? charge.id : null,
      paymentIntentId: typeof charge.payment_intent === 'string' ? charge.payment_intent : null,
    });
    if (!payment) {
      // Not every refunded charge is an engagement payment. A subscription
      // renewal is charged against a Stripe *invoice*, which has no `payments`
      // row at all, so every subscription refund landed here and was dropped as
      // an unknown charge — leaving `invoices` saying the money was collected,
      // permanently, because nothing else ever writes to that table after the
      // row is created. The ops dashboard's revenue line read the sum of it.
      return handleInvoiceRefund(log, charge);
    }

    const state = refundState({
      amountCents: Number(payment.amount_cents),
      amountRefunded: charge.amount_refunded,
    });
    if (state.refundedCents === 0) return { received: true, ignored: 'no refunded amount' };

    // Stripe redelivers, so the question is not "did a refund happen" but "is
    // this news". Answered from the payment row's own prior state rather than
    // from the valuation's, because the valuation may legitimately not be
    // 'paid' (a partner-paid engagement, one an operator already corrected) —
    // and a redelivery that found it so would otherwise alert every time.
    const alreadyKnown = Number(payment.refunded_cents) >= state.refundedCents;
    if (alreadyKnown) return { received: true, refunded: payment.status === 'refunded' };

    await recordRefund(deps.pool, payment.id, {
      refundedCents: state.refundedCents,
      fullyRefunded: state.fullyRefunded,
    });

    if (state.fullyRefunded) {
      await revokePaidStatus(log, payment, 'The payment was refunded in full.');
    } else {
      const valuation = await findValuationById(deps.pool, payment.valuation_id);
      await alertBilling(log, {
        valuationId: payment.valuation_id,
        ownerId: valuation?.user_id ?? null,
        type: 'payment_partially_refunded',
        title: `Partial refund — ${valuation?.company_name ?? 'valuation'}`,
        // Through the money formatter every other notification on this path
        // uses. Dividing by 100 inline is not the same thing: it dropped the
        // symbol, the grouping and the trailing zeros, so an $11.90 refund
        // against a $1,190.00 payment read "11.9 usd of 1190" — three
        // ambiguities in one sentence about money, in a message sent to the
        // client and to the billing group.
        body:
          `${formatMoneyCents(state.refundedCents, payment.currency)} of ` +
          `${formatMoneyCents(Number(payment.amount_cents), payment.currency)} was refunded. ` +
          `The engagement remains paid.`,
      });
    }
    return { received: true, refunded: state.fullyRefunded };
  }

  /**
   * `charge.dispute.created` / `charge.dispute.closed` — a chargeback.
   *
   * Creation never revokes: the money is only held, the case is answerable, and
   * pulling a published 409A out from under a client who may well win would be
   * worse than the alert. It does need the alert, though, because Stripe's
   * evidence deadline is days and it is the one billing event with a clock on
   * it. Only a lost dispute revokes, on the same path as a full refund.
   */
  async function handleDispute(
    log: FastifyBaseLogger,
    dispute: Record<string, unknown>,
  ): Promise<{ received: boolean; ignored?: string; dispute_status?: DisputeStatus }> {
    const payment = await findPaymentByChargeOrIntent(deps.pool, {
      chargeId: typeof dispute.charge === 'string' ? dispute.charge : null,
      paymentIntentId: typeof dispute.payment_intent === 'string' ? dispute.payment_intent : null,
    });
    if (!payment) return { received: true, ignored: 'unknown charge' };

    const status = disputeStatusOf(dispute.status);
    // Same redelivery guard as the refund path: `created` and `closed` are both
    // retried, and a repeated `created` must not re-alert an ops team that is
    // already working the case.
    if (payment.dispute_status === status) return { received: true, dispute_status: status };
    await recordDispute(deps.pool, payment.id, status);

    if (status === 'lost') {
      await revokePaidStatus(log, payment, 'A chargeback was decided against us.');
    } else if (status === 'open') {
      const valuation = await findValuationById(deps.pool, payment.valuation_id);
      // Ops only: a client who has just disputed a charge does not need us to
      // tell them they did, and the notification would read as an accusation.
      try {
        const opsIds = await listUserIdsWithRoles(deps.pool, BILLING_ALERT_ROLES);
        await createNotifications(
          deps.pool,
          opsIds.map((userId) => ({
            userId,
            valuationId: payment.valuation_id,
            type: 'payment_disputed',
            title: `Chargeback opened — ${valuation?.company_name ?? 'valuation'}`,
            body:
              `A dispute was raised against the ${payment.currency} payment for this engagement. ` +
              `Submit evidence in Stripe before the response deadline.`,
          })),
        );
      } catch (err) {
        log.warn({ err, paymentId: payment.id }, 'dispute alert notification failed');
      }
    }
    return { received: true, dispute_status: status };
  }

  /**
   * The engagement a checkout session says it is for, or null when it does not
   * say — which is how a session opened by something other than this platform
   * reads.
   *
   * Both fields, because `createCheckoutSession` sets both and they are not
   * equally durable: `client_reference_id` is the documented top-level field
   * and `metadata.valuation_id` survives being copied onto the objects Stripe
   * derives from the session. Checked for ULID shape rather than looked up,
   * so a settled session for an engagement that has since been purged still
   * reads as ours — which is exactly the case where the row is missing.
   */
  function ourValuationId(session: Record<string, unknown>): string | null {
    const direct = session.client_reference_id;
    if (typeof direct === 'string' && isUlid(direct)) return direct;
    const metadata = session.metadata;
    if (metadata && typeof metadata === 'object') {
      const tagged = (metadata as Record<string, unknown>).valuation_id;
      if (typeof tagged === 'string' && isUlid(tagged)) return tagged;
    }
    return null;
  }

  // Webhook lives in its own plugin scope so the raw-buffer content parser
  // (required for signature verification) can't leak to other routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/api/v1/stripe/webhook', async (req, reply) => {
      if (!deps.stripeWebhookSecret) {
        throw paymentsUnavailable('Webhook not configured (STRIPE_WEBHOOK_SECRET unset)');
      }
      const raw = req.body as Buffer;
      const header = req.headers['stripe-signature'];
      if (
        typeof header !== 'string' ||
        !Buffer.isBuffer(raw) ||
        !verifyWebhookSignature({ payload: raw, header, secret: deps.stripeWebhookSecret })
      ) {
        throw problems.badRequest('Invalid Stripe signature');
      }

      // Parsed, not cast: `null`, a bare string, and a numeric `type` are all
      // valid JSON that this handler used to read as an event and answer with a
      // 500, and a NUL byte anywhere in it reached the ledger's `text` columns
      // — the one hook that would have caught it cannot see past the raw-buffer
      // parser above. See domain/stripeEvents.ts.
      const envelope = parseStripeEvent(raw);
      if ('error' in envelope) throw problems.badRequest(envelope.error);
      const event = envelope.raw as { type?: string; data?: { object?: Record<string, unknown> } };
      const session = envelope.object;
      const sessionId = typeof session.id === 'string' ? session.id : null;

      // Stripe delivers at least once. Every handler below already answers a
      // replay on its own — the compare-and-set inside `fulfill`, the refunded
      // total in `handleRefund`, the dispute status in `handleDispute` — and
      // those remain the guarantee; the ledger does not replace them and could
      // not, because two simultaneous deliveries can both be classified fresh.
      //
      // What it adds here is a record of what arrived and a short answer to the
      // ordinary sequential replay (the retry ladder, an operator resending
      // from the dashboard) before four round-trips are spent re-deriving that
      // there is nothing to do. The endpoint that needed more than that is the
      // billing one — see migration 0155 and routes/billing.ts.
      const eventKey = stripeEventKey(event, 'payments');
      if ((await classifyStripeEvent(deps.pool, eventKey)) === 'duplicate') {
        return reply.send({ received: true, duplicate: true });
      }
      // Recorded on every path out of the handler below, including the ones
      // that ignore the event — an event we decided to ignore has still been
      // dealt with, and re-deciding it on each redelivery is work for nothing.
      // Not on the throw path: an event that failed must be redelivered.
      const settled = async (body: Record<string, unknown>) => {
        await recordStripeEvent(deps.pool, eventKey);
        return reply.send(body);
      };

      // ── Money going back out ────────────────────────────────────────────
      // Refund and dispute events are not `checkout.session.*` and carry a
      // charge or a payment intent rather than a session id, so they are
      // resolved and handled before the session branch below. Before this
      // existed they fell through it as `ignored` and a refunded engagement
      // stayed paid, published, and counted as revenue.
      if (event.type === 'charge.refunded') {
        return settled(await handleRefund(req.log, session));
      }
      if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
        return settled(await handleDispute(req.log, session));
      }

      if (!event.type?.startsWith('checkout.session.') || !sessionId) {
        return settled({ received: true, ignored: event.type ?? 'unknown' });
      }
      const payment = await findPaymentBySessionId(deps.pool, sessionId);
      if (!payment) {
        /*
         * A session we cannot match to a row.
         *
         * For most event types that is ordinary and silence is right: an
         * `expired` or a `checkout.session.completed` that never settled says
         * nothing happened, and a Stripe account can carry sessions this
         * platform never created.
         *
         * A *settled* one is the opposite. The session id was minted by our own
         * checkout route, the customer has been charged, and there is nothing
         * on this side that records it — so no payment row moves to
         * `succeeded`, no valuation crosses the payment gate, and no receipt is
         * captured. Before this the handler answered `ignored: 'unknown
         * session'` and wrote the event into the ledger as dealt with, which
         * made the silence permanent: Stripe's redelivery is classified a
         * duplicate and returns without looking again.
         *
         * The gap is not hypothetical. `createCheckoutSession` runs *before*
         * `createPayment`, so any failure between the two — a pool timeout, a
         * constraint, a restart — leaves a live Stripe session with no row
         * behind it, and the client is holding a 500 from a checkout that in
         * fact opened.
         *
         * Acknowledged rather than 5xx'd, because redelivery cannot conjure the
         * missing row and Stripe would simply retry for days; alerted, because
         * a person has to reconcile it by hand. The fields are the ones that
         * reconciliation needs — which session, which event, how much.
         */
        const moneySettled =
          event.type === 'checkout.session.async_payment_succeeded' ||
          (event.type === 'checkout.session.completed' && isSettled(session.payment_status));
        // And ours. A webhook endpoint receives every event on the Stripe
        // account, so a settled session by itself proves only that *somebody*
        // took money. `createCheckoutSession` stamps every session this
        // platform opens with the engagement it is for, twice — as
        // `client_reference_id` and in `metadata` — and no other integration's
        // session carries a valuation id of ours. That is the whole
        // discriminator: with it, this is definitively our money gone missing;
        // without it, the session was never ours to reconcile and the old
        // silence is the right answer.
        const claimed = ourValuationId(session);
        if (moneySettled && claimed !== null) {
          req.log.error(
            {
              alert: true,
              actorType: 'system',
              source: 'stripe',
              sessionId,
              eventType: event.type,
              valuationId: claimed,
              amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
              currency: typeof session.currency === 'string' ? session.currency : null,
            },
            'stripe settled one of our checkout sessions with no payment row — money taken and unreconciled',
          );
          return settled({ received: true, unreconciled: 'settled session has no payment row' });
        }
        return settled({ received: true, ignored: 'unknown session' });
      }

      // Money has actually arrived, so mark the payment and release the
      // valuation.
      //
      // The claim on the row is the UPDATE itself: 'pending' is the only status
      // a session can legitimately be fulfilled from, and the compare-and-set
      // that enforces it also decides which of two concurrent deliveries owns
      // everything below. Reading `payment.status` to make that decision — as
      // this did — is wrong twice over. It cannot exclude a parallel delivery,
      // which is how one settlement produced two audit entries and two
      // notifications; and it tested for 'succeeded' specifically, so a row
      // that had since moved to 'refunded' (a refund, or a chargeback decided
      // against us) read as un-fulfilled. A replayed `completed` then marked it
      // succeeded again and put the engagement back to paid, leaving a client
      // who had been refunded in full holding a published 409A.
      const fulfill = async () => {
        const intent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
        const claimed = await markPayment(deps.pool, payment.id, 'succeeded', {
          paymentIntentId: intent,
          from: ['pending'],
        });
        if (!claimed) return;
        // Best-effort receipt capture — the charge (not the session) carries
        // receipt_url, so resolve it via the API. Failure never blocks the ack.
        if (deps.stripeSecretKey && intent) {
          try {
            const receipt = await retrieveReceipt(deps.stripeSecretKey, intent);
            await setPaymentReceipt(deps.pool, payment.id, receipt);
          } catch (err) {
            req.log.warn({ err }, 'stripe receipt lookup failed');
          }
        }
        const valuation = await findValuationById(deps.pool, payment.valuation_id);
        if (valuation && valuation.paid_status === 'unpaid') {
          const amount =
            typeof session.amount_total === 'number' ? session.amount_total : Number(payment.amount_cents);
          // Payment is the gate between "the client has given us everything"
          // and "an analyst has picked it up", and crossing it is exactly what
          // the `paid` state records. Only from `completed`: money landing on a
          // file already in review, or on one that never reached the gate,
          // says nothing about where the work has got to, and rewinding it to
          // `paid` would be a lie the dashboard then has to be read around.
          const advancing = valuation.state === 'completed';
          const updated = await patchValuation(
            deps.pool,
            valuation,
            {
              paid_status: 'paid',
              amount_cents: amount,
              paid_at: new Date(),
              ...(advancing ? { state: 'paid' } : {}),
              // Express is a promise that only starts costing us once the
              // money is in, so the SLA moves here and not at checkout — an
              // abandoned or bounced express order must not leave a
              // one-business-day due date on an unpaid engagement. Written
              // through patchValuation so the change lands in the audit trail
              // attributed to Stripe, like the paid fields beside it.
              ...(payment.express ? { delivery_days: EXPRESS_DELIVERY_DAYS } : {}),
            },
            { actorType: 'system', source: 'stripe' },
          );
          // Same hook every other path into a state runs through, so partner
          // webhooks and the notification matrix see this transition too.
          if (advancing) {
            await onStateChanged(
              {
                pool: deps.pool,
                transport: deps.transport,
                log: req.log,
                publicBaseUrl: deps.publicBaseUrl,
                settings: deps.settings,
              },
              updated,
              'paid',
            );
          }
        }
        // Outside the `paid_status === 'unpaid'` branch on purpose. That branch
        // is about the *engagement* crossing the payment gate, which a second
        // charge on an already-paid file does not do; this is about the charge,
        // and `claimed` above has already established there is exactly one of
        // them. An add-on bought after the fact is still money we took.
        if (valuation) await announcePaymentReceived(req.log, claimed, valuation);
      };

      if (event.type === 'checkout.session.completed') {
        // `completed` means the customer finished the Checkout page, which is
        // not the same as having paid. Every delayed-notification method — ACH
        // direct debit, SEPA, Bacs, boleto, OXXO, Konbini — completes the
        // session with `payment_status: 'unpaid'` and settles days later as
        // `async_payment_succeeded` or `async_payment_failed`.
        //
        // Fulfilling on `completed` alone gave those away. The valuation flipped
        // to paid the moment the customer clicked through, and when the debit
        // then bounced, `async_payment_failed` arrived to find the row already
        // `succeeded` — its `status === 'pending'` guard declined to touch it,
        // so nothing downgraded and nothing alerted. A client who chose ACH and
        // let it fail kept a published 409A and paid nothing, and the only trace
        // was in the Stripe dashboard.
        //
        // So `completed` fulfils only when the session says the money is in.
        // An *absent* payment_status still fulfils: it is what the field looks
        // like on anything that isn't a current Checkout Session, and the wrong
        // way to be wrong here is to withhold a report a client has paid for.
        // Only a session that positively reports itself unpaid waits — and it
        // stays `pending`, which is exactly the state the two async events
        // downstream know how to resolve.
        if (isSettled(session.payment_status)) {
          await fulfill();
        } else {
          req.log.info(
            { sessionId, paymentStatus: session.payment_status },
            'checkout completed with a delayed payment method — awaiting settlement',
          );
        }
      } else if (event.type === 'checkout.session.async_payment_succeeded') {
        // The settlement half of the above: the delayed debit cleared.
        await fulfill();
      } else if (event.type === 'checkout.session.expired') {
        await markPayment(deps.pool, payment.id, 'expired', { from: ['pending'] });
      } else if (event.type === 'checkout.session.async_payment_failed') {
        // The delayed debit bounced. Marking the row failed is not enough on
        // its own: the client believes they have paid — they completed Checkout
        // days ago — and the engagement is sitting unpaid with nobody aware.
        // That silence is half of what made the original ACH bug expensive.
        //
        // Same compare-and-set as fulfilment, and for the second of its two
        // reasons: the alert below is one a redelivery must not send twice.
        if (await markPayment(deps.pool, payment.id, 'failed', { from: ['pending'] })) {
          const valuation = await findValuationById(deps.pool, payment.valuation_id);
          await alertBilling(req.log, {
            valuationId: payment.valuation_id,
            ownerId: valuation?.user_id ?? null,
            type: 'payment_failed',
            title: `Payment failed — ${valuation?.company_name ?? 'valuation'}`,
            body:
              'The bank debit for this engagement did not clear, so it is still unpaid. ' +
              'You can start the payment again from the billing page.',
          });
        }
      }
      return settled({ received: true });
    });
  });
}
