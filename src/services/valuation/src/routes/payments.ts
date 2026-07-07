import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import type { ValuationKind } from '../domain/valuation.js';
import { findValuationById, patchValuation, type ValuationRow } from '../repos/valuations.js';
import { createPayment, findPaymentBySessionId, listPayments, markPayment } from '../repos/payments.js';
import { createCheckoutSession, StripeApiError, verifyWebhookSignature } from '../payments/stripe.js';
import { requirePrincipal } from '../plugins/auth.js';

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

async function loadAuthorized(
  pool: pg.Pool,
  principal: Principal,
  id: string,
): Promise<ValuationRow> {
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
      const back = `${base}/valuations/${valuation.id}`;
      let session;
      try {
        session = await createCheckoutSession(deps.stripeSecretKey, {
          valuationId: valuation.id,
          productName: `${valuation.kind.toUpperCase()} valuation — ${valuation.company_name}`,
          amountCents,
          currency: valuation.currency || 'USD',
          successUrl: `${back}?payment=success`,
          cancelUrl: `${back}?payment=cancelled`,
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

  // Webhook lives in its own plugin scope so the raw-buffer content parser
  // (required for signature verification) can't leak to other routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
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

      if (!event.type?.startsWith('checkout.session.') || !sessionId) {
        return reply.send({ received: true, ignored: event.type ?? 'unknown' });
      }
      const payment = await findPaymentBySessionId(deps.pool, sessionId);
      if (!payment) return reply.send({ received: true, ignored: 'unknown session' });

      if (event.type === 'checkout.session.completed') {
        // Idempotent: replayed events find the row already succeeded.
        if (payment.status !== 'succeeded') {
          const intent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
          await markPayment(deps.pool, payment.id, 'succeeded', intent);
          const valuation = await findValuationById(deps.pool, payment.valuation_id);
          if (valuation && valuation.paid_status === 'unpaid') {
            const amount =
              typeof session.amount_total === 'number'
                ? session.amount_total
                : Number(payment.amount_cents);
            await patchValuation(
              deps.pool,
              valuation,
              { paid_status: 'paid', amount_cents: amount, paid_at: new Date() },
              { actorType: 'system', source: 'stripe' },
            );
          }
        }
      } else if (event.type === 'checkout.session.expired') {
        if (payment.status === 'pending') await markPayment(deps.pool, payment.id, 'expired');
      } else if (event.type === 'checkout.session.async_payment_failed') {
        if (payment.status === 'pending') await markPayment(deps.pool, payment.id, 'failed');
      }
      return reply.send({ received: true });
    });
  });
}
