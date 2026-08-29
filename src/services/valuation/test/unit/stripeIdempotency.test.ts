import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBillingPortalSession,
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  expireCheckoutSession,
  idempotencyKeyFor,
  IDEMPOTENCY_WINDOW_MS,
} from '../../src/payments/stripe.js';

/**
 * Retrying a Stripe POST (round 203, methodology M5).
 *
 * Everything downstream of a Checkout Session is guarded. `findLiveCheckout`
 * hands back the session already opened for an engagement, the webhook ledger
 * refuses a redelivered event, `recordRefund` writes a running total. All of
 * them read a row in *our* database, and all of them are therefore blind to the
 * one window where the money is decided and the row does not exist yet: between
 * Stripe accepting `POST /checkout/sessions` and `createPayment` storing what
 * came back.
 *
 * Three ordinary things land in that window. A double-click, where two requests
 * run concurrently and each finds no live row. A 500 from our own storage after
 * Stripe has already opened the session. And the expensive one — our 20-second
 * deadline firing on a request Stripe had accepted, which the module itself
 * describes as "the request may well have been accepted and a session may
 * exist", answered to the client as "try again in a moment".
 *
 * Each of those left a second live Checkout URL at Stripe that nothing here
 * knew about, for the same piece of work, payable for 24 hours. The comment on
 * `expireCheckoutSession` has always named the consequence: "Two of them for one
 * engagement, at two different prices, is a double charge that no guard
 * downstream can undo."
 *
 * An `Idempotency-Key` is the only guard that can see into that window, because
 * it is the only one Stripe evaluates rather than us.
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

const session = () =>
  Promise.resolve(
    new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as ReturnType<typeof fetch>;

const headerOf = (call: [unknown, RequestInit?] | undefined): string | undefined =>
  (call?.[1]?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];

describe('idempotencyKeyFor', () => {
  it('is the same key for the same body inside the window', () => {
    const t = 1_772_000_000_000;
    expect(idempotencyKeyFor('checkout', 'a=1', t)).toBe(
      idempotencyKeyFor('checkout', 'a=1', t + IDEMPOTENCY_WINDOW_MS / 2),
    );
  });

  it('is a different key once the window has passed', () => {
    // The bound that keeps a key off Stripe's 24-hour retention boundary — see
    // IDEMPOTENCY_WINDOW_MS. A key stable for a whole day could answer the
    // first click after a session expires with the expired session.
    const t = Math.floor(1_772_000_000_000 / IDEMPOTENCY_WINDOW_MS) * IDEMPOTENCY_WINDOW_MS;
    expect(idempotencyKeyFor('checkout', 'a=1', t)).not.toBe(
      idempotencyKeyFor('checkout', 'a=1', t + IDEMPOTENCY_WINDOW_MS),
    );
  });

  it('is a different key for a different body', () => {
    const t = 1_772_000_000_000;
    expect(idempotencyKeyFor('checkout', 'amount=119000', t)).not.toBe(
      idempotencyKeyFor('checkout', 'amount=219000', t),
    );
  });

  it('separates the two Checkout creators', () => {
    const t = 1_772_000_000_000;
    expect(idempotencyKeyFor('checkout', 'a=1', t)).not.toBe(idempotencyKeyFor('subscribe', 'a=1', t));
  });

  it('stays inside the 255 characters Stripe allows', () => {
    expect(idempotencyKeyFor('checkout', 'x'.repeat(10_000)).length).toBeLessThanOrEqual(255);
  });
});

describe('Stripe Checkout retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the same key when a timed-out engagement checkout is retried', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T10:00:00Z'));
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(session);
    await createCheckoutSession('sk_test', args);
    // The client presses Pay again after being told to try again in a moment.
    vi.setSystemTime(new Date('2026-08-30T10:00:25Z'));
    await createCheckoutSession('sk_test', args);
    expect(headerOf(spy.mock.calls[0] as never)).toBeDefined();
    expect(headerOf(spy.mock.calls[1] as never)).toBe(headerOf(spy.mock.calls[0] as never));
  });

  it('sends a different key once the quote changes', async () => {
    // Ticking express is a different request, and Stripe refuses a key reused
    // with different parameters — so this has to change, not merely be allowed
    // to.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T10:00:00Z'));
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(session);
    await createCheckoutSession('sk_test', args);
    await createCheckoutSession('sk_test', { ...args, amountCents: 149_000 });
    expect(headerOf(spy.mock.calls[1] as never)).not.toBe(headerOf(spy.mock.calls[0] as never));
  });

  it('covers the one field the quote does not carry', async () => {
    // The product line contains the company name, which the engagement's quote
    // does not. A key built from the quote by hand would be reused against a
    // renamed company and Stripe would reject the whole call.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T10:00:00Z'));
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(session);
    await createCheckoutSession('sk_test', args);
    await createCheckoutSession('sk_test', { ...args, productName: '409A valuation — Acme Robotics Inc.' });
    expect(headerOf(spy.mock.calls[1] as never)).not.toBe(headerOf(spy.mock.calls[0] as never));
  });

  it('sends the same key when a subscription checkout is retried', async () => {
    // The subscribe route has no `findLiveCheckout` equivalent at all: two
    // clicks are two subscription Checkout Sessions, and a customer who pays
    // both is billed on two schedules.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T10:00:00Z'));
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(session);
    await createSubscriptionCheckoutSession('sk_test', subscriptionArgs);
    vi.setSystemTime(new Date('2026-08-30T10:00:25Z'));
    await createSubscriptionCheckoutSession('sk_test', subscriptionArgs);
    expect(headerOf(spy.mock.calls[0] as never)).toBeDefined();
    expect(headerOf(spy.mock.calls[1] as never)).toBe(headerOf(spy.mock.calls[0] as never));
  });

  it('leaves the portal and expire calls keyless, deliberately', async () => {
    // A portal URL is single-use, so replaying the first answer hands the
    // second click a spent link; an expire refused at 10:00 must be allowed to
    // succeed at 10:30. Both are asserted so that adding a key to either is a
    // decision somebody makes rather than a sweep.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(session);
    await createBillingPortalSession('sk_test', { customerId: 'cus_1', returnUrl: 'https://x/billing' });
    await expireCheckoutSession('sk_test', 'cs_1');
    expect(headerOf(spy.mock.calls[0] as never)).toBeUndefined();
    expect(headerOf(spy.mock.calls[1] as never)).toBeUndefined();
  });
});
