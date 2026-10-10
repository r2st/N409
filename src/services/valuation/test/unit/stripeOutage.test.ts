import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBillingPortalSession,
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  expireCheckoutSession,
  retrieveReceipt,
  StripeApiError,
} from '../../src/payments/stripe.js';
import { stripeProblem } from '../../src/routes/payments.js';

/**
 * Stripe being *down*, as opposed to Stripe saying no (round 175, methodology
 * M5).
 *
 * The suite beside this one covers every way Stripe can refuse: a 400 with its
 * own message, an HTML 5xx page, a 200 that is not a session. All of those
 * arrive as an HTTP response, and the module has always turned them into a
 * `StripeApiError` that the routes catch.
 *
 * The failures below never produce a response at all — DNS, a refused
 * connection, a TLS failure, a socket dropped mid-body, and our own 20-second
 * deadline. Node's `fetch` rejects those with a `TypeError` or a
 * `TimeoutError`, neither of which is a `StripeApiError`, so all five walked
 * past three `catch (err) { if (err instanceof StripeApiError) … }` blocks and
 * out through the generic handler as an empty `500`. On the "Pay now" button.
 *
 * What the assertions are about is the two things the person clicking it needs
 * and the 500 could not say: that this is Stripe and not their request, and
 * that no money moved.
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

/** What `fetch` rejects with when the host cannot be reached. */
const unreachable = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.stripe.com'), { code: 'ENOTFOUND' }),
  });

/** What `AbortSignal.timeout` rejects with when the budget runs out. */
const timedOut = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });

describe('Stripe unreachable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a refused connection as a Stripe error, not a transport one', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(unreachable());
    const err = await createCheckoutSession('sk_test', args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeApiError);
    expect((err as StripeApiError).unreachable).toBe(true);
    expect((err as StripeApiError).status).toBe(503);
  });

  it('keeps the transport wording for the log and out of the message', async () => {
    // `getaddrinfo ENOTFOUND api.stripe.com` names a host and a syscall. The
    // route forwards `message` to the client, so the sentence has to be one we
    // wrote — and the real cause has to survive somewhere, or the log says
    // nothing more than the client does.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(unreachable());
    const err = (await createCheckoutSession('sk_test', args).catch((e: unknown) => e)) as StripeApiError;
    expect(err.message).not.toMatch(/ENOTFOUND|getaddrinfo|api\.stripe\.com/);
    expect(String((err.cause as { cause?: Error })?.cause?.message)).toContain('ENOTFOUND');
  });

  it('says whose clock ran out when the deadline fires', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timedOut());
    const err = (await createCheckoutSession('sk_test', args).catch((e: unknown) => e)) as StripeApiError;
    expect(err).toBeInstanceOf(StripeApiError);
    expect(err.unreachable).toBe(true);
    // 504 rather than 503: the request may well have been accepted, and a
    // Checkout Session may exist at Stripe that we never learned the id of.
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/did not respond within 20s/);
  });

  it('runs every Stripe call under the same deadline', async () => {
    // A call added without one is a handler parked forever: node's `fetch` has
    // no default timeout. Asserted per call site rather than once, because the
    // one that matters is whichever one somebody adds next.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      // A fresh Response per call: a body stream is consumed once, so one
      // shared instance answers the first call and is empty for the rest.
      .mockImplementation(
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ id: 'x', url: 'https://checkout.stripe.com/c/x' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ) as ReturnType<typeof fetch>,
      );
    await createCheckoutSession('sk_test', args);
    await createSubscriptionCheckoutSession('sk_test', subscriptionArgs);
    await createBillingPortalSession('sk_test', { customerId: 'cus_1', returnUrl: 'https://x/billing' });
    await expireCheckoutSession('sk_test', 'cs_1');
    await retrieveReceipt('sk_test', 'pi_1');
    expect(spy.mock.calls.length).toBe(5);
    for (const [, init] of spy.mock.calls) {
      expect(init?.signal, 'a Stripe call with no deadline').toBeInstanceOf(AbortSignal);
    }
  });

  it('reaches the calls that only read', async () => {
    // Both of these sit on a webhook path, where a rejection that is not a
    // `StripeApiError` is an unhandled one.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(unreachable());
    await expect(retrieveReceipt('sk_test', 'pi_1')).rejects.toBeInstanceOf(StripeApiError);
    await expect(expireCheckoutSession('sk_test', 'cs_1')).rejects.toBeInstanceOf(StripeApiError);
    await expect(
      createBillingPortalSession('sk_test', { customerId: 'cus_1', returnUrl: 'https://x/billing' }),
    ).rejects.toBeInstanceOf(StripeApiError);
    await expect(createSubscriptionCheckoutSession('sk_test', subscriptionArgs)).rejects.toBeInstanceOf(
      StripeApiError,
    );
  });

  it('does not describe an abandoned body as a malformed session', async () => {
    // `AbortSignal.timeout` aborts the body stream too, so a response that
    // arrives and then stalls rejects at the `.json()`. That used to be
    // swallowed into `{}` under a 200, and reported as "Stripe returned a
    // Checkout Session without an id and url" — Stripe blamed for our deadline.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(timedOut()),
    } as unknown as Response);
    const err = (await createCheckoutSession('sk_test', args).catch((e: unknown) => e)) as StripeApiError;
    expect(err.unreachable).toBe(true);
    expect(err.message).toMatch(/did not respond/);
  });

  it('drains the body on the call that only checks the status', async () => {
    // `expireCheckoutSession` reads `res.ok` and nothing else. Without
    // draining the body the underlying TCP connection is held open until the
    // 20-second abort signal fires or the GC collects the Response — up to
    // 20 seconds of a connection to Stripe that nobody needs.
    let bodyCancelled = false;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        cancel: () => {
          bodyCancelled = true;
          return Promise.resolve();
        },
      },
    } as unknown as Response);
    const ok = await expireCheckoutSession('sk_test', 'cs_1');
    expect(ok).toBe(true);
    expect(bodyCancelled, 'body stream was not drained').toBe(true);
  });

  it('still reads a non-JSON error body as the status it carried', async () => {
    // The behaviour the `{}` fallback was written for, unchanged: an HTML page
    // under a 4xx/5xx is answered by its status, not by a parse error.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const err = (await createCheckoutSession('sk_test', args).catch((e: unknown) => e)) as StripeApiError;
    expect(err.unreachable).toBe(false);
    expect(err.status).toBe(502);
  });
});

describe('what the caller is told', () => {
  it('answers an outage with a sentence about money, not about Stripe', () => {
    const problem = stripeProblem(new StripeApiError('Stripe could not be reached', 503, true));
    expect(problem.status).toBe(502);
    expect(problem.type).toBe('urn:n409:problem:stripe');
    // The two facts a person clicking "Pay now" needs and a bare 500 has never
    // carried: nothing was charged, and waiting is the right response.
    expect(problem.detail).toMatch(/Nothing has been charged/);
    expect(problem.detail).toMatch(/try again/i);
  });

  it('passes a refusal through in Stripe’s own words', () => {
    // The other half: "Your card was declined" is the whole answer, and
    // replacing it with our sentence would be a worse body, not a safer one.
    const problem = stripeProblem(new StripeApiError('Your card was declined.', 402));
    expect(problem.status).toBe(502);
    expect(problem.detail).toContain('Your card was declined.');
  });
});
