import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { JOB_SOURCES, JOB_SOURCE_LABELS, JOB_STATUSES, summarizeJobStats } from '../domain/jobQueue.js';
import { pageParam } from '../domain/pagination.js';
import { jobStats, listJobs, oldestActiveJobs } from '../repos/jobs.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * The background job monitor (409.ai's Published Tasks page).
 *
 * Read-only, and deliberately so. Every one of the five queues already has its
 * own retry path — `POST /admin/outbox/retry`, `POST /admin/webhooks/retry`,
 * `POST /valuations/:id/pipeline/runs` — each of which knows what re-running
 * that particular kind of work means. A generic "retry this row" button here
 * would have to guess, and guessing wrong on an outbox row sends a client a
 * second copy of an email.
 *
 * Ops-only: the rows carry error text from every engagement on the platform.
 */
export function registerJobRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const requireOps = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('The job monitor is operations-only');
    return principal;
  };

  const ListQuery = z.object({
    source: z.enum(JOB_SOURCES).optional(),
    status: z.enum(JOB_STATUSES).optional(),
    valuation_id: z.string().optional(),
    page: pageParam(),
    per_page: z.coerce.number().int().min(1).max(100).default(25),
  });

  app.get('/api/v1/admin/jobs', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const q = parsed.data;
    if (q.valuation_id && !isUlid(q.valuation_id)) throw problems.badRequest('Invalid valuation_id');

    const { items, total } = await listJobs(deps.pool, {
      source: q.source,
      status: q.status,
      valuationId: q.valuation_id,
      page: q.page,
      perPage: q.per_page,
    });
    return { jobs: items, page: q.page, per_page: q.per_page, total };
  });

  app.get('/api/v1/admin/jobs/stats', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const parsed = z
      .object({
        since_hours: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .default(24),
      })
      .safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });

    const [stats, oldest] = await Promise.all([
      jobStats(deps.pool, parsed.data.since_hours),
      oldestActiveJobs(deps.pool),
    ]);
    return {
      since_hours: parsed.data.since_hours,
      totals: summarizeJobStats(stats),
      by_source: JOB_SOURCES.map((source) => ({
        source,
        label: JOB_SOURCE_LABELS[source],
        ...summarizeJobStats(stats.filter((s) => s.source === source)),
        oldest_active_at: oldest.find((o) => o.source === source)?.oldest_created_at ?? null,
      })),
    };
  });
}
