import crypto from 'node:crypto';

/**
 * Stripe integration (remaining-gaps §3 #1 / §6 P0 #2), dependency-free:
 * Checkout Sessions via the form-encoded REST API and webhook verification
 * per https://stripe.com/docs/webhooks/signatures. The SDK would drag in a
 * lot for the two calls we make.
 */

export const STRIPE_API = 'https://api.stripe.com/v1';

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
  return json as unknown as CheckoutSession;
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
  return json as unknown as CheckoutSession;
}

export interface ChargeReceipt {
  chargeId: string | null;
  receiptUrl: string | null;
}

/**
 * `checkout.session.completed` doesn't carry the receipt — that lives on the
 * charge, so we resolve it from the payment intent with the charge expanded.
 */
export async function retrieveReceipt(
  secretKey: string,
  paymentIntentId: string,
): Promise<ChargeReceipt> {
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
