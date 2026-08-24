import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { NOTIFICATION_EVENT_TYPES } from '../domain/emailWorkflows.js';
import { listNotifications, markAllRead, markRead, unreadCount } from '../repos/notifications.js';
import { getPreferenceMatrix, replacePreferences } from '../repos/notificationPreferences.js';
import { listOutbox } from '../repos/emailOutbox.js';
import { flagParam } from '../domain/queryFlag.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * In-app notifications (M4, P2 #27). Strictly per-user: every query is scoped
 * to the authenticated principal, so there is nothing to authorize beyond
 * authentication itself. Plus an ops-only window into the email outbox.
 */

const ListQuery = z.object({
  unread: flagParam(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const PreferencesBody = z.object({
  preferences: z
    .array(
      z.object({
        event_type: z.enum(NOTIFICATION_EVENT_TYPES),
        in_app: z.boolean(),
        email: z.boolean(),
      }),
    )
    .min(1)
    .max(NOTIFICATION_EVENT_TYPES.length),
});

const OutboxQuery = z.object({
  status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
  valuation_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function registerNotificationRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/notifications', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
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
    if (!parsed.success) throw problems.unprocessable('Invalid preferences', { errors: parsed.error.issues });
    await replacePreferences(deps.pool, principal.id, parsed.data.preferences);
    return { preferences: await getPreferenceMatrix(deps.pool, principal.id) };
  });

  // Ops window into the auto-email outbox (P1 #21 observability).
  app.get('/api/v1/admin/email-outbox', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Email outbox is operations-only');
    const parsed = OutboxQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const emails = await listOutbox(deps.pool, {
      status: parsed.data.status,
      valuationId: parsed.data.valuation_id,
      limit: parsed.data.limit,
    });
    return { emails };
  });
}
