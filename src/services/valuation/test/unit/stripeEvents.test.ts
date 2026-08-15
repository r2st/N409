import { describe, expect, it } from 'vitest';
import { isOrderedEventType, stripeEventKey } from '../../src/domain/stripeEvents.js';

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
    for (const type of ['charge.refunded', 'charge.dispute.created', 'checkout.session.completed']) {
      expect(
        stripeEventKey({ id: 'evt_x', type, data: { object: { id: 'ch_1' } } }, 'payments').objectId,
      ).toBe(null);
    }
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
  it('covers the whole subscription lifecycle and nothing else', () => {
    expect(isOrderedEventType('customer.subscription.created')).toBe(true);
    expect(isOrderedEventType('customer.subscription.updated')).toBe(true);
    expect(isOrderedEventType('customer.subscription.deleted')).toBe(true);
    expect(isOrderedEventType('invoice.paid')).toBe(false);
    expect(isOrderedEventType('checkout.session.completed')).toBe(false);
    expect(isOrderedEventType('charge.refunded')).toBe(false);
  });
});
