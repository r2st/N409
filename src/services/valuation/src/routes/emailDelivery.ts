import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageUsers, isOps } from '../auth/rbac.js';
import {
  classifyDsnStatus,
  rateOrNull,
  type BounceKind,
  type DeliveryEventKind,
} from '../domain/emailDelivery.js';
import {
  deliveryStats,
  deliveryStatsByTemplate,
  listDeliveryEvents,
  listSuppressions,
  recordDeliveryEvent,
  releaseSuppression,
  suppressAddress,
} from '../repos/emailDelivery.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Delivery reporting, the suppression list, and provider event ingest (0163).
 *
 * The outbox knew what it handed to the relay and nothing after that. These
 * routes are the operator's half of fixing that: what the delivery figures
 * actually are, which addresses have been taken out of circulation and why, and
 * the one authenticated way for a downstream signal to get in.
 */

const StatsQuery = z.object({
  /**
   * Bounded at a year. The aggregate is a full scan of the window, and an
   * unbounded one is a dashboard tile that gets slower every month it runs.
   */
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const SuppressionsQuery = z.object({
  include_released: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const SuppressBody = z.object({
  address: z.string().trim().min(3).max(320).email('Not an email address'),
  reason: z.enum(['hard', 'soft', 'complaint']).default('hard'),
  detail: z.string().max(500).optional(),
});

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
const WebhookEvent = z.object({
  /** The outbox row this is about. */
  message_id: z.string().refine(isUlid, 'Not a message id'),
  kind: z.enum(['delivered', 'bounced', 'complained', 'deferred', 'opened']),
  /** ISO 8601. Defaults to now when a provider does not date its events. */
  occurred_at: z.string().datetime().optional(),
  /** The provider's own id, for idempotency across redeliveries. */
  event_id: z.string().max(200).optional(),
  /** RFC 3463 enhanced status (`5.1.1`), when the provider carries one. */
  status: z.string().max(20).optional(),
  bounce_kind: z.enum(['hard', 'soft', 'complaint']).optional(),
  detail: z.string().max(1000).optional(),
});

const WebhookBody = z.object({
  events: z.array(WebhookEvent).min(1).max(500),
});

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
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });

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
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    return {
      suppressions: await listSuppressions(deps.pool, {
        includeReleased: parsed.data.include_released,
        limit: parsed.data.limit,
      }),
    };
  });

  app.post('/api/v1/admin/email/suppressions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden('Only administrators can suppress an address');
    const parsed = SuppressBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid suppression', { errors: parsed.error.issues });

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
   */
  app.delete(
    '/api/v1/admin/email/suppressions/:address',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      if (!canManageUsers(principal))
        throw problems.forbidden('Only administrators can release a suppression');
      const { address } = req.params as { address: string };
      const released = await releaseSuppression(deps.pool, address, principal.id);
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
        throw problems.serviceUnavailable(
          'Delivery webhooks are not configured (EMAIL_WEBHOOK_SECRET unset)',
        );
      }
      const { provider } = req.params as { provider: string };
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(provider)) {
        throw problems.badRequest('Not a provider name');
      }

      const raw = req.body as Buffer;
      const provided = req.headers['x-n409-signature'];
      if (typeof provided !== 'string' || !Buffer.isBuffer(raw)) {
        throw problems.unauthorized('Missing signature');
      }
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      if (!signatureMatches(expected, provided)) {
        throw problems.unauthorized('Bad signature');
      }

      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw problems.badRequest('Invalid webhook payload');
      }
      const parsed = WebhookBody.safeParse(body);
      if (!parsed.success) {
        throw problems.unprocessable('Invalid delivery events', { errors: parsed.error.issues });
      }

      let applied = 0;
      let duplicates = 0;
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

        const fresh = await recordDeliveryEvent(deps.pool, {
          outboxId: event.message_id,
          kind: event.kind as DeliveryEventKind,
          occurredAt: event.occurred_at ? new Date(event.occurred_at) : new Date(),
          source: `webhook:${provider}`,
          providerEventId: event.event_id ?? null,
          bounceKind,
          detail: event.detail ?? null,
        });

        if (fresh) {
          applied += 1;
          // A terminal bounce reported by a provider suppresses the address,
          // exactly as one reported by the relay in-band does. Read back
          // rather than trusted from the request: the address belongs to the
          // outbox row, and taking it from the payload would let a caller who
          // can forge one message id suppress an address of their choosing.
          if (bounceKind === 'hard' || bounceKind === 'complaint') {
            const { rows } = await deps.pool.query<{ to_email: string }>(
              'SELECT to_email FROM email_outbox WHERE id = $1',
              [event.message_id],
            );
            const address = rows[0]?.to_email;
            if (address) {
              await suppressAddress(deps.pool, {
                address,
                reason: bounceKind,
                detail: event.detail ?? `reported by ${provider}`,
                outboxId: event.message_id,
              });
            }
          }
        } else {
          duplicates += 1;
        }
      }

      // 2xx even for duplicates: a provider that does not get one redelivers,
      // and telling it "already had this" as an error earns an escalating
      // retry for a message we have correctly recorded.
      return reply.code(202).send({ applied, duplicates });
    });
  });
}
