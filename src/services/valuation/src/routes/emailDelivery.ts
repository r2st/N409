import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageUsers, isOps } from '../auth/rbac.js';
import { isForeignKeyViolation } from '../db/pgError.js';
import {
  classifyDsnStatus,
  deliveryEventFingerprint,
  rateOrNull,
  type BounceKind,
  type DeliveryEventKind,
} from '../domain/emailDelivery.js';
import {
  deliveryStats,
  deliveryStatsByTemplate,
  listDeliveryEvents,
  listSuppressions,
  SUPPRESSION_PAGE_LIMIT,
  recordDeliveryEvent,
  releaseSuppression,
  suppressAddress,
} from '../repos/emailDelivery.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  recordInboundWebhook,
  refuseInboundWebhook,
  type InboundWebhookSource,
} from '../observability/inboundWebhooks.js';
import { requirePrincipal } from '../plugins/auth.js';
import { flagParam } from '../domain/queryFlag.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { ulidField } from '../domain/ulidField.js';
import { findUnstorableText, unstorableTextMessage } from '../domain/nulBytes.js';

/**
 * Delivery reporting, the suppression list, and provider event ingest (0163).
 *
 * The outbox knew what it handed to the relay and nothing after that. These
 * routes are the operator's half of fixing that: what the delivery figures
 * actually are, which addresses have been taken out of circulation and why, and
 * the one authenticated way for a downstream signal to get in.
 */

/** This handler's door, in the inbound-webhook counter's vocabulary. */
const WEBHOOK_SOURCE: InboundWebhookSource = 'email-delivery';

const StatsQuery = z.object({
  /**
   * Bounded at a year. The aggregate is a full scan of the window, and an
   * unbounded one is a dashboard tile that gets slower every month it runs.
   */
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const SuppressionsQuery = z.object({
  include_released: flagParam(false),
  limit: z.coerce.number().int().min(1).max(SUPPRESSION_PAGE_LIMIT).default(100),
});

const SuppressBody = z
  .object({
    address: z.string().trim().min(3).max(320).email('Not an email address'),
    reason: z.enum(['hard', 'soft', 'complaint']).default('hard'),
    detail: z.string().max(500).optional(),
  })
  .strict();

/**
 * One provider event, in the shape this platform accepts.
 *
 * Deliberately *not* any particular provider's schema. There is no provider
 * configured today — the transport is raw SMTP — so encoding SES's envelope or
 * SendGrid's array would be guessing at which one a future deployment picks and
 * getting it wrong for the other. A thin normalised shape means adding a
 * provider is a small adapter in front of this rather than a change to the
 * ledger.
 */
const WebhookEvent = z
  .object({
    /** The outbox row this is about. */
    message_id: ulidField(),
    kind: z.enum(['delivered', 'bounced', 'complained', 'deferred', 'opened']),
    /** ISO 8601. Defaults to now when a provider does not date its events. */
    occurred_at: z.string().datetime().optional(),
    /** The provider's own id, for idempotency across redeliveries. */
    event_id: z.string().max(200).optional(),
    /** RFC 3463 enhanced status (`5.1.1`), when the provider carries one. */
    status: z.string().max(20).optional(),
    bounce_kind: z.enum(['hard', 'soft', 'complaint']).optional(),
    detail: z.string().max(1000).optional(),
  })
  .strict();

const WebhookBody = z
  .object({
    events: z.array(WebhookEvent).min(1).max(500),
  })
  .strict();

/**
 * Constant-time equality for the webhook signature.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a length
 * oracle if it escaped as a 500 — so the lengths are compared first and a
 * mismatch is simply "not equal".
 */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerEmailDeliveryRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; webhookSecret?: string },
): void {
  /* ---------------------------------------------------------------- *
   * Reporting
   * ---------------------------------------------------------------- */

  app.get('/api/v1/admin/email/delivery-stats', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Delivery statistics are operations-only');
    const parsed = StatsQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);

    const [totals, byTemplate] = await Promise.all([
      deliveryStats(deps.pool, parsed.data.days),
      deliveryStatsByTemplate(deps.pool, parsed.data.days),
    ]);

    // Rates are derived here rather than in SQL, and are null below the floor —
    // a dashboard reporting "0% delivered" off two messages sends somebody to
    // investigate an outage that is not happening.
    const attempted = totals.sent + totals.failed;
    return {
      totals,
      rates: {
        // Of what we handed over, how much is confirmed to have arrived. The
        // denominator is `sent` and not `total`: a queued message has not been
        // attempted and a skipped one never will be, and counting either
        // against the delivery rate reports a suppression as a failure.
        delivered: rateOrNull(totals.delivered, totals.sent),
        bounced: rateOrNull(totals.bounced + totals.complained, totals.sent),
        opened: rateOrNull(totals.opened, totals.delivered),
        // Transport-level: how often a send attempt failed outright.
        send_failure: rateOrNull(totals.failed, attempted),
      },
      by_template: byTemplate,
    };
  });

  app.get('/api/v1/admin/email-outbox/:id/delivery-events', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Delivery events are operations-only');
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.badRequest('Not a message id');
    return { events: await listDeliveryEvents(deps.pool, id) };
  });

  /* ---------------------------------------------------------------- *
   * The suppression list
   * ---------------------------------------------------------------- */

  app.get('/api/v1/admin/email/suppressions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('The suppression list is operations-only');
    const parsed = SuppressionsQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    return listSuppressions(deps.pool, {
      includeReleased: parsed.data.include_released,
      limit: parsed.data.limit,
    });
  });

  app.post('/api/v1/admin/email/suppressions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden('Only administrators can suppress an address');
    const parsed = SuppressBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid suppression', parsed.error);

    await suppressAddress(deps.pool, {
      address: parsed.data.address,
      reason: parsed.data.reason,
      detail: parsed.data.detail ?? 'added by an administrator',
    });
    await recordAdminEvent(deps.pool, {
      type: 'email_address_suppressed',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'system',
      subjectId: null,
      // The address itself is PII and is deliberately not the label; the row it
      // wrote is the record, and the admin console reads that.
      subjectLabel: 'Email suppression',
      payload: { reason: parsed.data.reason },
    });
    return { suppressed: true };
  });

  /**
   * Lifting a suppression is the recovery path for a wrong one, so it is
   * audited and restricted to the same bar as the user console. The row is
   * kept, released rather than deleted — "this was suppressed and an admin
   * lifted it" is exactly the history somebody will want later.
   *
   * The address travels in the body, and it used to be a path parameter on a
   * `DELETE`. Two things were wrong with that. Fastify's router refuses a path
   * parameter longer than `maxParamLength`, which is 100; an address is valid
   * to 320 (RFC 5321, and what the suppressing schema accepts), so an
   * address of 101 characters or more could be suppressed — by an admin here,
   * or by a provider bounce, which needs no admin at all — and then never
   * released through the API. A hard bounce was permanent for exactly the
   * addresses nobody could do anything about.
   *
   * The second is that an address is PII and a path is the part of a request
   * everything logs. Suppressing already keeps the address out of the audit
   * label for that reason; releasing put it in the URL. A body is read by the
   * handler and nothing else.
   *
   * `POST .../release` rather than `DELETE`, because that is what it does:
   * this endpoint has never deleted the row, and no client depended on the old
   * shape — nothing in the SPA called it.
   */
  app.post(
    '/api/v1/admin/email/suppressions/release',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      if (!canManageUsers(principal))
        throw problems.forbidden('Only administrators can release a suppression');
      // The suppressing schema's own address field, so the two can never
      // diverge: an address this service accepted a suppression for is by
      // construction one it will accept a release for.
      const parsed = z.object({ address: SuppressBody.shape.address }).strict().safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid address', parsed.error);
      const released = await releaseSuppression(deps.pool, parsed.data.address, principal.id);
      if (!released) throw problems.notFound('No active suppression for that address');

      await recordAdminEvent(deps.pool, {
        type: 'email_suppression_released',
        actor: { actorType: 'human', actorId: principal.id },
        subjectType: 'system',
        subjectId: null,
        subjectLabel: 'Email suppression',
        payload: {},
      });
      return reply.code(204).send();
    },
  );

  /* ---------------------------------------------------------------- *
   * Provider ingest
   * ---------------------------------------------------------------- */

  /**
   * Where a downstream delivery signal gets in.
   *
   * Unauthenticated in the session sense — a provider has no login — so the
   * whole of its authority is an HMAC over the raw body against a shared
   * secret. Three consequences, each deliberate:
   *
   *   * with no secret configured it refuses everything, 503, before reading
   *     the body. An endpoint that accepted unsigned delivery claims would let
   *     anyone mark a named client's address as bounced, which suppresses it —
   *     a denial of service against one client, from the internet, with no
   *     account. Registered unconditionally and refusing at request time
   *     rather than not registered at all, which is how the Stripe webhooks
   *     handle the same question: a route that appears and disappears with the
   *     environment cannot be audited by `routeAudit`, and an exemption with
   *     no site behind it is exactly what its staleness check exists to catch.
   *   * the signature is over the raw body, so it covers exactly the bytes
   *     that were parsed.
   *   * a bad signature is 401 with no detail. Which of secret, encoding or
   *     payload was wrong is not a caller's business.
   */
  // Its own plugin scope, so the raw-buffer content parser signature
  // verification needs cannot leak to any other route. Same containment as the
  // Stripe webhook, for the same reason.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/api/v1/webhooks/email/:provider', async (req, reply) => {
      const secret = deps.webhookSecret;
      if (!secret) {
        // Unauthenticated, like the two Stripe webhooks beside it: the caller
        // is the provider or it is a stranger, and the stranger learned the
        // name of an unset secret by asking. The provider retries on either
        // body; the operator reads the log — and, since R329, so does the
        // scrape, because the log is not the alerting channel on this box.
        refuseInboundWebhook(req.log, WEBHOOK_SOURCE, 'unconfigured');
        throw problems.serviceUnavailable('Delivery webhooks are not configured.');
      }
      const { provider } = req.params as { provider: string };
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(provider)) {
        throw problems.badRequest('Not a provider name');
      }

      const raw = req.body as Buffer;
      const provided = req.headers['x-n409-signature'];
      if (typeof provided !== 'string' || !Buffer.isBuffer(raw)) {
        refuseInboundWebhook(req.log, WEBHOOK_SOURCE, 'unsigned');
        throw problems.unauthorized('Missing signature');
      }
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      if (!signatureMatches(expected, provided)) {
        // The provider holding a key this deployment does not have. Every
        // bounce and complaint is being dropped, a suppression that should have
        // happened does not, and until R329 the only trace was a 401 in the
        // status histogram. See observability/inboundWebhooks.ts.
        refuseInboundWebhook(req.log, WEBHOOK_SOURCE, 'bad_signature');
        throw problems.unauthorized('Bad signature');
      }

      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        refuseInboundWebhook(req.log, WEBHOOK_SOURCE, 'malformed');
        throw problems.badRequest('Invalid webhook payload');
      }
      /*
       * The service's own boundary guard does not run here, and this is the
       * one shape of route where that is true. `preValidation` scans the parsed
       * body for text Postgres will not store (app.ts, domain/nulBytes.ts) —
       * but a signature has to be verified over the bytes that arrived, so this
       * scope parses `application/json` as a raw Buffer, the hook sees a Buffer
       * and walks straight past it, and the object only exists after the line
       * above. `parseStripeEvent` scans its own envelope for exactly this
       * reason; this door was written to the same pattern without that half.
       *
       * The cost is not a lost row. `detail` is free text a provider copies out
       * of a DSN, and a NUL or an unpaired surrogate in one of them fails the
       * `email_delivery_events` insert, which the per-event `catch` below turns
       * into `unrecorded` — and `unrecorded` is answered 503 "redeliver this
       * batch". So the provider redelivers, the same character fails the same
       * insert, and the batch is in a retry loop nothing in it can leave. A 400
       * ends it: the payload is malformed, which is a thing a provider can be
       * told once.
       *
       * Counted as `malformed` alongside the JSON parse failure above, because
       * that is what it is — the body is not one this platform can read.
       */
      const unstorable = findUnstorableText(body);
      if (unstorable) {
        refuseInboundWebhook(req.log, WEBHOOK_SOURCE, 'malformed');
        throw problems.badRequest(unstorableTextMessage(unstorable));
      }
      recordInboundWebhook(WEBHOOK_SOURCE, 'accepted');
      const parsed = WebhookBody.safeParse(body);
      if (!parsed.success) {
        throw invalidBody('Invalid delivery events', parsed.error);
      }

      /**
       * Per event, because the batch is up to 500 of them and they are
       * independent claims about 500 different messages.
       *
       * One event naming a message this deployment does not have is an
       * ordinary occurrence — the outbox is pruned by retention, and a
       * provider will report on a message weeks after it was sent — and it is
       * a foreign-key violation on `outbox_id`. That rejection used to escape
       * the loop, so the batch answered 500 having applied every event before
       * the bad one and none after it, and the provider then redelivered the
       * whole batch into the same violation, forever: the events *after* the
       * unknown one could never land, and nothing in the ledger said why.
       *
       * So an unknown message is counted and skipped, and only a failure we
       * cannot characterise is worth a redelivery.
       */
      let applied = 0;
      let duplicates = 0;
      let unknown = 0;
      const unrecorded: string[] = [];
      for (const event of parsed.data.events) {
        // The provider's own classification is taken when it gives one;
        // otherwise the enhanced status is read; otherwise a bounce with no
        // evidence either way is treated as soft, because suppressing an
        // address on a provider's unqualified "bounced" is the false positive
        // this subsystem is most likely to produce.
        const bounceKind: BounceKind | null =
          event.bounce_kind ??
          (event.status ? classifyDsnStatus(event.status) : null) ??
          (event.kind === 'complained' ? 'complaint' : event.kind === 'bounced' ? 'soft' : null);

        // An event the provider did not identify is still the same event when
        // it redelivers the batch. See `deliveryEventFingerprint`: without one
        // of these, `(source, provider_event_id)` is `(webhook:x, NULL)`, which
        // collides with nothing, and a retried batch counted every open again.
        const providerEventId =
          event.event_id ??
          deliveryEventFingerprint({
            messageId: event.message_id,
            kind: event.kind as DeliveryEventKind,
            occurredAt: event.occurred_at ?? null,
            bounceKind,
            status: event.status ?? null,
            detail: event.detail ?? null,
          });

        let fresh: boolean;
        try {
          fresh = await recordDeliveryEvent(deps.pool, {
            outboxId: event.message_id,
            kind: event.kind as DeliveryEventKind,
            occurredAt: event.occurred_at ? new Date(event.occurred_at) : new Date(),
            source: `webhook:${provider}`,
            providerEventId,
            bounceKind,
            detail: event.detail ?? null,
          });
        } catch (err) {
          if (isForeignKeyViolation(err, 'email_delivery_events_outbox_id_fkey')) {
            unknown += 1;
            // Not a warning. The message id is a real one that we no longer
            // hold, and an operator reading warnings should not be reading
            // 500 lines of retention doing its job.
            req.log.info(
              { provider, messageId: event.message_id, kind: event.kind },
              'delivery event names a message this deployment no longer has',
            );
            continue;
          }
          unrecorded.push(event.message_id);
          req.log.error(
            { err, provider, messageId: event.message_id, kind: event.kind },
            'delivery event could not be recorded',
          );
          continue;
        }

        if (fresh) applied += 1;
        else duplicates += 1;

        /*
         * A terminal bounce reported by a provider suppresses the address,
         * exactly as one reported by the relay in-band does. Read back rather
         * than trusted from the request: the address belongs to the outbox row,
         * and taking it from the payload would let a caller who can forge one
         * message id suppress an address of their choosing.
         *
         * The suppression is a second write, after the event's transaction has
         * committed, and it used to run only on a fresh insert. Both halves of
         * that were wrong in the same way. It sat outside the isolation above,
         * so a transient failure here — the one query in the loop that is not
         * `recordDeliveryEvent`'s — took the rest of the batch down with it;
         * and because the event was already committed, the provider's
         * redelivery arrived as a *duplicate*, took the `else` branch, and the
         * suppression was never attempted again. A hard bounce recorded and
         * never suppressed is the exact state this subsystem exists to prevent:
         * the ladder goes on spending six attempts on a dead address, and
         * nothing on the outbox row says the follow-through was dropped.
         *
         * So a duplicate terminal bounce still tries, under `onlyIfAbsent` — it
         * can finish work that stopped half-way, and it cannot re-suppress an
         * address an administrator has released, because a redelivered event is
         * not the second bounce that would justify overriding them.
         */
        if (bounceKind === 'hard' || bounceKind === 'complaint') {
          try {
            const { rows } = await deps.pool.query<{ to_email: string }>(
              'SELECT to_email FROM email_outbox WHERE id = $1',
              [event.message_id],
            );
            const address = rows[0]?.to_email;
            if (address) {
              await suppressAddress(
                deps.pool,
                {
                  address,
                  reason: bounceKind,
                  detail: event.detail ?? `reported by ${provider}`,
                  outboxId: event.message_id,
                },
                { onlyIfAbsent: !fresh },
              );
            }
          } catch (err) {
            unrecorded.push(event.message_id);
            req.log.error(
              { err, provider, messageId: event.message_id, bounceKind, alert: true },
              'bounce recorded but the address could not be suppressed',
            );
          }
        }
      }

      /**
       * Anything we could not characterise is worth the redelivery a 5xx
       * earns: the events that did land carry an idempotency key on both
       * paths now (the provider's, or the fingerprint), so the retry re-applies
       * nothing. An unknown message is not one of these — redelivering it would
       * only reproduce the same violation.
       */
      if (unrecorded.length > 0) {
        throw problems.serviceUnavailable(
          `${unrecorded.length} of ${parsed.data.events.length} events could not be recorded — redeliver this batch`,
        );
      }

      // 2xx even for duplicates: a provider that does not get one redelivers,
      // and telling it "already had this" as an error earns an escalating
      // retry for a message we have correctly recorded. `unknown` is reported
      // rather than folded into `duplicates`: a provider integration counting
      // its own acknowledgements should be able to see that we dropped one.
      return reply.code(202).send({ applied, duplicates, unknown });
    });
  });
}
