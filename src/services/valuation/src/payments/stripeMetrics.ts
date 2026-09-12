import type { Counter, Histogram, MetricsRegistry } from '@n409/shared';

/**
 * How the calls this service makes *to* Stripe are going.
 *
 * WHY THIS EXISTS (R450, methodology M11). Every other wire out of this
 * process has a pair on `/metrics`: the engine and the AI gateway under
 * `upstream_requests_total`, the report unit under `report_render_total`, the
 * relay under `email_send_attempts_total`, the market feed under
 * `market_feed_answers_total`. The one that moves money had none. The five
 * operations in `stripe.ts` — two Checkout creators, the billing portal, the
 * expire call that closes a payable URL, and the receipt fetch that fulfils a
 * payment — were counted nowhere, so "Stripe's error rate doubled an hour
 * ago" and "checkout creation has taken eight seconds since the deploy" were
 * not questions anything on this box could answer.
 *
 * `upstream_requests_total` was the obvious home and is the wrong one: it is
 * `clients/internal.ts`'s instrument, labelled by an internal service name and
 * fed by the circuit breaker, and Stripe goes through neither. R175 gave the
 * outage a `StripeApiError` so the routes could answer it; R225 gave the
 * routes a `warn` line. A log line is per-request and, on this box, consumed
 * by nothing (`infra/journald` is retention and rate limits). This is the
 * channel a rule can be written against.
 *
 * `rejected` (4xx) is kept apart from `failed` (5xx) for the reason
 * `UpstreamOutcome` gives: a run of 4xx is this service — or a rotated key —
 * and a run of 5xx is Stripe, and only one of them is worth waking somebody
 * for. `timeout` and `unreachable` are the two `unreachable: true` shapes the
 * error type already separates by status.
 *
 * Labelled by operation and nothing else. The operation set is five strings
 * this file owns; a session id or a customer would mint a series per payment.
 */
let calls: Counter | null = null;
let duration: Histogram | null = null;

/** Which of the five calls in `stripe.ts` was made. */
export type StripeOperation =
  | 'checkout_session'
  | 'subscription_checkout'
  | 'billing_portal'
  | 'expire_checkout'
  | 'retrieve_receipt';

/**
 * What came back. `ok` is a 2xx whether or not the body then parsed as what
 * the caller wanted — a 200 carrying no session id is `asCheckoutSession`'s
 * finding, not the transport's.
 */
export type StripeOutcome = 'ok' | 'rejected' | 'failed' | 'timeout' | 'unreachable';

/**
 * Buckets that reach the 20-second deadline in `stripe.ts`. The shared default
 * tops out at ten seconds, so a Checkout call that took fifteen — the
 * interesting one — would land in `+Inf` and the quantile would say nothing.
 */
const STRIPE_DURATION_BUCKETS: readonly number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20];

export function registerStripeMetrics(registry: MetricsRegistry): void {
  calls = registry.counter(
    'stripe_requests_total',
    'Calls this service made to Stripe, by operation and outcome. outcome="rejected" is a 4xx (our request, or a rotated key); "failed" is a 5xx (Stripe); "timeout" and "unreachable" never got an answer.',
    ['operation', 'outcome'],
  );
  duration = registry.histogram(
    'stripe_request_duration_seconds',
    'Wall time of one call to Stripe, whether it succeeded or not.',
    ['operation'],
    STRIPE_DURATION_BUCKETS,
  );
}

/** Test seam: drops the instruments so one suite's counts cannot leak into another. */
export function resetStripeMetrics(): void {
  calls = null;
  duration = null;
}

/** Record one finished call. Inert before registration, for the unit tests that never build the app. */
export function recordStripeRequest(operation: StripeOperation, outcome: StripeOutcome, durationMs: number): void {
  calls?.inc({ operation, outcome });
  duration?.observe(durationMs / 1000, { operation });
}

/** The outcome an HTTP answer counts as. */
export function stripeOutcomeForStatus(status: number): StripeOutcome {
  if (status >= 500) return 'failed';
  if (status >= 400) return 'rejected';
  return 'ok';
}
