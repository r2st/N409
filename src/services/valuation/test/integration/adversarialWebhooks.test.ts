import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const SECRET = 'whsec_adversarial';

/** Both endpoints, because both parsed the envelope the same wrong way. */
const ENDPOINTS = ['/api/v1/stripe/webhook', '/api/v1/billing/webhook'] as const;

function signed(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

/**
 * Round 182, methodology M6: what a *signed* webhook delivery of the wrong
 * shape is answered with.
 *
 * The signature check was never the gap — it is here and it works, and the
 * replay ledger under it is R160's. The gap was everything after it: both
 * routes cast `JSON.parse`'s result to the shape they wanted and then read it
 * as though the cast had checked something. Four shapes of valid JSON reached a
 * 500 that way.
 *
 * A 500 is the worst available answer at this particular boundary. Stripe reads
 * a 5xx as "not delivered" and re-sends on its retry ladder for days, so an
 * event that will never insert becomes a standing redelivery nobody is watching
 * — where the 400 below is recorded once against the endpoint and dropped.
 */
describe.skipIf(!dbUp)('adversarial Stripe webhook deliveries', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: SECRET });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (url: string, payload: string, headers = signed(payload)) =>
    ctx.app.inject({ method: 'POST', url, headers, payload });

  describe.each(ENDPOINTS)('%s', (url) => {
    it('refuses a body that is valid JSON but not an object', async () => {
      // `null` is the one that mattered: `event.data?.object` is a TypeError on
      // it, because optional chaining guards a missing `data`, not a missing
      // `event`.
      for (const raw of ['null', '[1,2,3]', '"hello"', '42']) {
        const res = await deliver(url, raw);
        expect(res.statusCode, `${raw}: ${res.body.slice(0, 120)}`).toBe(400);
        expect(res.json().detail).toContain('not a JSON object');
      }
    });

    it('refuses a non-string event type', async () => {
      const res = await deliver(url, '{"id":"evt_t","type":123,"data":{"object":{}}}');
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('type is not a string');
    });

    /**
     * The global NUL hook cannot reach either endpoint: both register a
     * `parseAs: 'buffer'` content parser so the raw bytes survive for signature
     * verification, and the hook sees a Buffer and skips it by design. The
     * strings only exist after the `JSON.parse` inside the handler, and the
     * event id and object id are `text` columns in `stripe_events`.
     */
    it('refuses a NUL byte in the ledger keys, naming the field', async () => {
      const id = await deliver(
        url,
        '{"id":"evt_\\u0000x","type":"invoice.paid","data":{"object":{"id":"in_1"}}}',
      );
      expect(id.statusCode).toBe(400);
      expect(id.json().detail).toContain('field id contains a NUL byte');

      const obj = await deliver(
        url,
        '{"id":"evt_n","type":"customer.subscription.updated","data":{"object":{"id":"sub_\\u0000x"}}}',
      );
      expect(obj.statusCode).toBe(400);
      expect(obj.json().detail).toContain('field data.object.id');
    });

    it('refuses a malformed or empty body', async () => {
      for (const raw of ['{not json', '']) {
        const res = await deliver(url, raw);
        expect(res.statusCode, raw).toBe(400);
      }
    });

    it('refuses an unsigned or tampered delivery', async () => {
      const payload = '{"id":"evt_s","type":"invoice.upcoming","data":{"object":{}}}';
      const tampered = await deliver(url, payload, {
        ...signed(payload),
        'stripe-signature': 't=1,v1=deadbeef',
      });
      expect(tampered.statusCode).toBe(400);
      expect(tampered.json().detail).toContain('signature');

      const unsigned = await deliver(url, payload, { 'content-type': 'application/json' });
      expect(unsigned.statusCode).toBe(400);

      // The body of a tampered delivery must not have been acted on: a signature
      // that did not verify says nothing about what the payload claims.
      const other = await deliver(url, JSON.stringify({ id: 'evt_s2', type: 'x' }), {
        ...signed('{}'),
      });
      expect(other.statusCode).toBe(400);
    });

    it('bounds the body rather than buffering whatever arrives', async () => {
      const huge = JSON.stringify({
        id: 'evt_h',
        type: 'invoice.paid',
        data: { object: { id: 'in_h', pad: 'x'.repeat(2 * 1024 * 1024) } },
      });
      const res = await deliver(url, huge);
      expect(res.statusCode).toBe(413);
    });

    /** An event we do not handle is dealt with, not an error and not a retry. */
    it('acknowledges an event type it does not handle', async () => {
      const res = await deliver(
        url,
        '{"id":"evt_u","type":"radar.early_fraud_warning.created","data":{"object":{"id":"issfr_1"}}}',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().received).toBe(true);
    });

    /** Stripe delivers at least once; the second delivery must cost nothing. */
    it('answers a redelivery as a duplicate', async () => {
      const payload =
        '{"id":"evt_r","type":"radar.early_fraud_warning.created","data":{"object":{"id":"issfr_2"}}}';
      const first = await deliver(url, payload);
      expect(first.statusCode).toBe(200);
      const second = await deliver(url, payload);
      expect(second.statusCode).toBe(200);
      expect(second.json().duplicate).toBe(true);
    });

    /**
     * Out of order. `checkout.session.completed` arriving after the
     * `payment_intent` events it precedes, and a subscription snapshot arriving
     * after a newer one, are both ordinary on Stripe's retry ladder — neither
     * may be a 500, whatever the handler decides to do with them.
     */
    it('does not error on an event whose predecessor never arrived', async () => {
      for (const type of [
        'checkout.session.async_payment_succeeded',
        'charge.refunded',
        'charge.dispute.closed',
        'invoice.payment_failed',
        'customer.subscription.deleted',
      ]) {
        const res = await deliver(
          url,
          JSON.stringify({
            id: `evt_o_${type}`,
            type,
            created: 1767355200,
            data: { object: { id: `obj_${type}` } },
          }),
        );
        expect(res.statusCode, `${type}: ${res.body.slice(0, 160)}`).toBeLessThan(500);
      }
    });

    /** `__proto__` in a signed payload must not reach Object.prototype. */
    it('does not pollute the prototype from an event body', async () => {
      const res = await deliver(
        url,
        '{"id":"evt_p","type":"invoice.paid","data":{"object":{"id":"in_p","__proto__":{"n409Polluted":true}}}}',
      );
      expect(res.statusCode).toBeLessThan(500);
      expect(({} as Record<string, unknown>).n409Polluted).toBeUndefined();
    });
  });
});
