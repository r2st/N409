import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { listActivity } from '../repos/activityLog.js';
import { requirePrincipal } from '../plugins/auth.js';
import { pageParam } from '../domain/pagination.js';
import { checkWindowOrder, dateWindowFields } from '../domain/dateWindow.js';

/**
 * Global activity audit viewer (P2 #12): one ops-only feed over
 * valuation_events (per-valuation timeline spine) and admin_events
 * (user/partner/prompt/template administration), filterable and paged.
 */

const ListQuery = z.object({
  scope: z.enum(['valuations', 'admin', 'all']).default('all'),
  valuation_id: z.string().optional(),
  actor_id: z.string().optional(),
  actor_type: z.enum(['human', 'ai', 'engine', 'system']).optional(),
  type: z.string().max(100).optional(),
  source: z.string().max(100).optional(),
  ...dateWindowFields,
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine(checkWindowOrder);

export function registerAdminEventRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/admin/events', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('The activity log is operations-only');

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const q = parsed.data;

    const { items, total } = await listActivity(deps.pool, {
      scope: q.scope,
      valuationId: q.valuation_id,
      actorId: q.actor_id,
      actorType: q.actor_type,
      type: q.type,
      source: q.source,
      from: q.from,
      to: q.to,
      page: q.page,
      perPage: q.per_page,
    });
    return { events: items, page: q.page, per_page: q.per_page, total };
  });
}
