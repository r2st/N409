import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBillingPortalSession,
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  encodeForm,
  parseSignatureHeader,
  retrieveReceipt,
  stripeKeyMode,
  StripeApiError,
  verifyWebhookSignature,
} from '../../src/payments/stripe.js';
import type { Principal } from '../../src/auth/rbac.js';
import {
  checkoutAvailableTo,
  isSettled,
  priceForKind,
  DEFAULT_PRICE_CENTS,
  FALLBACK_PRICE_CENTS,
} from '../../src/routes/payments.js';

function sign(payload: string, secret: string, timestamp: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

describe('Stripe form encoding', () => {
  it('flattens nested objects and arrays the way Stripe expects', () => {
    const encoded = encodeForm({
      mode: 'payment',
      metadata: { valuation_id: 'abc' },
      line_items: [{ quantity: 1, price_data: { unit_amount: 119000 } }],
      skipped: undefined,
    });
    expect(encoded).toContain('mode=payment');
    expect(encoded).toContain(encodeURIComponent('metadata[valuation_id]') + '=abc');
    expect(encoded).toContain(encodeURIComponent('line_items[0][quantity]') + '=1');
    expect(encoded).toContain(encodeURIComponent('line_items[0][price_data][unit_amount]') + '=119000');
    expect(encoded).not.toContain('skipped');
  });
});

describe('Stripe webhook signature', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

  it('parses the Stripe-Signature header', () => {
    const parsed = parseSignatureHeader('t=1700000000,v1=abc,v0=legacy');
    expect(parsed).toEqual({ timestamp: 1700000000, signatures: ['abc'] });
    expect(parseSignatureHeader('garbage')).toBeNull();
  });

  it('accepts a valid signature within tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = sign(payload, secret, now);
    expect(verifyWebhookSignature({ payload, header, secret })).toBe(true);
    expect(verifyWebhookSignature({ payload: Buffer.from(payload), header, secret })).toBe(true);
  });

  it('rejects a bad secret, a tampered payload, and a stale timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = sign(payload, secret, now);
    expect(verifyWebhookSignature({ payload, header, secret: 'whsec_other' })).toBe(false);
    expect(verifyWebhookSignature({ payload: payload + 'x', header, secret })).toBe(false);
    const stale = sign(payload, secret, now - 3600);
    expect(verifyWebhookSignature({ payload, header: stale, secret })).toBe(false);
  });
});

describe('retrieveReceipt', () => {
  afterEach(() => vi.restoreAllMocks());

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('expands the latest charge and returns its id and receipt URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        id: 'pi_1',
        latest_charge: { id: 'ch_1', receipt_url: 'https://pay.stripe.com/receipts/r1' },
      }),
    );
    await expect(retrieveReceipt('sk_test', 'pi_1')).resolves.toEqual({
      chargeId: 'ch_1',
      receiptUrl: 'https://pay.stripe.com/receipts/r1',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.stripe.com/v1/payment_intents/pi_1?expand[]=latest_charge');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
  });

  it('tolerates a missing charge (nulls, not a crash)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'pi_1' }));
    await expect(retrieveReceipt('sk_test', 'pi_1')).resolves.toEqual({
      chargeId: null,
      receiptUrl: null,
    });
  });

  it('surfaces Stripe errors as StripeApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'No such payment_intent' } }, 404),
    );
    await expect(retrieveReceipt('sk_test', 'pi_missing')).rejects.toThrow(StripeApiError);
  });
});

describe('checkout pricing', () => {
  it('prices known kinds and falls back for the rest', () => {
    expect(priceForKind('409a')).toBe(DEFAULT_PRICE_CENTS['409a']);
    expect(priceForKind('esop')).toBe(FALLBACK_PRICE_CENTS);
  });
});

/**
 * The gate deciding whether a completed Checkout Session means the money is in.
 * Delayed-notification methods complete the session first and settle later; the
 * webhook must not release a valuation until they do.
 */
describe('settlement gate', () => {
  it('treats a paid session as settled', () => {
    expect(isSettled('paid')).toBe(true);
  });

  it('treats a fully-discounted session as settled', () => {
    expect(isSettled('no_payment_required')).toBe(true);
  });

  it('withholds on the one status that means the debit has not cleared', () => {
    expect(isSettled('unpaid')).toBe(false);
  });

  it('settles when the field is absent, rather than withholding a paid-for report', () => {
    // Only current Checkout Sessions carry payment_status. Guessing "unpaid"
    // for anything that omits it would strand real card payments — the more
    // damaging direction to be wrong in, since `unpaid` is the only value
    // Stripe follows up on with an async event anyway.
    expect(isSettled(undefined)).toBe(true);
    expect(isSettled(null)).toBe(true);
    expect(isSettled('')).toBe(true);
  });
});

/**
 * Billing portal sessions (self-serve cancel / card update). The URL is the
 * whole point of the call, so a response without one is a failure rather than
 * a redirect to `undefined`.
 */
describe('billing portal session', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the customer and return URL, and returns the session URL', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(portalResponse({ id: 'bps_1', url: 'https://billing.stripe.com/s/1' }));

    const session = await createBillingPortalSession('sk_test', {
      customerId: 'cus_1',
      returnUrl: 'https://app.example.com/billing',
    });

    expect(session).toEqual({ id: 'bps_1', url: 'https://billing.stripe.com/s/1' });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(String(init?.body)).toContain('customer=cus_1');
    expect(String(init?.body)).toContain(
      `return_url=${encodeURIComponent('https://app.example.com/billing')}`,
    );
  });

  it('raises a StripeApiError carrying Stripe’s own message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      portalResponse({ error: { message: 'No configuration provided' } }, 400),
    );
    await expect(
      createBillingPortalSession('sk_test', { customerId: 'cus_1', returnUrl: 'https://x/billing' }),
    ).rejects.toThrow('No configuration provided');
  });

  it('refuses a 200 with no URL rather than redirecting nowhere', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(portalResponse({ id: 'bps_2' }));
    await expect(
      createBillingPortalSession('sk_test', { customerId: 'cus_1', returnUrl: 'https://x/billing' }),
    ).rejects.toThrow(StripeApiError);
  });
});

const portalResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The two Checkout Session builders — the calls that decide what a customer is
 * actually charged. Untested until now, which is an odd thing to leave for the
 * only code in the repo that names a price to Stripe.
 */
describe('checkout sessions', () => {
  afterEach(() => vi.restoreAllMocks());

  const args = {
    valuationId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    productName: '409A valuation — Acme Robotics',
    amountCents: 119_000,
    currency: 'USD',
    successUrl: 'https://app.example.com/payment/success',
    cancelUrl: 'https://app.example.com/payment/cancel',
  };

  it('sends a one-off payment session with the price and the valuation reference', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(portalResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/1' }));

    const session = await createCheckoutSession('sk_test', args);
    expect(session.id).toBe('cs_1');

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.stripe.com/v1/checkout/sessions');
    const body = decodeURIComponent(String(init?.body));
    expect(body).toContain('mode=payment');
    // The amount Stripe charges, and the currency lowercased as Stripe requires
    // — an uppercase currency is rejected outright.
    expect(body).toContain('line_items[0][price_data][unit_amount]=119000');
    expect(body).toContain('line_items[0][price_data][currency]=usd');
    // Two independent ways back to the valuation, because the webhook reads
    // metadata and the success redirect reads client_reference_id.
    expect(body).toContain(`client_reference_id=${args.valuationId}`);
    expect(body).toContain(`metadata[valuation_id]=${args.valuationId}`);
  });

  it('omits a customer email that was never supplied', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(portalResponse({ id: 'cs_2', url: 'https://checkout.stripe.com/c/2' }));
    await createCheckoutSession('sk_test', args);
    expect(String(spy.mock.calls[0]![1]?.body)).not.toContain('customer_email');
  });

  it('sends a subscription session as recurring, with the tier on the subscription itself', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(portalResponse({ id: 'cs_sub', url: 'https://checkout.stripe.com/c/sub' }));

    await createSubscriptionCheckoutSession('sk_test', {
      userId: '01HYYYYYYYYYYYYYYYYYYYYYYY',
      planTier: 'annual_retainer',
      planName: 'Annual retainer',
      amountCents: 2_000_000,
      currency: 'usd',
      interval: 'year',
      successUrl: 'https://app.example.com/settings?billing=success',
      cancelUrl: 'https://app.example.com/settings?billing=canceled',
      customerEmail: 'cfo@acme.example.com',
    });

    const body = decodeURIComponent(String(spy.mock.calls[0]![1]?.body));
    expect(body).toContain('mode=subscription');
    expect(body).toContain('line_items[0][price_data][recurring][interval]=year');
    // subscription_data.metadata, not just session metadata: session metadata is
    // not carried onto customer.subscription.* events, and that is where the
    // webhook resolves the user and tier from.
    expect(body).toContain('subscription_data[metadata][user_id]=01HYYYYYYYYYYYYYYYYYYYYYYY');
    expect(body).toContain('subscription_data[metadata][plan_tier]=annual_retainer');
    expect(body).toContain('customer_email=cfo@acme.example.com');
  });

  it('surfaces a declined session as StripeApiError with Stripe’s message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      portalResponse({ error: { message: 'Amount must be at least $0.50 usd' } }, 400),
    );
    await expect(createCheckoutSession('sk_test', { ...args, amountCents: 10 })).rejects.toThrow(
      'Amount must be at least $0.50 usd',
    );
  });

  it('does not mistake a non-JSON error body for success', async () => {
    // Stripe 5xx pages are HTML. `.json()` rejects; the catch must not turn
    // that into an ok-looking session with an undefined URL.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    await expect(createCheckoutSession('sk_test', args)).rejects.toThrow(StripeApiError);
  });

  /**
   * A 200 whose body is not a Checkout Session.
   *
   * This is the failure a proxy or WAF between us and Stripe produces: a
   * well-formed JSON body, an ok status, and none of the fields the caller is
   * about to use. The session used to be returned as-is, which meant the
   * browser was redirected to the string `undefined` and the valuation stored
   * an id of `undefined` for the webhook to reconcile against — with nothing on
   * either side recording that the call had failed.
   */
  it('refuses a 200 that carries no session id or URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(portalResponse({ object: 'error' }));
    await expect(createCheckoutSession('sk_test', args)).rejects.toThrow(/without an id and url/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(portalResponse({ id: 'cs_1', url: '' }));
    await expect(createCheckoutSession('sk_test', args)).rejects.toThrow(StripeApiError);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(portalResponse({ id: '', url: 'https://x' }));
    await expect(
      createSubscriptionCheckoutSession('sk_test', {
        userId: '01HYYYYYYYYYYYYYYYYYYYYYYY',
        planTier: 'annual_retainer',
        planName: 'Annual retainer',
        amountCents: 2_000_000,
        currency: 'usd',
        interval: 'month',
        successUrl: 'https://x/ok',
        cancelUrl: 'https://x/no',
      }),
    ).rejects.toThrow(StripeApiError);
  });

  it('normalises the two optional fields rather than passing them through', async () => {
    // `amount_total` is nullable on a Stripe session and `payment_intent` is
    // absent on a subscription; both are declared non-optional on the type, so
    // a caller reading them is entitled to a number-or-null rather than to
    // whatever the JSON happened to hold.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      portalResponse({
        id: 'cs_9',
        url: 'https://checkout.stripe.com/c/9',
        amount_total: '119000',
        payment_intent: { id: 'pi_expanded' },
        livemode: false,
      }),
    );
    const session = await createCheckoutSession('sk_test', args);
    expect(session.amount_total).toBeNull();
    expect(session.payment_intent).toBeNull();
    // Everything else Stripe sent survives — the type carries an index
    // signature precisely so a caller can reach a field this code has no
    // opinion about.
    expect(session.livemode).toBe(false);
  });
});

/**
 * Test-mode detection, and the one rule it exists to enforce.
 *
 * A Stripe test key is not a broken key — it is a fully working key pointed at
 * an account with no money in it. It opens a real Checkout page on Stripe's own
 * domain, renders a real card form, and declines every card a client actually
 * holds while accepting `4242 4242 4242 4242`. Nothing on either end reports
 * this: the client reads a decline they will blame on their bank, and our
 * records show a session that quietly expired.
 *
 * So the mode is read off the key and the checkout is withheld from clients
 * while it says `test`, which lands them on the same honest invoice fallback a
 * deployment with no key at all gives them.
 */
describe('Stripe key mode', () => {
  const ops = (): Principal => ({ id: '01HOPS000000000000000000', roles: ['admin'], partnerId: null });
  const client = (): Principal => ({
    id: '01HCLI000000000000000000',
    roles: ['valuation_user'],
    partnerId: null,
  });

  it('reads the mode off the key prefix, which is the only place it is written', () => {
    expect(stripeKeyMode('sk_test_51Abc')).toBe('test');
    expect(stripeKeyMode('sk_live_51Abc')).toBe('live');
  });

  it('reads a restricted key too', () => {
    // `rk_` keys are an ordinary thing to deploy — one scoped to Checkout and
    // nothing else — and they carry the same mode marker.
    expect(stripeKeyMode('rk_test_51Abc')).toBe('test');
    expect(stripeKeyMode('rk_live_51Abc')).toBe('live');
  });

  it('says nothing at all when there is no key', () => {
    // null, not 'unknown': "no key" and "a key I cannot classify" lead to
    // opposite decisions below.
    expect(stripeKeyMode(undefined)).toBeNull();
    expect(stripeKeyMode('')).toBeNull();
  });

  it('calls an unrecognised prefix unknown rather than guessing', () => {
    expect(stripeKeyMode('pk_test_51Abc')).toBe('unknown');
    expect(stripeKeyMode('whsec_nonsense')).toBe('unknown');
  });

  describe('who may be offered a checkout', () => {
    it('nobody, when no key is configured', () => {
      expect(checkoutAvailableTo(undefined, ops())).toBe(false);
      expect(checkoutAvailableTo(undefined, client())).toBe(false);
    });

    it('everybody, on a live key', () => {
      expect(checkoutAvailableTo('sk_live_51Abc', ops())).toBe(true);
      expect(checkoutAvailableTo('sk_live_51Abc', client())).toBe(true);
    });

    it('ops only, on a test key', () => {
      // The whole point. Ops are exercising the pipeline deliberately and know
      // what a test key is; a client is trying to buy a report.
      expect(checkoutAvailableTo('sk_test_51Abc', ops())).toBe(true);
      expect(checkoutAvailableTo('sk_test_51Abc', client())).toBe(false);
    });

    it('everybody, on a key it cannot classify', () => {
      // A malformed key fails loudly at the first API call, which is a better
      // outcome than silently withholding checkout from every paying client
      // because Stripe issued a prefix this regex predates.
      expect(checkoutAvailableTo('sk_something_new', client())).toBe(true);
    });
  });
});
