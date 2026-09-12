import type { Counter, Histogram, MetricsRegistry } from '@n409/shared';

/**
 * What happened when this platform POSTed to a partner's receiver.
 *
 * WHY THIS EXISTS (R450, methodology M11). The *inbound* webhook doors have
 * had `inbound_webhook_deliveries_total` since R329. The outbound side — the
 * events this platform owes a partner when an engagement moves — had only
 * what the retry sweep tallies into `background_sweep_items_total`, and the
 * sweep sees a delivery only once it has already failed once: the first
 * attempt, made in-line from `firePartnerWebhooks`, was counted nowhere. A
 * delivered event produced no series at all, so a delivery rate had no
 * denominator, and a receiver that answers every first attempt with a 500
 * shows up a minute later as a retry with nothing saying the receiver was
 * ever asked before.
 *
 * Latency was on nothing. `DELIVERY_TIMEOUT_MS` gives a receiver ten seconds,
 * and a receiver taking nine of them on every event holds the fan-out loop —
 * which runs in the request that moved the engagement — for nine seconds per
 * webhook. `http_request_duration_seconds` sees the request get slow and
 * cannot say why.
 *
 * DELIBERATELY NOT LABELLED BY WEBHOOK OR PARTNER. Either would mint a series
 * per row of `partner_webhooks`, the cardinality trap `routeLabel` exists to
 * avoid; the webhook id is on the `warn` line `attemptDelivery` writes, which
 * is where you look once this has told you to look. `event` is a closed set
 * this codebase owns (`WEBHOOK_EVENT_TYPES`) and is kept.
 */
let deliveries: Counter | null = null;
let duration: Histogram | null = null;

/**
 * What came back from one POST.
 *
 * `blocked` never dialled: the target resolved to a private address after it
 * was stored, and the delivery was refused on this side. Kept apart from
 * `rejected` because it is a fact about our policy, not the receiver, and a
 * rise in it is a partner whose DNS now points somewhere it should not.
 * `redirected` is the receiver answering 3xx, which the policy treats as
 * permanent; it is its own word because the fix — a final URL — is the
 * partner's, and a 3xx folded into `rejected` reads as a broken receiver.
 */
export type PartnerWebhookOutcome = 'delivered' | 'rejected' | 'failed' | 'unreachable' | 'redirected' | 'blocked';

/** Reaches the ten-second per-attempt deadline; the shared default stops at ten and would put every timeout in `+Inf`. */
const DELIVERY_DURATION_BUCKETS: readonly number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 7.5, 10, 12];

export function registerPartnerWebhookDeliveryMetrics(registry: MetricsRegistry): void {
  deliveries = registry.counter(
    'partner_webhook_deliveries_total',
    'POSTs to partner webhook receivers by event and outcome, first attempts and retries alike. outcome="failed" is a 5xx or a receiver that answered nothing usable and will be retried; "rejected" is a 4xx that will not be.',
    ['event', 'outcome'],
  );
  duration = registry.histogram(
    'partner_webhook_delivery_duration_seconds',
    'Wall time of one POST to a partner webhook receiver, whether it succeeded or not. Not observed for outcome="blocked", which never dials.',
    ['event'],
    DELIVERY_DURATION_BUCKETS,
  );
}

/** Test seam: drops the instruments so one suite's counts cannot leak into another. */
export function resetPartnerWebhookDeliveryMetrics(): void {
  deliveries = null;
  duration = null;
}

/**
 * Record one finished POST. `durationMs` is null for `blocked`, which made no
 * request — a zero in the histogram would drag every quantile toward the
 * floor exactly while a partner's target is misconfigured.
 */
export function recordPartnerWebhookDelivery(
  event: string,
  outcome: PartnerWebhookOutcome,
  durationMs: number | null,
): void {
  deliveries?.inc({ event, outcome });
  if (durationMs !== null) duration?.observe(durationMs / 1000, { event });
}
