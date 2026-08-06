import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertSubscription, createInvoice, nextInvoiceSequence } from '../../src/repos/billing.js';
import { invoiceNumber } from '../../src/domain/billing.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_test_secret';

function stripeSig(payload: string, secret = WEBHOOK_SECRET): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

describe.skipIf(!dbUp)('subscription billing (feature 7)', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    user = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  it('lists the seeded plan catalogue', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    const tiers = res.json().plans.map((p: { tier: string }) => p.tier);
    expect(tiers).toEqual(['per_valuation', 'annual_retainer', 'enterprise']);
  });

  it('enforces the plan valuation limit on creation', async () => {
    const sub = await upsertSubscription(ctx.pool, { userId: user.id, planTier: 'annual_retainer' });
    // annual_retainer limit is 12 — set usage to 11 so one remains.
    await ctx.pool.query('UPDATE subscriptions SET valuations_used = 11 WHERE id = $1', [sub.id]);

    const create = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(user.token),
        payload: { kind: '409a', company_name: 'Limit Co' },
      });

    expect((await create()).statusCode).toBe(201); // 12th — allowed
    const blocked = await create(); // 13th — over limit
    expect(blocked.statusCode).toBe(402);

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/subscription',
      headers: authHeader(user.token),
    });
    expect(status.json().usage.used).toBe(12);
    expect(status.json().usage.remaining).toBe(0);
    expect(status.json().usage.exhausted).toBe(true);
  });

  it('creates a subscription from a signed webhook event', async () => {
    const fresh = await seedUser(ctx, { roles: ['valuation_user'] });
    const event = JSON.stringify({
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_webhook_1',
          status: 'active',
          customer: 'cus_1',
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 31536000,
          metadata: { user_id: fresh.id, plan_tier: 'enterprise' },
        },
      },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'stripe-signature': stripeSig(event), 'content-type': 'application/json' },
      payload: event,
    });
    expect(res.statusCode).toBe(200);

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/subscription',
      headers: authHeader(fresh.token),
    });
    expect(status.json().subscription.plan_tier).toBe('enterprise');
    expect(status.json().usage.unlimited).toBe(true);
  });

  it('rejects a webhook with a bad signature', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('generates an invoice PDF for the owner', async () => {
    const seq = await nextInvoiceSequence(ctx.pool);
    const invoice = await createInvoice(ctx.pool, {
      number: invoiceNumber(new Date().toISOString(), seq),
      userId: user.id,
      amountCents: 2_000_000,
      currency: 'usd',
      status: 'paid',
      lineItems: [{ description: 'Annual retainer', amount_cents: 2_000_000 }],
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/billing/invoices/${invoice.id}/pdf`,
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('exposes the admin billing dashboard to ops only', async () => {
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing',
      headers: authHeader(user.token),
    });
    expect(denied.statusCode).toBe(403);

    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing',
      headers: authHeader(ops.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().summary).toHaveProperty('mrr_cents');
    expect(Array.isArray(ok.json().subscriptions)).toBe(true);
  });
});

// Stripe issues a separate signing secret per registered endpoint, and the
// billing webhook is a separate endpoint from the payment one. With a single
// secret in the env, whichever endpoint it does not belong to answers every
// delivery with 400 — silently, apart from Stripe's failed-delivery list.
describe.skipIf(!dbUp)('billing webhook signing secret (STRIPE_BILLING_WEBHOOK_SECRET)', () => {
  const BILLING_SECRET = 'whsec_billing_endpoint_secret';
  const PAYMENT_SECRET = 'whsec_payment_endpoint_secret';

  it('verifies against its own secret, not the payment endpoint one', async () => {
    const ctx = await setupTestApp({
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_WEBHOOK_SECRET: PAYMENT_SECRET,
      STRIPE_BILLING_WEBHOOK_SECRET: BILLING_SECRET,
    });
    try {
      const event = JSON.stringify({ id: 'evt_secret_split', type: 'invoice.paid', data: {} });

      const signedWithBilling = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: {
          'stripe-signature': stripeSig(event, BILLING_SECRET),
          'content-type': 'application/json',
        },
        payload: event,
      });
      expect(signedWithBilling.statusCode).toBe(200);

      const signedWithPayment = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: {
          'stripe-signature': stripeSig(event, PAYMENT_SECRET),
          'content-type': 'application/json',
        },
        payload: event,
      });
      expect(signedWithPayment.statusCode).toBe(400);
    } finally {
      await ctx.teardown();
    }
  });

  it('falls back to STRIPE_WEBHOOK_SECRET when unset, for single-endpoint deployments', async () => {
    const ctx = await setupTestApp({
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_WEBHOOK_SECRET: PAYMENT_SECRET,
    });
    try {
      const event = JSON.stringify({ id: 'evt_secret_fallback', type: 'invoice.paid', data: {} });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: {
          'stripe-signature': stripeSig(event, PAYMENT_SECRET),
          'content-type': 'application/json',
        },
        payload: event,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.teardown();
    }
  });
});
