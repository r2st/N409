import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, problems } from '@n409/shared';
import { renderReportPdf } from '@n409/report/pdf';
import { isOps } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findUserById } from '../repos/users.js';
import { createSubscriptionCheckoutSession, verifyWebhookSignature } from '../payments/stripe.js';
import {
  cancelSubscription,
  createInvoice,
  findActiveSubscription,
  findInvoice,
  findInvoiceByStripeId,
  findPlan,
  listAllInvoices,
  listAllSubscriptions,
  listInvoicesForUser,
  listPlans,
  nextInvoiceSequence,
  upsertSubscription,
} from '../repos/billing.js';
import {
  invoiceNumber,
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
  app.get('/api/v1/billing/plans', { preHandler: app.authenticate }, async () => ({
    plans: await listPlans(deps.pool),
    configured: Boolean(deps.stripeSecretKey),
  }));

  // Start a recurring subscription checkout for a retainer/enterprise plan.
  app.post('/api/v1/billing/subscribe', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!deps.stripeSecretKey) throw billingUnavailable('Payments are not configured');
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
    };
  });

  // ── Admin billing dashboard ──────────────────────────────────────────────
  app.get('/api/v1/admin/billing', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Billing dashboard is operations-only');
    const [subscriptions, invoices] = await Promise.all([
      listAllSubscriptions(deps.pool),
      listAllInvoices(deps.pool),
    ]);
    // Normalise each active plan's price to a monthly run-rate for MRR.
    const mrrCents = subscriptions
      .filter((s) => s.status === 'active' || s.status === 'trialing')
      .reduce(
        (sum, s) =>
          sum +
          (s.interval === 'year'
            ? Math.round(s.price_cents / 12)
            : s.interval === 'month'
              ? s.price_cents
              : 0),
        0,
      );
    return {
      subscriptions,
      invoices,
      summary: {
        active: subscriptions.filter((s) => s.status === 'active').length,
        mrr_cents: mrrCents,
        collected_cents: invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount_cents, 0),
      },
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
      }),
    });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${invoice.number}.pdf"`)
      .send(pdf);
  });

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

      try {
        if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
          const meta = (obj.metadata ?? {}) as Record<string, string>;
          if (meta.user_id && meta.plan_tier) {
            await upsertSubscription(deps.pool, {
              userId: meta.user_id,
              planTier: meta.plan_tier,
              status: 'active',
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
            const lineItems: InvoiceLineItem[] = [
              { description: String(obj.description ?? 'Subscription'), amount_cents: amount },
            ];
            await createInvoice(deps.pool, {
              number: invoiceNumber(issuedIso, seq),
              userId,
              subscriptionId,
              amountCents: amount,
              currency: String(obj.currency ?? 'usd'),
              status: 'paid',
              periodStart: tsToDate(obj.period_start),
              periodEnd: tsToDate(obj.period_end),
              lineItems,
              stripeInvoiceId,
              paidAt: new Date(),
            });
          }
        }
      } catch (err) {
        req.log.error({ err, type }, 'billing webhook handling failed');
        // 200 anyway so Stripe doesn't hammer retries on a transient DB blip;
        // the event id is logged for manual reconciliation.
      }
      return reply.send({ received: true });
    });
  });
}
