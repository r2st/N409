import type { Counter, MetricsRegistry } from '@n409/shared';
import type { BounceKind, DeliveryEventKind } from '../domain/emailDelivery.js';
import type { SendOutcome } from '../email/sendAttempt.js';

/**
 * Sending reputation, as opposed to whether one message reached its recipient.
 *
 * WHY THIS EXISTS (R436, methodology M11). Every fact about a bounce, a
 * complaint or a transport refusal already lands somewhere: `recordSendFailure`
 * suppresses a dead address, `email_delivery_events` keeps the ledger,
 * `deliveryStats` answers `GET /api/v1/admin/email/delivery-stats`. What none
 * of that is is a scrape. The stats route is ops-session-gated and pull-based —
 * a number that is right the instant somebody happens to load the page, and
 * silent every other instant — so a complaint spike that gets the sending
 * domain rate-limited or blocklisted by a receiving network, or a relay that
 * has started rejecting every message this platform hands it, produces nothing
 * an alert can fire on. The outbox keeps sending into it, every rejected
 * message is a client who quietly stops receiving their own valuation reports,
 * and the only way anyone finds out is a support ticket or an operator who
 * happened to load the dashboard.
 *
 * Two counters, at the two places every send path and every delivery signal
 * already converges — `sendAndRecord` (email/sendAttempt.ts) is the one
 * transport-then-bookkeeping call all four send paths share, and
 * `recordDeliveryEvent` (repos/emailDelivery.ts) is the one ledger insert both
 * the in-band SMTP rejection (`recordSendFailure`) and the provider webhook
 * route fold into. Recording at those choke points rather than at each of the
 * five or six call sites above them is the same reasoning `scheduleSweep` and
 * `bindActor` already argue elsewhere on this platform: an argument at every
 * call site is an argument one of them gets wrong, and a new send path or a
 * second provider webhook is counted by construction rather than by whoever
 * remembers to wire it up.
 *
 * `email_send_attempts_total` is the transport-level half — did the relay take
 * the message at all — and its `sent` outcome is the denominator the bounce
 * rate below divides into: a bare bounce count cannot separate two complaints
 * out of ten thousand sends from two out of twenty.
 *
 * `email_delivery_events_total` is the semantic half — what a delivery signal,
 * from whichever door, actually said. Its second label is spelled `bounce`,
 * not `bounce_kind` — every label name this estate has registered so far is
 * one word, because `alertRulesCensus.test.ts` reads a rule's expression for
 * any identifier carrying an underscore and treats it as a claimed metric
 * name; a label spelled with one is indistinguishable from that and fails the
 * census as a rule "referring to a metric nothing exports". `bounce` carries
 * `'none'` for the three kinds that are not a bounce at all (`delivered`,
 * `deferred`, `opened`) rather than being omitted, so the label set is fixed
 * and total rather than present only on the rows an operator happens to have
 * seen — the same reason `sso_outcomes_total` always sets a value rather than
 * leaving a label absent. Both label sets are small, fixed vocabularies
 * (`DeliveryEventKind` is five values, `BounceKind` plus `'none'` is four), so
 * the series count is bounded at twenty without needing
 * `MAX_SERIES_PER_METRIC` to do the bounding.
 */
let sendAttempts: Counter | null = null;
let deliveryEvents: Counter | null = null;

export function registerEmailDeliveryMetrics(registry: MetricsRegistry): void {
  sendAttempts = registry.counter(
    'email_send_attempts_total',
    'Outbound mail handed to the transport, by what became of it. outcome="failed" against a nonzero total is the relay refusing this platform outright; outcome="sent" is the denominator every downstream bounce and complaint rate divides into.',
    ['outcome'],
  );
  deliveryEvents = registry.counter(
    'email_delivery_events_total',
    'Delivery signals folded into the ledger, from the in-band SMTP rejection or a provider webhook alike. kind="complained" against a nonzero total is a recipient pressing the spam button — the fastest way a sending domain gets blocklisted — and it has no other symptom on this platform at all.',
    ['kind', 'bounce'],
  );
}

/** Test seam: drops the instruments so one suite's counts cannot leak into another. */
export function resetEmailDeliveryMetrics(): void {
  sendAttempts = null;
  deliveryEvents = null;
}

export function recordEmailSendAttempt(outcome: SendOutcome): void {
  sendAttempts?.inc({ outcome });
}

export function recordEmailDeliveryEvent(kind: DeliveryEventKind, bounceKind: BounceKind | null): void {
  deliveryEvents?.inc({ kind, bounce: bounceKind ?? 'none' });
}
