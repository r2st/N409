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

/**
 * How long one client intent stays the same request to Stripe.
 *
 * An `Idempotency-Key` makes Stripe answer a repeat of a request it has
 * already served with the *first* answer instead of doing the work twice. What
 * needs deciding is how long "a repeat" lasts, and it is bounded on both sides.
 *
 * Below, by the window that has to be covered: a click, its double, a second
 * tab, and — the one that actually loses money — a retry after our own
 * 20-second deadline fired on a request Stripe had already accepted. That is
 * seconds to a couple of minutes.
 *
 * Above, by Stripe's own retention. Stripe forgets a key after 24 hours, and a
 * Checkout Session expires after 24 hours, and `findLiveCheckout` stops
 * offering the stored one after 24 hours — three clocks that all run out at
 * once. A key stable for the whole day would sit exactly on that boundary: the
 * first click after a session expires could be answered with the expired
 * session, sending the client to a dead Stripe page. An hour is far longer than
 * any retry and far shorter than any of the three, so it is never on it.
 *
 * The cost of the bucket is a click landing within the deadline of a boundary,
 * where the two attempts get two keys and Stripe opens two sessions. That is
 * what happens on *every* attempt today, so the bucket is never worse than the
 * behaviour it replaces.
 */
export const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The `Idempotency-Key` for one form-encoded request.
 *
 * Derived from the encoded body rather than from fields picked out by hand, so
 * that two requests share a key only if they are the same request. That is not
 * a nicety: Stripe refuses a key reused with *different* parameters, so a key
 * built from the quote alone would start failing outright the day a company is
 * renamed between two clicks — the name is in the product line and not in the
 * quote. A digest of the body cannot drift from what was sent.
 *
 * The scope keeps the two Checkout creators apart even in the impossible case
 * of identical bodies, and the bucket bounds the window (see
 * {@link IDEMPOTENCY_WINDOW_MS}).
 */
export function idempotencyKeyFor(scope: string, body: string, nowMs: number = Date.now()): string {
  const bucket = Math.floor(nowMs / IDEMPOTENCY_WINDOW_MS);
  const digest = crypto.createHash('sha256').update(`${scope}\n${bucket}\n${body}`).digest('hex');
  return `n409-${scope}-${digest.slice(0, 40)}`;
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
    /**
     * True when Stripe never answered — a refused connection, DNS, a TLS
     * failure, or our own 20-second deadline firing — rather than answering
     * with a rejection.
     *
     * Carried on the ordinary error type rather than escaping as its own class
     * for the reason `InternalServiceError.circuitOpen` documents: every call
     * site already tests `err instanceof StripeApiError`, and a second class
     * would need each of them found and widened. One that was missed is a
     * handled outage turning back into a 500.
     *
     * It changes what may be said as well as what is caught. `message` on a
     * rejection is Stripe's own sentence and is written to be read by a person
     * ("Your card was declined"); on an unreachable Stripe it is ours, because
     * the transport's version names internal topology —
     * `getaddrinfo ENOTFOUND api.stripe.com` — and the real one is kept on
     * `cause` for the log.
     */
    readonly unreachable: boolean = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StripeApiError';
  }
}

/**
 * Stripe's own sentence for a rejection, or a statement of the fact when the
 * body carried none.
 *
 * `err.message` is missing whenever something other than Stripe answered — a
 * proxy, a WAF, a load balancer with its own error page — and the fallback then
 * read `Stripe HTTP 502`, which `stripeProblem` prefixed into
 * `Stripe: Stripe HTTP 502`. That is a status code with a brand on it: it names
 * no condition, suggests nothing, and repeats itself. A status is worth saying
 * only as what it means to the reader.
 */
function stripeMessage(err: Record<string, unknown>, status: number): string {
  const message = typeof err.message === 'string' ? err.message.trim() : '';
  if (message !== '') return message;
  return status >= 500
    ? `Stripe is having trouble at the moment (HTTP ${status})`
    : `Stripe refused the request and gave no reason (HTTP ${status})`;
}

/** The deadline every call in this file runs under. */
const STRIPE_TIMEOUT_MS = 20_000;

/**
 * `fetch` against Stripe, with the failures Stripe cannot report itself turned
 * into the error type the call sites already handle.
 *
 * Node's `fetch` rejects with a `TypeError: fetch failed` when the host is
 * unreachable and with a `TimeoutError` when `AbortSignal.timeout` fires, and
 * neither is a `StripeApiError`. Every route below is written as
 *
 *     catch (err) { if (err instanceof StripeApiError) { … } throw err }
 *
 * so both walked straight past the handling and out through the generic 5xx
 * handler as `500 urn:n409:problem:internal` — the one answer that tells a
 * client nothing and an operator nothing. Stripe being down is the single most
 * predictable failure of a payments integration and it was the one failure the
 * checkout routes did not have an answer for.
 *
 * The status is a claim about what happened, not one Stripe made: 504 when our
 * clock ran out (the request may well have been accepted and a session may
 * exist), 503 when the connection never stood up (it certainly did not). Both
 * are only read by the log; the route maps `unreachable` to its own answer.
 */
async function stripeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new StripeApiError(
        `Stripe did not respond within ${Math.round(STRIPE_TIMEOUT_MS / 1000)}s`,
        504,
        true,
        { cause: err },
      );
    }
    throw new StripeApiError('Stripe could not be reached', 503, true, { cause: err });
  }
}

/**
 * Stripe's body, read under the same deadline as the headers.
 *
 * `AbortSignal.timeout` aborts the body stream too, so a response that arrives
 * and then stalls mid-JSON rejects *here* rather than at the fetch. Every call
 * site read the body as `res.json().catch(() => ({}))`, which is right for the
 * case it was written for — a proxy's HTML error page under a 4xx, where the
 * status is the whole answer — and turned a mid-body timeout into an empty
 * object under a 200. The checkout creators then reported that as "Stripe
 * returned a Checkout Session without an id and url", which describes Stripe
 * misbehaving rather than us giving up, and sends whoever reads the log to the
 * wrong place.
 *
 * So: `{}` for a body that is not JSON, and the unreachable error for a body
 * we abandoned. An array or `null` is JSON but not an object, and returning it
 * would let `json.error` and `json.url` be reads against a non-object; `{}`
 * makes those a miss rather than a crash.
 */
async function stripeBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new StripeApiError(
        `Stripe did not respond within ${Math.round(STRIPE_TIMEOUT_MS / 1000)}s`,
        504,
        true,
        { cause: err },
      );
    }
    return {};
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
  const res = await stripeFetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKeyFor('checkout', body),
    },
    body,
  });
  const json = await stripeBody(res);
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(stripeMessage(err, res.status), res.status);
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
  const res = await stripeFetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKeyFor('subscribe', body),
    },
    body,
  });
  const json = await stripeBody(res);
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(stripeMessage(err, res.status), res.status);
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
 * rather than stored. That is also why this call carries no `Idempotency-Key`
 * while the two Checkout creators do: collapsing two clicks onto one portal
 * session would hand the second click a URL the first has already spent, and
 * there is no charge at the end of it to protect.
 */
export async function createBillingPortalSession(
  secretKey: string,
  args: { customerId: string; returnUrl: string },
): Promise<{ id: string; url: string }> {
  const res = await stripeFetch(`${STRIPE_API}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encodeForm({ customer: args.customerId, return_url: args.returnUrl }),
  });
  const json = await stripeBody(res);
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(stripeMessage(err, res.status), res.status);
  }
  if (typeof json.url !== 'string') {
    throw new StripeApiError('Stripe returned a billing portal session with no URL', 502);
  }
  return { id: String(json.id ?? ''), url: json.url };
}

/**
 * Closes an open Checkout Session so its URL can no longer be paid.
 *
 * A Checkout Session URL stays payable until the session completes or expires,
 * and Stripe's default expiry is 24 hours — so every session this service opens
 * and never reconciles is a live way to charge the customer. Two of them for
 * one engagement, at two different prices, is a double charge that no guard
 * downstream can undo.
 *
 * Returns whether the session is definitely closed. `false` covers the case
 * Stripe refuses the call — most importantly a session that has already been
 * *completed*, which it will not let you expire and which the caller must not
 * treat as harmlessly gone.
 *
 * No `Idempotency-Key` here either, and for the opposite reason to the portal's:
 * expiring is already idempotent in the only sense that matters — a session
 * expired twice is expired — while a key would make Stripe replay its *first*
 * answer, so a refusal cached at 10:00 would still be a refusal at 10:30 on a
 * session that had since become expirable.
 */
export async function expireCheckoutSession(secretKey: string, sessionId: string): Promise<boolean> {
  const res = await stripeFetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return res.ok;
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
  const res = await stripeFetch(
    `${STRIPE_API}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const json = await stripeBody(res);
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new StripeApiError(stripeMessage(err, res.status), res.status);
  }
  const charge = (json.latest_charge ?? {}) as Record<string, unknown>;
  return {
    chargeId: typeof charge.id === 'string' ? charge.id : null,
    receiptUrl: typeof charge.receipt_url === 'string' ? charge.receipt_url : null,
  };
}
