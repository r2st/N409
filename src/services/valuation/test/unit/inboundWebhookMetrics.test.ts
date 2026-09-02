import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry, registerProblemHandler } from '@n409/shared';
import {
  recordInboundWebhook,
  refuseInboundWebhook,
  registerInboundWebhookMetrics,
  resetInboundWebhookMetrics,
} from '../../src/observability/inboundWebhooks.js';
import { registerEmailDeliveryRoutes } from '../../src/routes/emailDelivery.js';

/**
 * A webhook secret that has drifted (R329, methodology M11).
 *
 * The three inbound webhook doors are deliberately unauthenticated and
 * deliberately trusted: the whole of the authority behind each is a signature
 * header, checked against a secret held on two machines neither of which tells
 * the other when it changes. `webhookSignatureCensus` proves the check exists.
 * What nothing proved is that its *failure* is visible.
 *
 * It was not. A rotation in the Stripe dashboard that misses this deployment
 * refuses every delivery with `400 Invalid Stripe signature`; Stripe retries
 * for days and gives up. On this side no payment is fulfilled, no refund
 * recorded, no subscription changes state — and the only evidence anywhere is
 * a status class in `http_requests_total`, on a route whose ordinary traffic is
 * far too low for any error-rate rule to notice.
 *
 * `registerProblemHandler` logs 5xx and leaves 4xx silent on purpose: "those
 * describe the request, the caller was told, and logging them is logging other
 * people's mistakes at whatever rate they care to make them". That is right for
 * a browser and wrong for the one caller that is a machine — where the 4xx is
 * not the caller's mistake but ours, and the caller is the only party that can
 * see it.
 */

const SECRET = 'the-secret-this-deployment-holds';
const sign = (raw: string, secret: string) => createHmac('sha256', secret).update(raw).digest('hex');

async function buildEmailWebhook(): Promise<{
  app: FastifyInstance;
  registry: MetricsRegistry;
  lines: Array<{ obj: Record<string, unknown>; msg: string }>;
}> {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const app = Fastify({ logger: false });
  const registry = new MetricsRegistry();
  registerInboundWebhookMetrics(registry);
  // The admin half of this registrar is gated; the webhook is not, and it is
  // the only route these assertions reach.
  app.decorate('authenticate', async () => {});
  app.addHook('onRequest', (req, _reply, done) => {
    req.log = {
      ...req.log,
      warn: (obj: Record<string, unknown>, msg: string) => void lines.push({ obj, msg }),
    } as typeof req.log;
    done();
  });
  registerProblemHandler(app);
  registerEmailDeliveryRoutes(app, { pool: {} as never, webhookSecret: SECRET });
  await app.ready();
  return { app, registry, lines };
}

describe('the inbound webhook delivery counter', () => {
  afterEach(() => resetInboundWebhookMetrics());

  it('separates a stranger from a secret that has drifted', () => {
    // The distinction is the whole point. These URLs are written down in
    // PUBLIC_ROUTES and the internet scans them, so an unsigned POST is the
    // endpoint working. A *well-formed* signature that does not verify is the
    // provider calling with a key this deployment does not have.
    const registry = new MetricsRegistry();
    registerInboundWebhookMetrics(registry);

    recordInboundWebhook('stripe-payments', 'accepted');
    recordInboundWebhook('stripe-payments', 'bad_signature');
    recordInboundWebhook('stripe-payments', 'unsigned');
    recordInboundWebhook('email-delivery', 'unconfigured');

    const text = registry.render();
    expect(text).toContain('inbound_webhook_deliveries_total{source="stripe-payments",outcome="accepted"} 1');
    expect(text).toContain(
      'inbound_webhook_deliveries_total{source="stripe-payments",outcome="bad_signature"} 1',
    );
    expect(text).toContain('inbound_webhook_deliveries_total{source="stripe-payments",outcome="unsigned"} 1');
    expect(text).toContain(
      'inbound_webhook_deliveries_total{source="email-delivery",outcome="unconfigured"} 1',
    );
  });

  it('keeps `accepted` so a refusal count has a denominator', () => {
    // A bare refusal tally cannot separate one scanner POSTing junk from a
    // secret that has been wrong since Tuesday, and the number of events a
    // deployment receives per hour is not something a dashboard holds. Same
    // reason `background_sweep_runs_total` sits beside the failure count.
    const registry = new MetricsRegistry();
    registerInboundWebhookMetrics(registry);
    recordInboundWebhook('stripe-billing', 'accepted');
    expect(registry.render()).toContain('outcome="accepted"');
  });

  it('says in the log which refusals are ours, and stays quiet about the stranger', () => {
    const said: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { warn: (obj: Record<string, unknown>, msg: string) => void said.push({ obj, msg }) };

    refuseInboundWebhook(log, 'stripe-payments', 'unsigned');
    expect(said, 'a scanner must not choose how much this box logs').toEqual([]);

    refuseInboundWebhook(log, 'stripe-payments', 'bad_signature');
    expect(said).toHaveLength(1);
    expect(said[0]!.obj).toEqual({ source: 'stripe-payments', outcome: 'bad_signature' });
    expect(said[0]!.msg).toMatch(/drifted/);
  });

  it('counts even the refusals it does not log', () => {
    // The line and the series answer different questions: the scrape is what an
    // alert fires on, and `unsigned` is the denominator's other half.
    const registry = new MetricsRegistry();
    registerInboundWebhookMetrics(registry);
    refuseInboundWebhook({ warn: () => {} }, 'email-delivery', 'unsigned');
    expect(registry.render()).toContain(
      'inbound_webhook_deliveries_total{source="email-delivery",outcome="unsigned"} 1',
    );
  });

  it('is inert before registration rather than throwing', () => {
    // Every unit test that exercises a route without building the app reaches
    // these calls with nothing registered.
    expect(() => recordInboundWebhook('stripe-billing', 'accepted')).not.toThrow();
    expect(() => refuseInboundWebhook({ warn: () => {} }, 'stripe-billing', 'malformed')).not.toThrow();
  });
});

describe('the email delivery webhook, end to end', () => {
  afterEach(() => resetInboundWebhookMetrics());

  it('counts and names a signature computed with the wrong secret', async () => {
    const { app, registry, lines } = await buildEmailWebhook();
    const payload = JSON.stringify({ events: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/email/postmark',
      headers: {
        'content-type': 'application/json',
        'x-n409-signature': sign(payload, 'the-secret-the-provider-was-rotated-to'),
      },
      payload,
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(registry.render()).toContain(
      'inbound_webhook_deliveries_total{source="email-delivery",outcome="bad_signature"} 1',
    );
    expect(lines.map((l) => l.msg)).toContain(
      'inbound webhook refused: the signature did not verify — the sending secret and ours have drifted',
    );
  });

  it('leaves a request with no signature at all out of the log', async () => {
    const { app, registry, lines } = await buildEmailWebhook();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/email/postmark',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(registry.render()).toContain(
      'inbound_webhook_deliveries_total{source="email-delivery",outcome="unsigned"} 1',
    );
    expect(lines).toEqual([]);
  });

  /**
   * R346, methodology M6.
   *
   * This scope parses `application/json` as a raw Buffer so the HMAC covers the
   * bytes that arrived — which also means `app.ts`'s global `preValidation`
   * scan for text Postgres will not store never sees this body: the hook runs
   * against a Buffer and walks past it, and the object only exists inside the
   * handler.
   *
   * Without a scan of its own, a NUL in `detail` — free text a provider copies
   * out of a DSN — reached the `email_delivery_events` insert, the driver
   * refused it as `22021`, the per-event `catch` put the event in `unrecorded`,
   * and `unrecorded` is answered **503 "redeliver this batch"**. So the
   * provider redelivered, the same character failed the same insert, and the
   * batch sat in a retry loop nothing in it could leave. `parseStripeEvent`
   * scans its whole envelope for exactly this and answers 400; this door was
   * written to the same pattern without that half.
   */
  const signedPost = async (body: unknown) => {
    const { app, registry } = await buildEmailWebhook();
    const payload = JSON.stringify(body);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/email/postmark',
      headers: { 'content-type': 'application/json', 'x-n409-signature': sign(payload, SECRET) },
      payload,
    });
    await app.close();
    return { res, metrics: registry.render() };
  };

  it('refuses a NUL in a bounce message instead of asking for the batch again', async () => {
    const { res, metrics } = await signedPost({
      events: [
        {
          message_id: '01JBQ7F0000000000000000000',
          kind: 'bounced',
          detail: 'mailbox unavailable\u0000',
        },
      ],
    });

    // 400, not 503: this is a body a provider can be told about once.
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('events[0].detail');
    // And counted as unreadable, which is what the JSON parse failure beside it
    // is counted as, and what `parseStripeEvent`'s refusal is counted as.
    expect(metrics).toContain('inbound_webhook_deliveries_total{source="email-delivery",outcome="malformed"} 1');
  });

  it('refuses an unpaired surrogate anywhere in the batch, naming where', async () => {
    const { res } = await signedPost({
      events: [
        { message_id: '01JBQ7F0000000000000000000', kind: 'delivered' },
        { message_id: '01JBQ7F0000000000000000001', kind: 'bounced', status: '5.1.1', event_id: 'e\uD800' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('events[1].event_id');
  });

  it('lets an ordinary batch through to the schema as before', async () => {
    // The guard must not be the thing that refuses every payload: a body with
    // nothing unstorable in it still reaches the validation below it.
    const { res, metrics } = await signedPost({ events: [{ message_id: 'not-a-ulid', kind: 'delivered' }] });
    expect(res.statusCode).toBe(422);
    expect(metrics).toContain('inbound_webhook_deliveries_total{source="email-delivery",outcome="accepted"} 1');
  });

  it('counts a delivery that proved who it was, whatever the payload turns out to be', async () => {
    // The question this counter answers is whether the *sender* proved itself,
    // so a body refused on its own merits a line later is still an
    // authenticated delivery. Conflating the two would make a provider that
    // changed its payload shape read exactly like a rotated secret, and the two
    // have nothing to do with each other.
    const { app, registry } = await buildEmailWebhook();
    const payload = JSON.stringify({ events: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/email/postmark',
      headers: { 'content-type': 'application/json', 'x-n409-signature': sign(payload, SECRET) },
      payload,
    });
    await app.close();

    expect(res.statusCode, 'refused on the payload, not on who sent it').toBe(422);
    const text = registry.render();
    expect(text).toContain('inbound_webhook_deliveries_total{source="email-delivery",outcome="accepted"} 1');
    expect(text).not.toContain(
      'inbound_webhook_deliveries_total{source="email-delivery",outcome="bad_signature"}',
    );
  });
});
