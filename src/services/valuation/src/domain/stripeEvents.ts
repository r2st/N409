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

import { findNulByte } from './nulBytes.js';

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
 *
 * These three are also the *authority* on a subscription's state: they are the
 * subscription object itself, reported by Stripe. See {@link CHECKOUT_COMPLETED}
 * and {@link INVOICE_PAYMENT_FAILED} for the other two events that write that
 * state, and why neither is one of them.
 */
export const SUBSCRIPTION_STATE_EVENTS: readonly string[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

/**
 * The other writer of subscription state, and the weaker one.
 *
 * A subscription-mode `checkout.session.completed` is handled by writing a
 * status through the same `upsertSubscription` the events above use — 'active'
 * or 'past_due', derived from the *session's* `payment_status`. So it is a
 * snapshot of subscription state like they are, and the same replay that made
 * this ledger necessary applies to it: the billing route answers a failed
 * handler with a 5xx to provoke redelivery, so a transient failure at 10:00 is
 * ordinarily redelivered minutes later — after the `customer.subscription.*`
 * event that has since said what the status really is. It then writes its own
 * stale reading over that, which is the bug this ledger exists to stop, on the
 * one path that was left out of it.
 *
 * Its object id is `data.object.subscription` rather than `data.object.id`: the
 * session is not the thing whose state is contested, the subscription is, and an
 * ordering key only orders events that share it.
 *
 * It is deliberately *not* one of {@link SUBSCRIPTION_STATE_EVENTS}, because the
 * relationship is asymmetric — see {@link supersedingTypes}.
 */
export const CHECKOUT_COMPLETED = 'checkout.session.completed';

/**
 * The third writer of subscription state, and the narrowest.
 *
 * `invoice.payment_failed` puts the subscription on 'past_due' through
 * `markSubscriptionPastDue`, deliberately without going near the metadata the
 * `customer.subscription.*` handler needs — a lapsed card should mark the
 * account past due even on a subscription created in the Stripe dashboard. That
 * makes it a writer of the state this ledger orders, and it was not in the
 * ledger, so the ordinary recovery sequence ran backwards:
 *
 *   10:00  invoice.payment_failed — delivery fails, goes on the retry ladder
 *   10:05  the customer fixes the card; customer.subscription.updated says
 *          active, and is applied
 *   10:12  the 10:00 retry lands, and puts the account back on past_due
 *
 * The subscriber keeps their quota either way ('past_due' is a served status),
 * so what they get is a billing page saying their payment failed and a second
 * dunning email about a card they have already replaced.
 *
 * Keyed on `data.object.subscription`, like {@link CHECKOUT_COMPLETED} and for
 * the same reason: the invoice is not the thing whose state is contested.
 *
 * It yields to a newer subscription event and to a newer one of its own kind,
 * and to nothing else — see {@link supersedingTypes}.
 */
export const INVOICE_PAYMENT_FAILED = 'invoice.payment_failed';

/** Every type that gets an ordering key, i.e. is recorded with an object id. */
export const ORDERED_EVENT_TYPES: readonly string[] = [
  ...SUBSCRIPTION_STATE_EVENTS,
  CHECKOUT_COMPLETED,
  INVOICE_PAYMENT_FAILED,
];

/** Whether two events of this type about one object have a knowable order. */
export function isOrderedEventType(type: string): boolean {
  return ORDERED_EVENT_TYPES.includes(type);
}

/**
 * Which already-handled types can make an event of this type stale.
 *
 * Asymmetric on purpose, because the three writers of subscription state are not
 * equally authoritative and suppressing them symmetrically would lose data.
 *
 * A checkout session's `payment_status` is a fact about the payment page, mapped
 * here to a provisional status that the comment on the handler already describes
 * as something `customer.subscription.updated` "promotes the moment Stripe says
 * the money landed". So it must yield to a newer event of either kind.
 *
 * A `customer.subscription.*` event yields only to a newer event of its own
 * kind. It is the authority, and it carries fields the session event cannot —
 * `current_period_start`/`_end`, which no checkout session has and which the
 * quota reset keys off. Letting a newer checkout session suppress it would drop
 * the billing period entirely on the ordinary sequence of a subscription event
 * created a second earlier and delivered a moment later.
 */
export function supersedingTypes(type: string): readonly string[] {
  if (type === CHECKOUT_COMPLETED) return ORDERED_EVENT_TYPES;
  // A failed invoice reports one attempt, not the subscription — so it yields
  // to any newer reading by the authority, and to a newer attempt of its own,
  // and to nothing else. Not to a newer checkout session: that one is the
  // weaker writer of the two (see above), and letting it suppress a payment
  // failure would put an account back on 'active' on the strength of a page the
  // customer clicked through rather than money that arrived.
  if (type === INVOICE_PAYMENT_FAILED) return [...SUBSCRIPTION_STATE_EVENTS, INVOICE_PAYMENT_FAILED];
  return SUBSCRIPTION_STATE_EVENTS;
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
 *
 * A checkout session is keyed on the subscription it started, not on itself, and
 * only in subscription mode. A `mode: 'payment'` session is a one-off valuation
 * purchase handled on the payments endpoint, where it is the *only* event about
 * that session and has nothing to be ordered against; giving it a key would put
 * it in the index for no reason. An absent `subscription` — which a completed
 * subscription session always carries, so this is the malformed case — yields
 * null and the event is simply handled, as it was before this existed.
 */
function objectIdOf(type: string, object: Record<string, unknown>): string | null {
  if (SUBSCRIPTION_STATE_EVENTS.includes(type)) return str(object.id);
  if (type === CHECKOUT_COMPLETED && str(object.mode) === 'subscription') return str(object.subscription);
  // A one-off invoice carries no `subscription`, and it is also the invoice the
  // dunning handler already declines to act on — nothing to order, so no key.
  if (type === INVOICE_PAYMENT_FAILED) return str(object.subscription);
  return null;
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

/**
 * The parsed envelope both webhook routes act on.
 *
 * `type` is always a string and `object` always a plain object, so the branches
 * downstream can read them without re-checking — which is what they were
 * already doing, on values that had never been checked once.
 */
export interface StripeEventEnvelope {
  type: string;
  object: Record<string, unknown>;
  /** The whole parsed body, for `stripeEventKey` and the handlers' own reads. */
  raw: Record<string, unknown>;
}

/** A JSON value that is an object and not an array or null. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse a signed webhook body into an envelope, or say why it is not one.
 *
 * Both routes did `JSON.parse(raw.toString('utf8'))` with a cast to
 * `{ type?: string; data?: { object?: … } }`, inside a `try` that caught only
 * the parse, and then read the result as though the cast were a check. It is
 * not one, and three shapes of *valid JSON* went straight through it to a 500
 * (round 182):
 *
 *   * `null` — a body of the four characters `null` parses fine, and
 *     `event.data?.object` is a TypeError on it. Optional chaining guards a
 *     missing `data`, not a missing `event`.
 *   * `"hello"`, `[1,2,3]`, `42` — anything that is not an object. The two
 *     routes survived these by accident, in different ways; they are refused
 *     here because a Stripe event is an object and a body that is not one is
 *     not an event.
 *   * `{"type": 123}` — `event.type?.startsWith('checkout.session.')` on a
 *     number is "startsWith is not a function". The cast promised a string; the
 *     wire promised nothing.
 *
 * And one shape that reached the database instead of the handler:
 *
 *   * a NUL byte anywhere in the event. The global `preValidation` hook that
 *     refuses `U+0000` before it can reach a `text` column (domain/nulBytes.ts)
 *     is blind to these two endpoints by construction: each registers a
 *     `parseAs: 'buffer'` content parser so the raw bytes survive for signature
 *     verification, so `req.body` is a Buffer at hook time and the hook — which
 *     skips Buffers deliberately, they are bytes on purpose — sees nothing. The
 *     strings only exist after the `JSON.parse` *inside* the handler, and both
 *     `event.id` and the object id go into `stripe_events`, whose columns are
 *     `text`. An event id carrying one was a 500 on both endpoints.
 *
 * That last one is the one worth being loud about, because a 500 to Stripe is
 * not a 500 to a person: it is a delivery Stripe will retry for days, on a
 * schedule nobody is watching, against a row that will never insert. A 400 ends
 * it — Stripe records the endpoint's refusal and stops.
 *
 * Only reachable behind a verified signature, so this is not an unauthenticated
 * surface; it is a correctness one. A webhook endpoint receives every event on
 * the Stripe account, the account is not exclusively ours, and "Stripe would
 * never send that" is the assumption the cast was already making.
 */
export function parseStripeEvent(raw: Buffer): StripeEventEnvelope | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { error: 'Invalid webhook payload' };
  }
  if (!isPlainObject(parsed)) return { error: 'Invalid webhook payload: not a JSON object' };

  const nul = findNulByte(parsed);
  if (nul !== null) {
    return {
      error: `Invalid webhook payload: field ${nul} contains a NUL byte, which cannot be stored`,
    };
  }

  const type = parsed.type;
  if (type !== undefined && typeof type !== 'string') {
    return { error: 'Invalid webhook payload: type is not a string' };
  }
  const data = parsed.data;
  const object = isPlainObject(data) && isPlainObject(data.object) ? data.object : {};
  return { type: type ?? '', object, raw: parsed };
}
