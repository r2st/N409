/**
 * Reading the envelope of a Stripe webhook event.
 *
 * Both webhook routes parse the payload for what their handlers need — a
 * session, a charge, a subscription — and neither looked at the envelope
 * around it. The envelope is where the two facts live that decide whether the
 * event should be acted on at all: its id, which is the same across every
 * redelivery of it, and `created`, which is when Stripe made it rather than
 * when it reached us.
 *
 * Pure, so the parsing is testable without a webhook, a signature or a
 * database. See repos/stripeEvents.ts for what is done with the result and
 * migration 0155 for why.
 */

/** Which endpoint received the delivery. */
export type StripeEndpoint = 'payments' | 'billing';

export interface StripeEventKey {
  /** `evt_…`, or null on a payload that carries none (hand-made, or a test). */
  eventId: string | null;
  type: string;
  endpoint: StripeEndpoint;
  objectId: string | null;
  eventCreated: Date | null;
}

/**
 * Event types whose payload carries the object's *whole current state*, so of
 * two events about one object the later one is simply right and the earlier one
 * must not be applied after it.
 *
 * This is the property that makes ordering decidable, and it is not shared by
 * most Stripe events. `charge.refunded` and `charge.dispute.created` name the
 * same charge but report two different things that both happened; applying them
 * in either order is correct, and calling the older one stale would drop a fact.
 * A subscription's `status`, `plan` and period are a snapshot, and replaying an
 * old snapshot over a newer one is exactly the bug.
 *
 * `deleted` is in the list for completeness rather than need — cancellation is
 * terminal in Stripe and `upsertSubscription` already refuses to write over a
 * canceled row — but leaving it out would mean an ordinary `updated` retry
 * could still land after it and be judged against nothing.
 */
export const ORDERED_EVENT_TYPES: readonly string[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

/** Whether two events of this type about one object have a knowable order. */
export function isOrderedEventType(type: string): boolean {
  return ORDERED_EVENT_TYPES.includes(type);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * `created` is unix seconds. A value that is not a finite number is treated as
 * absent rather than coerced: an event with an unreadable timestamp cannot
 * order anything, and `new Date(NaN)` would silently become one that orders
 * everything wrongly.
 */
function createdAt(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

/**
 * The id of the Stripe object an event is about.
 *
 * Only read for the types whose order matters — see {@link ORDERED_EVENT_TYPES}.
 * Recording one for the others would put rows in the ordering index that must
 * never answer it, which is a worse failure than having no id at all: it would
 * make one fact about a charge suppress another.
 */
function objectIdOf(type: string, object: Record<string, unknown>): string | null {
  return isOrderedEventType(type) ? str(object.id) : null;
}

/** The envelope facts, from a parsed event body. */
export function stripeEventKey(event: unknown, endpoint: StripeEndpoint): StripeEventKey {
  const e = (event ?? {}) as {
    id?: unknown;
    type?: unknown;
    created?: unknown;
    data?: { object?: unknown };
  };
  const type = str(e.type) ?? '';
  const object = (e.data?.object ?? {}) as Record<string, unknown>;
  return {
    eventId: str(e.id),
    type,
    endpoint,
    objectId: objectIdOf(type, object),
    eventCreated: createdAt(e.created),
  };
}
