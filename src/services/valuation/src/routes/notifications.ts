import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { NOTIFICATION_EVENT_TYPES } from '../domain/emailWorkflows.js';
import { listNotifications, markAllRead, markRead, unreadCount } from '../repos/notifications.js';
import { getPreferenceMatrix, replacePreferences } from '../repos/notificationPreferences.js';
import { listOutbox, type EmailOutboxRow } from '../repos/emailOutbox.js';
import { deliveryStateOf } from '../domain/emailDelivery.js';
import { flagParam } from '../domain/queryFlag.js';
import { requirePrincipal } from '../plugins/auth.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { ulidField } from '../domain/ulidField.js';

/**
 * In-app notifications (M4, P2 #27). Strictly per-user: every query is scoped
 * to the authenticated principal, so there is nothing to authorize beyond
 * authentication itself. Plus an ops-only window into the email outbox.
 */

const ListQuery = z.object({
  unread: flagParam(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const PreferencesBody = z
  .object({
    preferences: z
      .array(
        z
          .object({
            event_type: z.enum(NOTIFICATION_EVENT_TYPES),
            in_app: z.boolean(),
            email: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(NOTIFICATION_EVENT_TYPES.length),
  })
  .strict();

const OutboxQuery = z.object({
  status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
  valuation_id: ulidField().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function registerNotificationRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/notifications', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const [notifications, unread] = await Promise.all([
      listNotifications(deps.pool, principal.id, {
        unreadOnly: parsed.data.unread,
        limit: parsed.data.limit,
      }),
      unreadCount(deps.pool, principal.id),
    ]);
    return { notifications, unread_count: unread };
  });

  app.get('/api/v1/notifications/unread-count', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { unread_count: await unreadCount(deps.pool, principal.id) };
  });

  app.post('/api/v1/notifications/:id/read', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const notification = await markRead(deps.pool, principal.id, id);
    if (!notification) throw problems.notFound();
    return { notification };
  });

  app.post('/api/v1/notifications/read-all', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { marked: await markAllRead(deps.pool, principal.id) };
  });

  // ── Notification preferences (P2 #11) — strictly self-scoped ──────────────

  app.get('/api/v1/me/notification-preferences', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { preferences: await getPreferenceMatrix(deps.pool, principal.id) };
  });

  app.put('/api/v1/me/notification-preferences', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = PreferencesBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid preferences', parsed.error);
    await replacePreferences(deps.pool, principal.id, parsed.data.preferences);
    return { preferences: await getPreferenceMatrix(deps.pool, principal.id) };
  });

  /**
   * The outbox row minus the thing it must not publish: the rendered message.
   *
   * `listOutbox` is `SELECT *`, and `email_outbox.body` is the fully rendered
   * text that went to the recipient — which for the transactional half of this
   * table means a live bearer credential. `POST /auth/forgot-password` writes
   * `…/reset-password#token=<secret>` into it; so do the email-verification
   * link, the invitation link, the board member's signing link, the auditor
   * portal link and a client's intake link. Every one of those is redeemable by
   * whoever holds the string, and the rows are kept for a year (0083).
   *
   * The route is `isOps`, which is twelve roles — `reviewer`,
   * `contributing_reviewer`, `data`, `support`, `auto`, `spa` among them — and
   * none of those can administer a user through any other door. So the page
   * that exists to answer "did that email go out" was also answering "reset any
   * administrator's password": request a reset for them, open the outbox,
   * follow the link. `GET /admin/api-tokens` is gated on `canManageUsers` for
   * exactly this reason, in a comment that names the same two roles.
   *
   * Dropped rather than the route being narrowed, because narrowing it would
   * take a real ops tool away from the people who use it and would still leave
   * the credentials sitting behind one more role. Delivery observability is
   * `status`, `delivery_state`, `attempts`, `error`, `to_email`, `subject` and
   * `template_key`; the body is not one of the facts this page reports, and the
   * console has never rendered it. An operator who needs to see what a template
   * produces has `POST /admin/communication-templates/:id/preview`, which
   * renders against supplied variables rather than against a real send.
   */
  const withoutBody = (row: EmailOutboxRow): Omit<EmailOutboxRow, 'body'> & { body_length: number } => {
    const { body, ...rest } = row;
    // Kept as a length so "the template rendered empty" stays visible — that is
    // a delivery fault an operator has to be able to see, and it was previously
    // read off the body itself.
    return { ...rest, body_length: body?.length ?? 0 };
  };

  // Ops window into the auto-email outbox (P1 #21 observability).
  app.get('/api/v1/admin/email-outbox', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Email outbox is operations-only');
    const parsed = OutboxQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const emails = await listOutbox(deps.pool, {
      status: parsed.data.status,
      valuationId: parsed.data.valuation_id,
      limit: parsed.data.limit,
    });
    // `status` is what the platform did with the message; `delivery_state` is
    // what became of it. Derived here rather than in the browser so the rule
    // for which fact supersedes which lives in exactly one place — a complaint
    // outranking a delivery is a judgement, not a formatting choice.
    return { emails: emails.map((e) => ({ ...withoutBody(e), delivery_state: deliveryStateOf(e) })) };
  });
}
