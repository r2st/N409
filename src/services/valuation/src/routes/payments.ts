import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import type { ValuationKind } from '../domain/valuation.js';
import { findValuationById, patchValuation, type ValuationRow } from '../repos/valuations.js';
import {
  createPayment,
  findPaymentByChargeOrIntent,
  findPaymentBySessionId,
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
  retrieveReceipt,
  StripeApiError,
  verifyWebhookSignature,
} from '../payments/stripe.js';
import { requirePrincipal } from '../plugins/auth.js';
import { collectedTotals, disputeStatusOf, refundState, type DisputeStatus } from '../domain/payments.js';
import { createNotification } from '../repos/notifications.js';
import { listUserIdsWithRoles } from '../repos/users.js';
import { BILLING_ALERT_ROLES } from '../domain/roles.js';

/**
 * Stripe payment processing (remaining-gaps §3 #1 / §6 P0 #2).
 *
 * Checkout: the client (or ops on their behalf) opens a Stripe-hosted page;
 * we persist a pending `payments` row keyed by the session id. Webhook:
 * `checkout.session.completed` flips the row and the valuation's paid fields
 * — the webhook is the source of truth, never the browser redirect.
 */

/** List price per product kind, cents. Ops can override per checkout. */
export const DEFAULT_PRICE_CENTS: Partial<Record<ValuationKind, number>> = {
  '409a': 119_000,
  fmv: 99_000,
  '718': 149_000,
  '820': 149_000,
};
export const FALLBACK_PRICE_CENTS = 99_000;

export function priceForKind(kind: string): number {
  return DEFAULT_PRICE_CENTS[kind as ValuationKind] ?? FALLBACK_PRICE_CENTS;
}

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

const CheckoutBody = z
  .object({
    // Ops-only override; clients always pay list price.
    amount_cents: z.number().int().positive().max(10_000_000).optional(),
  })
  .default({});

export interface PaymentDeps {
  pool: pg.Pool;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  publicBaseUrl: string;
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

      if (!deps.stripeSecretKey) {
        throw paymentsUnavailable('Payments are not configured (STRIPE_SECRET_KEY unset)');
      }
      if (valuation.paid_status !== 'unpaid') {
        throw problems.conflict(`Valuation is already ${valuation.paid_status}`);
      }

      const parsed = CheckoutBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw problems.unprocessable('Invalid checkout', { errors: parsed.error.issues });
      }
      const amountCents =
        isOps(principal) && parsed.data.amount_cents
          ? parsed.data.amount_cents
          : priceForKind(valuation.kind);

      const base = deps.publicBaseUrl.replace(/\/$/, '');
      let session;
      try {
        session = await createCheckoutSession(deps.stripeSecretKey, {
          valuationId: valuation.id,
          productName: `${valuation.kind.toUpperCase()} valuation — ${valuation.company_name}`,
          amountCents,
          currency: valuation.currency || 'USD',
          successUrl: `${base}/payment/success?valuation=${valuation.id}`,
          cancelUrl: `${base}/payment/cancel?valuation=${valuation.id}`,
        });
      } catch (err) {
        if (err instanceof StripeApiError) {
          req.log.warn({ err }, 'stripe checkout session failed');
          throw stripeUpstream(`Stripe: ${err.message}`);
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
      });
      return reply.status(201).send({ payment, checkout_url: session.url });
    },
  );

  app.get('/api/v1/valuations/:id/payments', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadAuthorized(deps.pool, principal, id);
    return { payments: await listPayments(deps.pool, id) };
  });

  // Price transparency: what "Pay now" will charge, before opening Stripe.
  app.get('/api/v1/valuations/:id/payments/quote', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorized(deps.pool, principal, id);
    return {
      quote: {
        amount_cents: priceForKind(valuation.kind),
        currency: valuation.currency || 'USD',
        kind: valuation.kind,
        // false → the UI shows the invoice-fallback messaging up front.
        configured: Boolean(deps.stripeSecretKey),
      },
    };
  });

  // Account-level billing rollup (P2 #13): every payment across the caller's
  // accessible valuations — client: own, partner: org, ops: all — plus the
  // unpaid engagements the page turns into a pay-now call-to-action.
  app.get('/api/v1/me/billing', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const scope = valuationScope(principal);
    const [payments, unpaid] = await Promise.all([
      listPaymentsForScope(deps.pool, scope),
      listUnpaidValuationsForScope(deps.pool, scope),
    ]);
    return {
      billing: {
        payments,
        unpaid_valuations: unpaid.map((v) => ({
          ...v,
          amount_cents: priceForKind(v.kind),
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
      for (const userId of recipients) {
        await createNotification(deps.pool, {
          userId,
          valuationId: args.valuationId,
          type: args.type,
          title: args.title,
          body: args.body,
        });
      }
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
    if (!payment) return { received: true, ignored: 'unknown charge' };

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
        body:
          `${state.refundedCents / 100} ${payment.currency} of ${Number(payment.amount_cents) / 100} ` +
          `was refunded. The engagement remains paid.`,
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
        for (const userId of await listUserIdsWithRoles(deps.pool, BILLING_ALERT_ROLES)) {
          await createNotification(deps.pool, {
            userId,
            valuationId: payment.valuation_id,
            type: 'payment_disputed',
            title: `Chargeback opened — ${valuation?.company_name ?? 'valuation'}`,
            body:
              `A dispute was raised against the ${payment.currency} payment for this engagement. ` +
              `Submit evidence in Stripe before the response deadline.`,
          });
        }
      } catch (err) {
        log.warn({ err, paymentId: payment.id }, 'dispute alert notification failed');
      }
    }
    return { received: true, dispute_status: status };
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

      let event: { type?: string; data?: { object?: Record<string, unknown> } };
      try {
        event = JSON.parse(raw.toString('utf8')) as typeof event;
      } catch {
        throw problems.badRequest('Invalid webhook payload');
      }
      const session = event.data?.object ?? {};
      const sessionId = typeof session.id === 'string' ? session.id : null;

      // ── Money going back out ────────────────────────────────────────────
      // Refund and dispute events are not `checkout.session.*` and carry a
      // charge or a payment intent rather than a session id, so they are
      // resolved and handled before the session branch below. Before this
      // existed they fell through it as `ignored` and a refunded engagement
      // stayed paid, published, and counted as revenue.
      if (event.type === 'charge.refunded') {
        return reply.send(await handleRefund(req.log, session));
      }
      if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
        return reply.send(await handleDispute(req.log, session));
      }

      if (!event.type?.startsWith('checkout.session.') || !sessionId) {
        return reply.send({ received: true, ignored: event.type ?? 'unknown' });
      }
      const payment = await findPaymentBySessionId(deps.pool, sessionId);
      if (!payment) return reply.send({ received: true, ignored: 'unknown session' });

      // Money has actually arrived, so mark the payment and release the
      // valuation. Idempotent: replayed events find the row already succeeded.
      const fulfill = async () => {
        if (payment.status === 'succeeded') return;
        const intent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
        await markPayment(deps.pool, payment.id, 'succeeded', { paymentIntentId: intent });
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
          await patchValuation(
            deps.pool,
            valuation,
            { paid_status: 'paid', amount_cents: amount, paid_at: new Date() },
            { actorType: 'system', source: 'stripe' },
          );
        }
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
        if (payment.status === 'pending') await markPayment(deps.pool, payment.id, 'expired');
      } else if (event.type === 'checkout.session.async_payment_failed') {
        // The delayed debit bounced. Marking the row failed is not enough on
        // its own: the client believes they have paid — they completed Checkout
        // days ago — and the engagement is sitting unpaid with nobody aware.
        // That silence is half of what made the original ACH bug expensive.
        if (payment.status === 'pending') {
          await markPayment(deps.pool, payment.id, 'failed');
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
      return reply.send({ received: true });
    });
  });
}
