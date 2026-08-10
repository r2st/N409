import crypto from 'node:crypto';

/**
 * Stripe integration (remaining-gaps §3 #1 / §6 P0 #2), dependency-free:
 * Checkout Sessions via the form-encoded REST API and webhook verification
 * per https://stripe.com/docs/webhooks/signatures. The SDK would drag in a
 * lot for the two calls we make.
 */

export const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Which Stripe account a secret key addresses. Stripe encodes this in the key
 * itself (`sk_test_…` / `rk_test_…` vs `sk_live_…` / `rk_live_…`), which is the
 * only place it is knowable without a round trip.
 *
 * It matters because the two modes are indistinguishable *after* the key is
 * accepted. A test key opens a real Checkout page at a real Stripe URL, and
 * that page declines every card a client owns while accepting `4242…`. So the
 * failure mode of configuring one in production is not an error anybody sees:
 * it is a client following a "Pay now" button to a page their card cannot get
 * through, with nothing on either end saying why.
 *
 * `unknown` covers a key in neither shape — a malformed paste, or a prefix
 * Stripe has not issued yet. It is deliberately not folded into `live`: the
 * caller decides, and the decision differs (`configured` wants "not test",
 * a warning banner wants "definitely test").
 */
export type StripeKeyMode = 'test' | 'live' | 'unknown';

export function stripeKeyMode(secretKey: string | undefined | null): StripeKeyMode | null {
  if (!secretKey) return null;
  // Restricted keys (`rk_`) carry the same mode marker and are a perfectly
  // ordinary thing to deploy — a key scoped to Checkout and nothing else.
  if (/^[sr]k_test_/.test(secretKey)) return 'test';
  if (/^[sr]k_live_/.test(secretKey)) return 'live';
  return 'unknown';
}

/** Flattens {a: {b: 1}, c: [x]} into Stripe's a[b]=1&c[0]=x form encoding. */
export function encodeForm(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        parts.push(encodeForm({ [i]: v }, name));
      });
    } else if (typeof value === 'object') {
      parts.push(encodeForm(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export interface StripeSignature {
  timestamp: number;
  signatures: string[];
}

export function parseSignatureHeader(header: string): StripeSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k?.trim() === 't' && v) timestamp = Number(v);
    if (k?.trim() === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || !Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export const WEBHOOK_TOLERANCE_S = 300;

/** Constant-time check of `Stripe-Signature` over the RAW request body. */
export function verifyWebhookSignature(args: {
  payload: Buffer | string;
  header: string;
  secret: string;
  nowS?: number;
}): boolean {
  const parsed = parseSignatureHeader(args.header);
  if (!parsed) return false;
  const nowS = args.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - parsed.timestamp) > WEBHOOK_TOLERANCE_S) return false;

  const payload = typeof args.payload === 'string' ? args.payload : args.payload.toString('utf8');
  const expected = crypto
    .createHmac('sha256', args.secret)
    .update(`${parsed.timestamp}.${payload}`)
    .digest('hex');
  return parsed.signatures.some((sig) => {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface CheckoutSession {
  id: string;
  url: string;
  amount_total: number | null;
  payment_intent: string | null;
  [key: string]: unknown;
}

/**
 * Check that a 2xx Checkout body is actually a Checkout Session before the
 * caller treats it as one.
 *
 * Both creators used to assert the parsed JSON into this type and return it.
 * The two fields that matter are `id` — which is what the valuation row stores
 * to reconcile the webhook against — and `url`, which is where the browser is
 * sent. A 2xx whose body is not what we expect is rare but not impossible
 * (a proxy or WAF between us and Stripe answering with its own JSON is the
 * realistic one), and the asserted version turned that into a redirect to the
 * string `"undefined"` and a valuation holding a session id of `undefined`,
 * with nothing on either side saying the call had failed. Failing here makes
 * it the same handled error as an HTTP failure.
 */
function asCheckoutSession(json: Record<string, unknown>, status: number): CheckoutSession {
  const { id, url } = json;
  if (typeof id !== 'string' || id === '' || typeof url !== 'string' || url === '') {
    throw new StripeApiError('Stripe returned a Checkout Session without an id and url', status);
  }
  const amount = json.amount_total;
  const intent = json.payment_intent;
  return {
    ...json,
    id,
    url,
    amount_total: typeof amount === 'number' ? amount : null,
    payment_intent: typeof intent === 'string' ? intent : null,
  };
}

export async function createCheckoutSession(
  secretKey: string,
  args: {
    valuationId: string;
    productName: string;
    amountCents: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
  },
): Promise<CheckoutSession> {
  const body = encodeForm({
    mode: 'payment',
    client_reference_id: args.valuationId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    customer_email: args.customerEmail,
    metadata: { valuation_id: args.valuationId },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: args.currency.toLowerCase(),
          unit_amount: args.amountCents,
          product_data: { name: args.productName },
        },
      },
    ],
  });
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(String(err.message ?? `Stripe HTTP ${res.status}`), res.status);
  }
  return asCheckoutSession(json, res.status);
}

/**
 * Recurring subscription Checkout Session (feature 7). Uses inline recurring
 * price_data so no pre-created Stripe Price is required; the plan tier + user
 * are carried in metadata for the webhook to reconcile.
 */
export async function createSubscriptionCheckoutSession(
  secretKey: string,
  args: {
    userId: string;
    planTier: string;
    planName: string;
    amountCents: number;
    currency: string;
    interval: 'month' | 'year';
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
  },
): Promise<CheckoutSession> {
  const body = encodeForm({
    mode: 'subscription',
    client_reference_id: args.userId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    customer_email: args.customerEmail,
    metadata: { user_id: args.userId, plan_tier: args.planTier },
    subscription_data: { metadata: { user_id: args.userId, plan_tier: args.planTier } },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: args.currency.toLowerCase(),
          unit_amount: args.amountCents,
          recurring: { interval: args.interval },
          product_data: { name: args.planName },
        },
      },
    ],
  });
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(String(err.message ?? `Stripe HTTP ${res.status}`), res.status);
  }
  return asCheckoutSession(json, res.status);
}

/**
 * Stripe-hosted Billing Portal session (feature 7, self-serve).
 *
 * Cancelling, swapping a card, or downloading an invoice all mean handling
 * payment details, which is exactly the work Stripe's own portal exists to keep
 * out of this codebase — so this is a redirect, not a set of endpoints. Without
 * it a subscriber's only route to cancelling was to email support, and an
 * expired card meant a subscription that silently lapsed.
 *
 * The returned URL is single-use and short-lived, so it is fetched per click
 * rather than stored.
 */
export async function createBillingPortalSession(
  secretKey: string,
  args: { customerId: string; returnUrl: string },
): Promise<{ id: string; url: string }> {
  const res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encodeForm({ customer: args.customerId, return_url: args.returnUrl }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(String(err.message ?? `Stripe HTTP ${res.status}`), res.status);
  }
  if (typeof json.url !== 'string') {
    throw new StripeApiError('Stripe returned a billing portal session with no URL', 502);
  }
  return { id: String(json.id ?? ''), url: json.url };
}

export interface ChargeReceipt {
  chargeId: string | null;
  receiptUrl: string | null;
}

/**
 * `checkout.session.completed` doesn't carry the receipt — that lives on the
 * charge, so we resolve it from the payment intent with the charge expanded.
 */
export async function retrieveReceipt(secretKey: string, paymentIntentId: string): Promise<ChargeReceipt> {
  const res = await fetch(
    `${STRIPE_API}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(String(err.message ?? `Stripe HTTP ${res.status}`), res.status);
  }
  const charge = (json.latest_charge ?? {}) as Record<string, unknown>;
  return {
    chargeId: typeof charge.id === 'string' ? charge.id : null,
    receiptUrl: typeof charge.receipt_url === 'string' ? charge.receipt_url : null,
  };
}
