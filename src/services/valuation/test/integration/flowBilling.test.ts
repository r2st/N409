import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * One subscription, from the price list to the cancellation.
 *
 * Every part of this has a test; the sequence has none, and the sequence is
 * where the money is. Stripe drives it through webhooks, each of which is
 * handled independently and lands the account in a state the *next* one has to
 * read correctly — so the failures are all of the form "this event is fine on
 * its own and wrong after that one". A checkout completed by a delayed debit
 * that grants the plan's quota before the money clears. An `invoice.paid`
 * redelivery that bills the customer twice, or burns an invoice number and
 * leaves a gap an auditor reads as a missing invoice. A cancellation that
 * leaves the quota in place, so a former subscriber keeps drawing on a plan
 * they no longer pay for — or takes it away so completely that the per-
 * valuation flow they fall back to cannot open a valuation at all.
 *
 * Stripe itself is stubbed at `fetch`, and the assertions include what we sent
 * it: a Checkout Session created without the metadata the webhook reconciles on
 * produces a payment nothing in this system can attribute.
 */

const dbUp = await isDbAvailable();

const WEBHOOK_SECRET = 'whsec_flow_billing';
/**
 * Live-shaped on purpose. With a test key, checkout is deliberately withheld
 * from everyone but ops (`checkoutAvailableTo`) — correct, and it would mean
 * this walked the ops path rather than the subscriber's. No request reaches
 * Stripe: `fetch` is stubbed throughout.
 */
const SECRET_KEY = 'sk_live_flow_billing_stub';

function signed(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const STRIPE_SUB_ID = 'sub_flow_billing_1';
const STRIPE_CUSTOMER_ID = 'cus_flow_billing_1';

describe.skipIf(!dbUp)('the subscription lifecycle', () => {
  let ctx: TestApp;
  let subscriber: Awaited<ReturnType<typeof seedUser>>;
  let bystander: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const as = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: authHeader(token), ...(payload ? { payload } : {}) });

  /** Deliver a signed Stripe event to the billing endpoint. */
  const deliver = (type: string, object: Record<string, unknown>) => {
    const body = JSON.stringify({ type, data: { object } });
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signed(body),
      payload: body,
    });
  };

  const subscriptionView = async () => (await as(subscriber.token, 'GET', '/api/v1/me/subscription')).json();

  const openValuation = (name: string) =>
    as(subscriber.token, 'POST', '/api/v1/valuations', { kind: '409a', company_name: name });

  /** Stripe's reply to whichever call is about to be made. */
  const stubStripe = (json: Record<string, unknown>) =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

  beforeAll(async () => {
    ctx = await setupTestApp({
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      AUTO_PIPELINE: 'off',
      EMAIL_MODE: 'off',
    });
    subscriber = await seedUser(ctx, { roles: ['valuation_user'] });
    bystander = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => ctx?.teardown());

  // ── 1. Before there is a subscription ─────────────────────────────────────

  it('offers the catalogue, priced, and says checkout is open', async () => {
    const res = await as(subscriber.token, 'GET', '/api/v1/billing/plans');
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(true);
    const plans = res.json().plans as Array<{
      tier: string;
      interval: string;
      valuation_limit: number | null;
    }>;
    expect(plans.map((p) => p.tier)).toEqual(['per_valuation', 'annual_retainer', 'enterprise']);
    expect(plans.find((p) => p.tier === 'annual_retainer')!.valuation_limit).toBe(12);
    expect(plans.find((p) => p.tier === 'enterprise')!.valuation_limit).toBeNull();
  });

  it('reports no subscription, no usage and no portal to a customer who has none', async () => {
    const body = await subscriptionView();
    expect(body.subscription).toBeNull();
    expect(body.usage).toBeNull();
    expect(body.invoices).toEqual([]);
    // Nothing to manage until there is a Stripe customer behind it.
    expect(body.portal_available).toBe(false);
  });

  it('meters nothing while there is no plan to meter against', async () => {
    // The per-valuation flow is the default, and it is not a quota — an
    // unsubscribed customer must not be capped by a subscription they do not
    // have.
    for (const name of ['Unmetered One', 'Unmetered Two']) {
      expect((await openValuation(name)).statusCode).toBe(201);
    }
  });

  it('refuses to open a billing portal for a customer with no billing account', async () => {
    const res = await as(subscriber.token, 'POST', '/api/v1/billing/portal');
    expect(res.statusCode).toBe(409);
  });

  // ── 2. Checkout ───────────────────────────────────────────────────────────

  it('will not sell a subscription to the per-valuation plan', async () => {
    const res = await as(subscriber.token, 'POST', '/api/v1/billing/subscribe', {
      plan_tier: 'per_valuation',
    });
    expect(res.statusCode).toBe(422);
  });

  it('404s a plan that is not in the catalogue', async () => {
    const res = await as(subscriber.token, 'POST', '/api/v1/billing/subscribe', { plan_tier: 'platinum' });
    expect(res.statusCode).toBe(404);
  });

  it('opens a checkout carrying what the webhook will have to reconcile on', async () => {
    const fetchSpy = stubStripe({ id: 'cs_flow_1', url: 'https://checkout.stripe.com/c/pay/cs_flow_1' });

    const res = await as(subscriber.token, 'POST', '/api/v1/billing/subscribe', {
      plan_tier: 'annual_retainer',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_flow_1');

    const [, init] = fetchSpy.mock.calls[0]!;
    const form = new URLSearchParams(String(init!.body));
    expect(form.get('mode')).toBe('subscription');
    // The seam. Every later event is matched back to an account through these
    // two fields; a session created without them is money that arrives with no
    // customer attached to it.
    expect(form.get('metadata[user_id]')).toBe(subscriber.id);
    expect(form.get('metadata[plan_tier]')).toBe('annual_retainer');
    expect(form.get('subscription_data[metadata][user_id]')).toBe(subscriber.id);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2000000');
    expect(form.get('line_items[0][price_data][recurring][interval]')).toBe('year');
  });

  it('refuses a checkout to nobody at all', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscribe',
      payload: { plan_tier: 'annual_retainer' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── 3. The money, in the order Stripe reports it ──────────────────────────

  it('does not hand over the plan on a checkout whose debit has not cleared', async () => {
    const res = await deliver('checkout.session.completed', {
      id: 'cs_flow_1',
      mode: 'subscription',
      // A delayed-notification method completes the session before the money
      // moves. Calling this 'active' would grant twelve valuations against a
      // debit that may still bounce.
      payment_status: 'unpaid',
      subscription: STRIPE_SUB_ID,
      customer: STRIPE_CUSTOMER_ID,
      metadata: { user_id: subscriber.id, plan_tier: 'annual_retainer' },
    });
    expect(res.statusCode).toBe(200);

    const body = await subscriptionView();
    expect(body.subscription.status).toBe('past_due');
    expect(body.subscription.plan_tier).toBe('annual_retainer');
    expect(body.plan.valuation_limit).toBe(12);
  });

  it('promotes it the moment Stripe says the subscription is live', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await deliver('customer.subscription.updated', {
      id: STRIPE_SUB_ID,
      status: 'active',
      customer: STRIPE_CUSTOMER_ID,
      current_period_start: now,
      current_period_end: now + 31_536_000,
      metadata: { user_id: subscriber.id, plan_tier: 'annual_retainer' },
    });
    expect(res.statusCode).toBe(200);

    const body = await subscriptionView();
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.current_period_end).toBeTruthy();
    expect(body.usage).toMatchObject({ limit: 12, exhausted: false });
  });

  it('is one subscription however many events described it', async () => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM subscriptions WHERE user_id = $1',
      [subscriber.id],
    );
    // Checkout and the subscription event both name the same Stripe id; two
    // rows here would mean the customer is billed on one and metered on the
    // other.
    expect(rows[0]!.n).toBe('1');
  });

  it('refuses a second subscription while one is running', async () => {
    const res = await as(subscriber.token, 'POST', '/api/v1/billing/subscribe', { plan_tier: 'enterprise' });
    expect(res.statusCode).toBe(409);
  });

  // ── 4. The quota, which is what was bought ────────────────────────────────

  it('draws each new engagement against the plan and stops at the limit', async () => {
    // Two were opened before the plan existed and are not part of it: usage
    // counts from the subscription, not from the account's history.
    expect((await subscriptionView()).usage.used).toBe(0);

    for (let i = 1; i <= 12; i += 1) {
      const res = await openValuation(`Metered ${i}`);
      expect({ i, status: res.statusCode }).toEqual({ i, status: 201 });
    }

    const over = await openValuation('Thirteenth');
    expect(over.statusCode).toBe(402);
    expect(over.json().type).toContain('plan-limit');
    /*
     * And what the subscriber reads. This said "upgrade or purchase additional
     * valuations", which named a remedy this product does not sell —
     * ADDON_KEYS is express delivery and the QSBS letter, both per-engagement
     * extras that return no quota — and stated none of the figures the
     * subscription row it was raised from already held.
     */
    const detail = over.json().detail as string;
    expect(detail).toContain('all 12 valuations included in');
    expect(detail).not.toMatch(/purchase additional/i);
    expect(detail).toContain('/billing');

    const usage = (await subscriptionView()).usage;
    expect(usage).toMatchObject({ used: 12, remaining: 0, exhausted: true });
  });

  it('meters the subscriber and not the customer next to them', async () => {
    const res = await as(bystander.token, 'POST', '/api/v1/valuations', {
      kind: '409a',
      company_name: 'Not On The Plan',
    });
    expect(res.statusCode).toBe(201);
  });

  // ── 5. Invoicing ──────────────────────────────────────────────────────────

  const paidInvoice = (id: string) => ({
    id,
    subscription: STRIPE_SUB_ID,
    amount_paid: 2_000_000,
    currency: 'usd',
    description: 'Annual retainer',
    period_start: Math.floor(Date.now() / 1000),
    period_end: Math.floor(Date.now() / 1000) + 31_536_000,
  });

  it('raises a numbered invoice when the renewal is paid', async () => {
    expect((await deliver('invoice.paid', paidInvoice('in_flow_1'))).statusCode).toBe(200);

    const invoices = (await subscriptionView()).invoices as Array<{
      id: string;
      number: string;
      status: string;
      amount_cents: number;
    }>;
    expect(invoices.length).toBe(1);
    expect(invoices[0]!.status).toBe('paid');
    expect(invoices[0]!.amount_cents).toBe(2_000_000);
    expect(invoices[0]!.number).toMatch(/\d/);
  });

  it('does not bill twice for a redelivery of the same invoice', async () => {
    // Stripe delivers at least once. A second row here is a duplicate invoice;
    // a burnt sequence number is a gap an auditor reads as a missing one.
    expect((await deliver('invoice.paid', paidInvoice('in_flow_1'))).statusCode).toBe(200);
    expect(((await subscriptionView()).invoices as unknown[]).length).toBe(1);
  });

  it('renders the invoice as a PDF for the customer it belongs to', async () => {
    const invoice = ((await subscriptionView()).invoices as Array<{ id: string; number: string }>)[0]!;

    const pdf = await as(subscriber.token, 'GET', `/api/v1/billing/invoices/${invoice.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`${invoice.number}.pdf`);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    // And to nobody else's — an invoice names what a company paid and when.
    expect((await as(bystander.token, 'GET', `/api/v1/billing/invoices/${invoice.id}/pdf`)).statusCode).toBe(
      404,
    );
    // Ops can pull it, because somebody has to answer a billing query.
    expect((await as(ops.token, 'GET', `/api/v1/billing/invoices/${invoice.id}/pdf`)).statusCode).toBe(200);
  });

  it('puts the subscription and its revenue on the operations dashboard', async () => {
    expect((await as(subscriber.token, 'GET', '/api/v1/admin/billing')).statusCode).toBe(403);

    const res = await as(ops.token, 'GET', '/api/v1/admin/billing');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.active).toBe(1);
    // An annual plan at $20,000 is a $1,666.67 monthly run rate.
    expect(body.summary.mrr_cents).toBe(Math.round(2_000_000 / 12));
    expect(body.summary.collected_cents).toBe(2_000_000);
  });

  // ── 6. Self-serve management ──────────────────────────────────────────────

  it('opens the hosted portal now that there is a customer behind the account', async () => {
    expect((await subscriptionView()).portal_available).toBe(true);

    const fetchSpy = stubStripe({ id: 'bps_flow_1', url: 'https://billing.stripe.com/session/flow' });
    const res = await as(subscriber.token, 'POST', '/api/v1/billing/portal');
    expect(res.statusCode).toBe(200);
    expect(res.json().portal_url).toBe('https://billing.stripe.com/session/flow');

    // Always the caller's own customer, never one named in the request.
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(new URLSearchParams(String(init!.body)).get('customer')).toBe(STRIPE_CUSTOMER_ID);
  });

  // ── 7. The end of it ──────────────────────────────────────────────────────

  it('cancels on Stripe’s word and stops metering against a plan nobody pays for', async () => {
    const res = await deliver('customer.subscription.deleted', { id: STRIPE_SUB_ID });
    expect(res.statusCode).toBe(200);

    const body = await subscriptionView();
    // No *active* subscription to report — the row is retained as history, and
    // the quota that came with it is not.
    expect(body.subscription).toBeNull();
    expect(body.usage).toBeNull();

    // The exhausted plan was the only thing refusing this a moment ago. A
    // cancellation that left the cap in place would lock a paying-per-valuation
    // customer out of the product entirely.
    const after = await openValuation('After Cancellation');
    expect(after.statusCode).toBe(201);
  });

  it('keeps the invoices that were raised while it ran', async () => {
    // Cancelling does not unbill anything: the money was taken, and the record
    // of it is what the customer's accountant reconciles against.
    expect(((await subscriptionView()).invoices as unknown[]).length).toBe(1);
  });

  // ── The refusals ──────────────────────────────────────────────────────────

  describe('what the webhook will not accept', () => {
    it('rejects an event signed with the wrong secret', async () => {
      const body = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
      const t = Math.floor(Date.now() / 1000);
      const mac = crypto.createHmac('sha256', 'whsec_not_ours').update(`${t}.${body}`).digest('hex');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an event carrying no signature at all', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'invoice.paid', data: { object: {} } }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a correctly signed body that is not JSON', async () => {
      const body = 'not json at all';
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: signed(body),
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it('ignores an invoice for a subscription this system has never seen', async () => {
      const before = ((await subscriptionView()).invoices as unknown[]).length;
      const res = await deliver('invoice.paid', { id: 'in_unknown', subscription: 'sub_never_heard_of' });
      // Acknowledged — there is nothing to retry — and nothing invented.
      expect(res.statusCode).toBe(200);
      expect(((await subscriptionView()).invoices as unknown[]).length).toBe(before);
    });
  });

  describe('a deployment with no billing configured', () => {
    let bare: TestApp;
    let user: Awaited<ReturnType<typeof seedUser>>;

    beforeAll(async () => {
      bare = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
      user = await seedUser(bare, { roles: ['valuation_user'] });
    });
    afterAll(async () => bare?.teardown());

    it('still shows the price list, marked as unbuyable', async () => {
      const res = await bare.app.inject({
        method: 'GET',
        url: '/api/v1/billing/plans',
        headers: authHeader(user.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
      expect((res.json().plans as unknown[]).length).toBe(3);
    });

    it('answers a subscribe attempt with "not configured" rather than a crash', async () => {
      const res = await bare.app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscribe',
        headers: authHeader(user.token),
        payload: { plan_tier: 'annual_retainer' },
      });
      expect(res.statusCode).toBe(503);
    });

    it('answers a webhook delivery the same way', async () => {
      const res = await bare.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'invoice.paid', data: { object: {} } }),
      });
      expect(res.statusCode).toBe(503);
    });
  });
});
