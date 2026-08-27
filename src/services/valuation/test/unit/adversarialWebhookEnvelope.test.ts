import { describe, expect, it } from 'vitest';
import { parseStripeEvent, stripeEventKey } from '../../src/domain/stripeEvents.js';

const body = (s: string) => Buffer.from(s, 'utf8');
const err = (s: string): string => {
  const r = parseStripeEvent(body(s));
  if (!('error' in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.error;
};
const ok = (s: string) => {
  const r = parseStripeEvent(body(s));
  if ('error' in r) throw new Error(`expected an envelope, got ${r.error}`);
  return r;
};

/**
 * Round 182. Both webhook routes read `JSON.parse(...) as { type?: string; … }`
 * as though the cast were a check, and four shapes of *valid, signed* JSON went
 * through it to a 500. See domain/stripeEvents.ts for why a 500 is the worst of
 * the available answers here: Stripe reads it as "retry", for days.
 */
describe('parseStripeEvent', () => {
  it('accepts an ordinary event and normalises what the handlers read', () => {
    const e = ok('{"id":"evt_1","type":"invoice.paid","data":{"object":{"id":"in_1"}}}');
    expect(e.type).toBe('invoice.paid');
    expect(e.object).toEqual({ id: 'in_1' });
    expect(e.raw.id).toBe('evt_1');
  });

  it('defaults a missing type and a missing object rather than refusing', () => {
    // Stripe's own events always carry both; an event that does not is still an
    // event to acknowledge and ignore, which is what the handlers already do.
    const e = ok('{"id":"evt_2"}');
    expect(e.type).toBe('');
    expect(e.object).toEqual({});
    expect(ok('{"id":"evt_3","type":"invoice.paid","data":"nope"}').object).toEqual({});
    expect(ok('{"id":"evt_4","type":"invoice.paid","data":{"object":[1,2]}}').object).toEqual({});
  });

  it('refuses a body that is not JSON', () => {
    expect(err('{not json')).toBe('Invalid webhook payload');
    expect(err('')).toBe('Invalid webhook payload');
  });

  /**
   * `null` is the one that mattered: four characters of valid JSON on which
   * `event.data?.object` is a TypeError. Optional chaining guards a missing
   * `data`; it does not guard a missing `event`.
   */
  it('refuses valid JSON that is not an object', () => {
    for (const raw of ['null', '[1,2,3]', '"hello"', '42', 'true']) {
      expect(err(raw), raw).toBe('Invalid webhook payload: not a JSON object');
    }
  });

  /** `event.type?.startsWith(…)` on a number is "startsWith is not a function". */
  it('refuses a type that is not a string', () => {
    expect(err('{"id":"evt_5","type":123,"data":{"object":{}}}')).toBe(
      'Invalid webhook payload: type is not a string',
    );
    expect(err('{"id":"evt_6","type":{"a":1}}')).toContain('type is not a string');
  });

  /**
   * The global NUL hook cannot see these two endpoints: each registers a
   * `parseAs: 'buffer'` parser so the bytes survive for signature verification,
   * so `req.body` is a Buffer when the hook runs and the strings only exist
   * after the `JSON.parse` inside the handler. `event.id` and the object id are
   * both `text` columns in `stripe_events`.
   */
  it('refuses a NUL byte anywhere in the event, naming the field', () => {
    expect(err('{"id":"evt_\\u0000x","type":"invoice.paid"}')).toBe(
      'Invalid webhook payload: field id contains a NUL byte, which cannot be stored',
    );
    expect(err('{"id":"evt_7","type":"invoice.paid","data":{"object":{"id":"in_\\u0000x"}}}')).toContain(
      'field data.object.id',
    );
    expect(
      err(
        '{"id":"evt_8","type":"checkout.session.completed","data":{"object":{"metadata":{"valuation_id":"\\u0000"}}}}',
      ),
    ).toContain('data.object.metadata.valuation_id');
  });

  it('hands stripeEventKey a shape it can key on', () => {
    const e = ok(
      '{"id":"evt_9","type":"customer.subscription.updated","created":1767355200,"data":{"object":{"id":"sub_1"}}}',
    );
    const key = stripeEventKey(e.raw, 'billing');
    expect(key).toMatchObject({ eventId: 'evt_9', objectId: 'sub_1', endpoint: 'billing' });
    expect(key.eventCreated?.toISOString()).toBe('2026-01-02T12:00:00.000Z');
  });
});
