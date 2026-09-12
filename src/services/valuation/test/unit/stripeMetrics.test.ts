import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  createBillingPortalSession,
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  expireCheckoutSession,
  retrieveReceipt,
} from '../../src/payments/stripe.js';
import {
  recordStripeRequest,
  registerStripeMetrics,
  resetStripeMetrics,
  stripeOutcomeForStatus,
} from '../../src/payments/stripeMetrics.js';

/**
 * The wire that moves money, on `/metrics` (R450, methodology M11).
 *
 * Every other dependency this process dials has a request/outcome pair on the
 * scrape endpoint. Stripe had none: it is not an internal service, so it goes
 * through neither the breaker nor `upstream_requests_total`, and the only
 * record of a call was the `warn` line a route wrote when one failed — which
 * nothing on the box consumes. A Checkout creator answering 5xx for an hour,
 * or a receipt fetch that has taken fifteen seconds since a deploy, was
 * invisible to every rule this deployment can hold.
 */

const args = {
  valuationId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  productName: '409A valuation — Acme Robotics',
  amountCents: 119_000,
  currency: 'USD',
  successUrl: 'https://app.example.com/payment/success',
  cancelUrl: 'https://app.example.com/payment/cancel',
};

const subscriptionArgs = {
  userId: '01HYYYYYYYYYYYYYYYYYYYYYYY',
  planTier: 'annual_retainer',
  planName: 'Annual retainer',
  amountCents: 2_000_000,
  currency: 'usd',
  interval: 'year' as const,
  successUrl: 'https://app.example.com/settings?billing=success',
  cancelUrl: 'https://app.example.com/settings?billing=canceled',
};

const session = (status = 200) =>
  new Response(JSON.stringify({ id: 'cs_x', url: 'https://checkout.stripe.com/c/x' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const unreachable = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.stripe.com'), { code: 'ENOTFOUND' }),
  });

const timedOut = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

function registered(): MetricsRegistry {
  const registry = new MetricsRegistry();
  registerStripeMetrics(registry);
  return registry;
}

describe('the Stripe request counter', () => {
  afterEach(() => {
    resetStripeMetrics();
    vi.restoreAllMocks();
  });

  it('labels every one of the five operations, so a new call site cannot go dark unnoticed', async () => {
    const registry = registered();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(session()));

    await createCheckoutSession('sk_test', args);
    await createSubscriptionCheckoutSession('sk_test', subscriptionArgs);
    await createBillingPortalSession('sk_test', { customerId: 'cus_x', returnUrl: 'https://app.example.com' });
    await expireCheckoutSession('sk_test', 'cs_x');
    await retrieveReceipt('sk_test', 'pi_x');

    const text = registry.render();
    for (const op of [
      'checkout_session',
      'subscription_checkout',
      'billing_portal',
      'expire_checkout',
      'retrieve_receipt',
    ]) {
      expect(text).toContain(`stripe_requests_total{operation="${op}",outcome="ok"} 1`);
      expect(text).toContain(`stripe_request_duration_seconds_count{operation="${op}"} 1`);
    }
  });

  it('separates our request being refused from Stripe being unwell', async () => {
    // A run of 4xx is a rotated key or a payload we built wrong; a run of 5xx
    // is Stripe. Only one of them is worth waking somebody for, and a single
    // error rate cannot tell them apart.
    const registry = registered();
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid API Key provided', type: 'invalid_request_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    spy.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));

    await createCheckoutSession('sk_test', args).catch(() => undefined);
    await createCheckoutSession('sk_test', args).catch(() => undefined);

    const text = registry.render();
    expect(text).toContain('stripe_requests_total{operation="checkout_session",outcome="rejected"} 1');
    expect(text).toContain('stripe_requests_total{operation="checkout_session",outcome="failed"} 1');
  });

  it('counts the calls that never got an answer, by which clock ran out', async () => {
    // These are the calls R175 had to teach the routes to handle at all; they
    // reject before any status exists, so a counter keyed on `res.status`
    // alone would miss exactly the outage it is for.
    const registry = registered();
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockRejectedValueOnce(unreachable());
    spy.mockRejectedValueOnce(timedOut());

    await retrieveReceipt('sk_test', 'pi_x').catch(() => undefined);
    await retrieveReceipt('sk_test', 'pi_x').catch(() => undefined);

    const text = registry.render();
    expect(text).toContain('stripe_requests_total{operation="retrieve_receipt",outcome="unreachable"} 1');
    expect(text).toContain('stripe_requests_total{operation="retrieve_receipt",outcome="timeout"} 1');
    // Both are still an attempt whose wall time is worth knowing: a timeout is
    // twenty seconds of a handler's life.
    expect(text).toContain('stripe_request_duration_seconds_count{operation="retrieve_receipt"} 2');
  });

  it('classifies a status the same way the error type does', () => {
    expect(stripeOutcomeForStatus(200)).toBe('ok');
    expect(stripeOutcomeForStatus(201)).toBe('ok');
    expect(stripeOutcomeForStatus(400)).toBe('rejected');
    expect(stripeOutcomeForStatus(429)).toBe('rejected');
    expect(stripeOutcomeForStatus(500)).toBe('failed');
    expect(stripeOutcomeForStatus(503)).toBe('failed');
  });

  it('reaches the deadline in its buckets', () => {
    // `stripe.ts` gives every call twenty seconds. The shared default buckets
    // stop at ten, so a call that used most of its budget — the one an operator
    // is asking about — would be indistinguishable from one that never
    // answered.
    const registry = registered();
    recordStripeRequest('checkout_session', 'ok', 15_500);
    const text = registry.render();
    expect(text).toContain('stripe_request_duration_seconds_bucket{operation="checkout_session",le="15"} 0');
    expect(text).toContain('stripe_request_duration_seconds_bucket{operation="checkout_session",le="20"} 1');
  });

  it('is inert before registration rather than throwing', async () => {
    // Every unit test that exercises a payments route without building the
    // app reaches `stripeFetch` with no registry anywhere.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(session()));
    await expect(expireCheckoutSession('sk_test', 'cs_x')).resolves.toBe(true);
  });

  it('has a rule reading it, so the series is consumed and not merely published', () => {
    // The second M11 question. `email_send_attempts_total` sat unread for
    // eleven rounds; a counter nothing alerts on is a dashboard somebody has
    // to happen to open.
    const alerts = readFileSync(new URL('../../../../../infra/monitoring/alerts.yml', import.meta.url), 'utf8');
    expect(alerts).toContain('stripe_requests_total{outcome!="ok"}');
    expect(alerts).toContain('stripe_request_duration_seconds_bucket');
    // The runbook names the three lines the routes actually write.
    expect(alerts).toContain("grep -E 'stripe (checkout session|billing portal session|receipt lookup) failed'");
  });

  it('is registered on the app the scrape endpoint serves', () => {
    // A module that exists and is never wired is the R444 finding with a
    // different name on it.
    const app = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    expect(app).toMatch(/registerStripeMetrics\(metricsRegistry\)/);
  });
});
