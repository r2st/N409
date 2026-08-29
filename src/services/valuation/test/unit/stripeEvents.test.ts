import { describe, expect, it } from 'vitest';
import {
  INVOICE_PAYMENT_FAILED,
  isOrderedEventType,
  stripeEventKey,
  SUBSCRIPTION_STATE_EVENTS,
  supersedingTypes,
} from '../../src/domain/stripeEvents.js';

/**
 * The envelope around a Stripe webhook payload — the part neither webhook route
 * read. It carries the two facts that decide whether an event should be acted
 * on at all: the id, which is identical across every redelivery, and `created`,
 * which is when Stripe made the event rather than when it reached us.
 */
describe('stripeEventKey', () => {
  it('reads the id, type and creation time off the envelope', () => {
    const key = stripeEventKey(
      {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        created: 1_700_000_000,
        data: { object: { id: 'sub_1', status: 'active' } },
      },
      'billing',
    );
    expect(key).toEqual({
      eventId: 'evt_1',
      type: 'customer.subscription.updated',
      endpoint: 'billing',
      objectId: 'sub_1',
      eventCreated: new Date(1_700_000_000_000),
    });
  });

  it('records no object id for an event whose order cannot be judged', () => {
    // `charge.refunded` and `charge.dispute.created` name the same charge and
    // report two different things that both happened. Putting them in the
    // ordering index would make one of them suppress the other.
    for (const type of ['charge.refunded', 'charge.dispute.created', 'invoice.paid']) {
      expect(
        stripeEventKey({ id: 'evt_x', type, data: { object: { id: 'ch_1' } } }, 'payments').objectId,
      ).toBe(null);
    }
  });

  it('keys a subscription checkout on the subscription, not on the session', () => {
    // The billing route handles this event by writing a subscription status
    // through the same upsert `customer.subscription.updated` uses, so it is a
    // snapshot of the subscription's state and has to share an ordering key
    // with the events it can be reordered against. The session id would put it
    // in a key space of one, where nothing can ever supersede it.
    const key = stripeEventKey(
      {
        id: 'evt_cs',
        type: 'checkout.session.completed',
        created: 1_700_000_000,
        data: { object: { id: 'cs_1', mode: 'subscription', subscription: 'sub_1' } },
      },
      'billing',
    );
    expect(key.objectId).toBe('sub_1');
  });

  it('leaves a one-off payment session out of the ordering index', () => {
    // A `mode: 'payment'` session is the purchase of a single valuation and is
    // the only event about itself; it has nothing to be ordered against.
    expect(
      stripeEventKey(
        {
          id: 'evt_cs',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_1', mode: 'payment' } },
        },
        'payments',
      ).objectId,
    ).toBe(null);
    // A subscription-mode session that carries no subscription id is malformed;
    // it is handled as before rather than keyed on nothing.
    expect(
      stripeEventKey(
        {
          id: 'evt_cs',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_1', mode: 'subscription' } },
        },
        'billing',
      ).objectId,
    ).toBe(null);
  });

  it('treats an unreadable timestamp as absent rather than coercing it', () => {
    // `new Date(NaN)` would be an ordering key that compares false against
    // everything, which is a worse answer than having none.
    for (const created of [undefined, null, 'yesterday', NaN, 0, -1]) {
      expect(stripeEventKey({ id: 'evt_1', type: 'invoice.paid', created }, 'billing').eventCreated).toBe(
        null,
      );
    }
  });

  it('survives a payload with nothing in it', () => {
    expect(stripeEventKey(undefined, 'payments')).toEqual({
      eventId: null,
      type: '',
      endpoint: 'payments',
      objectId: null,
      eventCreated: null,
    });
    expect(stripeEventKey({ type: 'charge.refunded' }, 'payments').eventId).toBe(null);
  });

  it('rejects an empty-string id, which is not an id', () => {
    expect(stripeEventKey({ id: '', type: 'invoice.paid' }, 'billing').eventId).toBe(null);
  });
});

describe('isOrderedEventType', () => {
  it('covers every writer of subscription state and nothing else', () => {
    expect(isOrderedEventType('customer.subscription.created')).toBe(true);
    expect(isOrderedEventType('customer.subscription.updated')).toBe(true);
    expect(isOrderedEventType('customer.subscription.deleted')).toBe(true);
    // Writes a subscription status too, so it is ordered against them — but
    // only ever gets a key in subscription mode; see stripeEventKey above.
    expect(isOrderedEventType('checkout.session.completed')).toBe(true);
    expect(isOrderedEventType('invoice.paid')).toBe(false);
    expect(isOrderedEventType('charge.refunded')).toBe(false);
  });
});

describe('supersedingTypes', () => {
  /**
   * The two writers of subscription state are not equally authoritative, and
   * suppressing them symmetrically would lose data rather than protect it.
   */
  it('lets a newer subscription event supersede a checkout session', () => {
    expect(supersedingTypes('checkout.session.completed')).toContain('customer.subscription.updated');
  });

  it('lets a newer checkout session supersede an older one', () => {
    expect(supersedingTypes('checkout.session.completed')).toContain('checkout.session.completed');
  });

  it('never lets a checkout session supersede a subscription event', () => {
    // `customer.subscription.*` carries `current_period_start`/`_end`, which no
    // checkout session has and which the quota reset keys off. A subscription
    // event created a second earlier and delivered a moment later is ordinary,
    // and dropping it would drop the billing period with it.
    for (const type of SUBSCRIPTION_STATE_EVENTS) {
      expect(supersedingTypes(type)).not.toContain('checkout.session.completed');
      expect(supersedingTypes(type)).toEqual(SUBSCRIPTION_STATE_EVENTS);
    }
  });
});

describe('a failed invoice is a writer of subscription state too', () => {
  it('is ordered, and keyed on the subscription rather than the invoice', () => {
    // markSubscriptionPastDue writes the same column customer.subscription.*
    // writes, so an ordering key only helps if it is the same key.
    expect(isOrderedEventType(INVOICE_PAYMENT_FAILED)).toBe(true);
    const key = stripeEventKey(
      {
        id: 'evt_1',
        type: INVOICE_PAYMENT_FAILED,
        created: 1_772_000_000,
        data: { object: { id: 'in_1', subscription: 'sub_1' } },
      },
      'billing',
    );
    expect(key.objectId).toBe('sub_1');
  });

  it('has no key when the invoice is not against a subscription', () => {
    // A one-off invoice is also the one the dunning handler declines to act on.
    const key = stripeEventKey(
      { id: 'evt_2', type: INVOICE_PAYMENT_FAILED, created: 1_772_000_000, data: { object: { id: 'in_2' } } },
      'billing',
    );
    expect(key.objectId).toBe(null);
  });

  it('yields to a newer subscription event and to a newer attempt of its own', () => {
    // The recovery sequence it exists for: a failure retried at 10:12 must not
    // undo the 10:05 event that said the replaced card went through.
    expect(supersedingTypes(INVOICE_PAYMENT_FAILED)).toEqual([
      ...SUBSCRIPTION_STATE_EVENTS,
      INVOICE_PAYMENT_FAILED,
    ]);
  });

  it('is not superseded by a checkout session, and does not supersede one', () => {
    // A checkout session is the weaker writer of the two: it reports a page the
    // customer clicked through, not money that arrived, so it must not put an
    // account back to active over a payment failure.
    expect(supersedingTypes(INVOICE_PAYMENT_FAILED)).not.toContain('checkout.session.completed');
    // The other direction does hold — a stale checkout completion arriving
    // after a payment failure has nothing to say.
    expect(supersedingTypes('checkout.session.completed')).toContain(INVOICE_PAYMENT_FAILED);
  });

  it('leaves the subscription events themselves alone', () => {
    // They are the authority and they carry the billing period the quota reset
    // keys off; nothing weaker may suppress one.
    for (const type of SUBSCRIPTION_STATE_EVENTS) {
      expect(supersedingTypes(type)).toEqual(SUBSCRIPTION_STATE_EVENTS);
    }
  });
});
