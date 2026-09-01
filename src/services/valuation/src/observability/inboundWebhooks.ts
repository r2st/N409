import type { Counter, MetricsRegistry } from '@n409/shared';

/**
 * What arrived at the three inbound webhook doors, and what we did with it.
 *
 * WHY THIS EXISTS (R329, methodology M11). A webhook is the one endpoint on
 * this platform that is deliberately unauthenticated and deliberately trusted:
 * the whole of its authority is a signature header (see
 * `webhookSignatureCensus.test.ts`). The corollary nobody had written down is
 * that the *signature* is a shared secret held on two machines neither of which
 * tells the other when it changes — and the failure that produces is total and
 * silent:
 *
 *   * Stripe's endpoint secret is rotated in the dashboard, or the deploy
 *     brings up the wrong `STRIPE_WEBHOOK_SECRET`. Every delivery is refused
 *     with `400 Invalid Stripe signature`. Stripe retries for days and gives
 *     up. On this side no payment is ever fulfilled, no refund is recorded, no
 *     subscription changes state, and a customer who has been charged has an
 *     engagement that is still unpaid.
 *   * The mail provider's secret goes the same way and every bounce and
 *     complaint is dropped, so a suppressed address keeps being sent to and a
 *     dead one is never marked.
 *
 * None of that raised anything. `registerProblemHandler` logs 5xx and leaves
 * 4xx silent on purpose — "those describe the request, the caller was told, and
 * logging them is logging other people's mistakes" — which is right for a
 * browser and wrong for a machine-to-machine integration, where a 4xx is not
 * the caller's mistake but ours, and the caller is the only party that can see
 * it. The evidence of a wholly broken payments integration was a status class
 * in `http_requests_total`, against a route whose ordinary traffic is low
 * enough that no error-rate rule would ever notice.
 *
 * So: count every delivery by what became of it, `accepted` included. A refusal
 * count with no denominator cannot separate one scanner POSTing junk at a URL
 * that is written down in `PUBLIC_ROUTES` from a secret that has been wrong
 * since Tuesday — the same reason `background_sweep_runs_total` exists beside
 * the failure count.
 *
 * DELIBERATELY NOT LABELLED BY EVENT TYPE. Stripe's type vocabulary is theirs
 * to extend and arrives as caller-supplied text, which is the cardinality trap
 * `routeLabel` and `MAX_SERIES_PER_METRIC` exist for. The type is already on
 * every log line this handler writes (`stripeEventType`), which is where you
 * look once this has told you to look.
 */
let deliveries: Counter | null = null;

/**
 * The doors. Three today, each its own scope with a raw-buffer parser; the
 * census that finds them by that parser is the guard against a fourth arriving
 * without one.
 */
export type InboundWebhookSource = 'stripe-payments' | 'stripe-billing' | 'email-delivery';

/**
 * What became of a delivery.
 *
 * `unsigned` and `bad_signature` are kept apart because they are different
 * incidents with opposite first moves. A request with no signature header at
 * all is a stranger — these URLs are published in `PUBLIC_ROUTES` and the
 * internet scans them — and is nobody's emergency. A *well-formed* signature
 * that does not verify is a secret mismatch: the sender is almost certainly the
 * provider, holding a key this deployment does not have.
 *
 * `accepted` covers duplicate, stale and ignored deliveries as well as acted-on
 * ones. All four mean the same thing to the question this instrument answers —
 * the sender proved who it was and the handler dealt with the event.
 */
export type InboundWebhookOutcome = 'accepted' | 'unsigned' | 'bad_signature' | 'unconfigured' | 'malformed';

export function registerInboundWebhookMetrics(registry: MetricsRegistry): void {
  deliveries = registry.counter(
    'inbound_webhook_deliveries_total',
    'Inbound webhook deliveries by door and outcome. outcome="bad_signature" against a nonzero total is a shared secret that has drifted — the provider is calling and every event is being dropped.',
    ['source', 'outcome'],
  );
}

/** Test seam: drops the instrument so one suite's counts cannot leak into another. */
export function resetInboundWebhookMetrics(): void {
  deliveries = null;
}

export function recordInboundWebhook(source: InboundWebhookSource, outcome: InboundWebhookOutcome): void {
  deliveries?.inc({ source, outcome });
}

/** A logger shaped like the one every webhook handler already holds. */
interface WebhookLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Counts the refusal and, for the one that is ours rather than a stranger's,
 * says so in the log too.
 *
 * The metric is what a rule fires on; this line is what the operator reads once
 * it has. `unsigned` deliberately writes nothing — an unauthenticated endpoint
 * on the public internet refusing an unsigned POST is the endpoint working, and
 * a scanner should not be able to choose how much this box logs. No
 * `alert: true`: the alerting channel here is the scrape, and a hand-stamped
 * flag on a line nothing consumes is the shape R155 found six copies of.
 */
export function refuseInboundWebhook(
  log: WebhookLogger,
  source: InboundWebhookSource,
  outcome: Exclude<InboundWebhookOutcome, 'accepted'>,
): void {
  recordInboundWebhook(source, outcome);
  if (outcome === 'unsigned') return;
  log.warn(
    { source, outcome },
    outcome === 'bad_signature'
      ? 'inbound webhook refused: the signature did not verify — the sending secret and ours have drifted'
      : outcome === 'unconfigured'
        ? 'inbound webhook refused: no signing secret is configured for this door'
        : 'inbound webhook refused: the signature verified but the body did not parse',
  );
}
