import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import {
  JOB_SOURCES,
  JOB_SOURCE_LABELS,
  JOB_STATUSES,
  summarizeJobStats,
  type JobSource,
} from '../domain/jobQueue.js';
import { pageParam } from '../domain/pagination.js';
import { jobStats, listJobs, oldestActiveJobs } from '../repos/jobs.js';
import { listJobAlertRules, listJobAlerts, updateJobAlertRule } from '../repos/jobAlerts.js';
import { runJobAlertScan } from '../hooks/jobAlerts.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { flagParam } from '../domain/queryFlag.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

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
    if (!parsed.success) throw invalidQuery(parsed.error);
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
    if (!parsed.success) throw invalidQuery(parsed.error);

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
        // "How long the oldest outstanding item has been waiting" on the admin
        // page — anchored at when it became claimable, so a queue backing off
        // on purpose does not read as a queue that is behind.
        oldest_active_at: oldest.find((o) => o.source === source)?.oldest_due_at ?? null,
      })),
    };
  });

  // ── Alerting (design §17.1 item 13) ────────────────────────────────────────
  //
  // The monitor reported and nothing alerted. These three endpoints are the
  // ledger, the thresholds, and a manual scan for an operator who has just
  // fixed something and does not want to wait out the interval.

  app.get('/api/v1/admin/jobs/alerts', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const parsed = z
      .object({
        open: flagParam(false),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);

    const [alerts, rules] = await Promise.all([
      listJobAlerts(deps.pool, { openOnly: parsed.data.open, limit: parsed.data.limit }),
      listJobAlertRules(deps.pool),
    ]);
    return {
      alerts,
      rules,
      open: alerts.filter((a) => a.resolved_at === null).length,
    };
  });

  const RulePatch = z
    .object({
      enabled: z.boolean().optional(),
      // Bounded so a typo cannot disable alerting by setting a threshold nothing
      // can ever cross — a rule that never fires reads exactly like a healthy
      // queue, which is the failure mode this whole feature exists to remove.
      stall_minutes: z
        .number()
        .int()
        .min(1)
        .max(60 * 24 * 7)
        .optional(),
      failure_count: z.number().int().min(1).max(10_000).optional(),
      failure_window_hours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

  app.patch('/api/v1/admin/jobs/alert-rules/:source', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const { source } = req.params as { source: string };
    if (!(JOB_SOURCES as readonly string[]).includes(source)) throw problems.notFound();

    const parsed = RulePatch.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid rule', parsed.error);

    const rule = await updateJobAlertRule(deps.pool, source as JobSource, {
      enabled: parsed.data.enabled,
      stallMinutes: parsed.data.stall_minutes,
      failureCount: parsed.data.failure_count,
      failureWindowHours: parsed.data.failure_window_hours,
      updatedBy: principal.id,
    });
    if (!rule) throw problems.notFound();

    await recordAdminEvent(deps.pool, {
      type: 'job_alert_rule_changed',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'job_queue',
      subjectLabel: JOB_SOURCE_LABELS[source as JobSource],
      payload: { source, ...parsed.data },
    });
    return { rule };
  });

  /**
   * Run the sweep now.
   *
   * Same function the interval runs, so an operator who has just restarted a
   * worker sees the alert close rather than waiting out the tick.
   *
   * Safe to press twice, and `skipped` is what makes that honest: the second
   * press finds `SWEEP_LOCKS.jobAlertScan` held and declines the whole pass
   * rather than reconciling a second, differently-aged picture of the queues
   * over the first. See `runJobAlertScan` for what the two used to do to each
   * other. An answer with `skipped: true` reports nothing opened or resolved
   * because this call did nothing — not because nothing is wrong.
   */
  app.post('/api/v1/admin/jobs/alerts/scan', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const result = await runJobAlertScan({ pool: deps.pool, log: req.log });
    return {
      // "A scan was already running, so this press did nothing" — the one thing
      // an empty result cannot say for itself.
      skipped: result.skipped,
      opened: result.opened,
      resolved: result.resolved,
      ongoing: result.ongoing.length,
      evaluated: result.evaluated,
      // What actually reached an operator, which is not the same as what was
      // opened: an announcement owed by an earlier failed scan is delivered
      // here and counted here, and one that failed again is in `failed` rather
      // than silently missing. See migration 0157.
      notified: result.notified,
    };
  });
}
