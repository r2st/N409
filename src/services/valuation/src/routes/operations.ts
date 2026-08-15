import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems, TtlCache } from '@n409/shared';
import { canCreateValuation, canReadValuation, isOps, valuationScope } from '../auth/rbac.js';
import { stateGroupOf, STATE_GROUP_KEYS, type StateGroup } from '../domain/operations.js';
import {
  cloneValuation,
  countValuationsByGroup,
  countValuationsByNamedBucket,
  dashboardActivity,
  dashboardStats,
  findValuationById,
  namedBucketBreakdown,
  publishThroughput,
  slaBreaches,
} from '../repos/valuations.js';
import { NAMED_BUCKETS, type NamedBucketKey } from '../domain/workflow.js';
import type { QueryStats } from '../db/queryStats.js';
import type { PoolHealth } from '../db/poolHealth.js';
import { circuits } from '../clients/internal.js';
import { ValuationFilterQuery, toRepoFilters } from './valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import { VALUATION_KINDS } from '../domain/valuation.js';
import { deliveryBacklogStats } from '../repos/partnerWebhooks.js';
import { retryDueDeliveries } from '../hooks/partnerWebhooks.js';

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

// Both endpoints below are hit on every worklist/dashboard page load — often
// several times a minute per ops user — and re-scan/aggregate the whole
// valuations table for their scope on every call. Neither result needs to be
// exact to the second (a state flip lagging behind by a few seconds on a tab
// counter is harmless), so a short TTL cache trades that staleness for
// cutting the aggregate query rate roughly 1:1 with page views instead of
// 1:1 with requests. No manual invalidation: writes happen from dozens of
// route files (workflow transitions, bulk actions, clone, …) and re-deriving
// "which caches does this write affect" everywhere isn't worth it when the
// TTL alone already bounds staleness. See @n409/shared's TtlCache for the
// same trade-off already made for help articles.
const COUNTS_CACHE_TTL_MS = 15_000;
const DASHBOARD_CACHE_TTL_MS = 20_000;

/**
 * Which read marker a caller's unread count compares against. Ops read the
 * admin side of every conversation; everyone else reads their own.
 */
function readerSideFor(principal: Parameters<typeof valuationScope>[0]): 'admin' | 'user' {
  return isOps(principal) ? 'admin' : 'user';
}

/** How many trailing weeks the throughput sparkline covers (design §3.1). */
const THROUGHPUT_WEEKS = 12;

/** How many activity rows the feed carries (design §3.1). */
const ACTIVITY_LIMIT = 20;

/**
 * The three added dashboard bands, in one round of queries.
 *
 * Split out of the route so the cache has something to call and so the shape is
 * named once: the frontend and the sidebar both read `buckets`, and there is
 * exactly one place that decides what a bucket tally is.
 */
async function loadBands(pool: pg.Pool, scope: ReturnType<typeof valuationScope>, side: 'admin' | 'user') {
  const [buckets, activity, throughput, sla] = await Promise.all([
    namedBucketBreakdown(pool, scope, {}, side),
    dashboardActivity(pool, scope, ACTIVITY_LIMIT),
    publishThroughput(pool, scope, THROUGHPUT_WEEKS),
    slaBreaches(pool, scope),
  ]);
  return { buckets, activity, throughput, sla };
}

/**
 * M3 operations surface: tab counts (feature 15), CSV export (16), dashboard
 * analytics (17), clone / roll-forward (18).
 */
export function registerOperationsRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; queryStats?: QueryStats; poolHealth?: PoolHealth },
): void {
  const countsCache = new TtlCache<Record<StateGroup | 'all', number>>({ ttlMs: COUNTS_CACHE_TTL_MS });
  const namedCountsCache = new TtlCache<Record<NamedBucketKey, number>>({ ttlMs: COUNTS_CACHE_TTL_MS });
  const dashboardCache = new TtlCache<Awaited<ReturnType<typeof dashboardStats>>>({
    ttlMs: DASHBOARD_CACHE_TTL_MS,
  });
  const bandsCache = new TtlCache<Awaited<ReturnType<typeof loadBands>>>({
    ttlMs: DASHBOARD_CACHE_TTL_MS,
  });

  app.get('/api/v1/valuations/counts', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ValuationFilterQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const mode = z.object({ buckets: z.enum(['groups', 'named']).default('groups') }).safeParse(req.query);
    if (!mode.success) throw problems.badRequest('Invalid buckets mode');

    const scope = valuationScope(principal);
    const filters = toRepoFilters(parsed.data);

    if (mode.data.buckets === 'named') {
      // Unread is per-reader, so the cache key has to carry which side is
      // asking — otherwise two operators share one badge and it goes stale for
      // both at once, which is the bug migration 0113 was written to fix.
      const side = readerSideFor(principal);
      const key = JSON.stringify({ scope, filters, named: true, side });
      const named = await namedCountsCache.getOrLoad(key, () =>
        countValuationsByNamedBucket(deps.pool, scope, filters, side),
      );
      return { counts: named, buckets: NAMED_BUCKETS };
    }

    const key = JSON.stringify({ scope, filters });
    const counts = await countsCache.getOrLoad(key, () => countValuationsByGroup(deps.pool, scope, filters));
    return { counts };
  });

  // NOTE: GET /api/v1/valuations/export lives in routes/exports.ts (merged
  // with M4's CSV/PDF exporter); it uses exportValuations from the repo.

  /**
   * Dashboard analytics: per-kind pivot over state groups + pie breakdowns,
   * within an optional created_at date range, always inside the caller's scope.
   */
  app.get('/api/v1/stats/dashboard', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = z
      .object({ created_from: DateOnly.optional(), created_to: DateOnly.optional() })
      .safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });

    const scope = valuationScope(principal);
    const dashboardFilters = { createdFrom: parsed.data.created_from, createdTo: parsed.data.created_to };
    const key = JSON.stringify({ scope, dashboardFilters });
    const rows = await dashboardCache.getOrLoad(key, () =>
      dashboardStats(deps.pool, scope, dashboardFilters),
    );

    const emptyGroups = () =>
      Object.fromEntries(STATE_GROUP_KEYS.map((g) => [g, 0])) as Record<StateGroup, number>;
    const byKind = new Map<string, Record<StateGroup, number> & { total: number }>();
    const bySource: Record<string, number> = {};
    const byState: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      let kindRow = byKind.get(row.kind);
      if (!kindRow) {
        kindRow = { ...emptyGroups(), total: 0 };
        byKind.set(row.kind, kindRow);
      }
      kindRow[stateGroupOf(row.state)] += row.count;
      kindRow.total += row.count;
      byState[row.state] = (byState[row.state] ?? 0) + row.count;
      const source = row.source ?? 'direct';
      bySource[source] = (bySource[source] ?? 0) + row.count;
      total += row.count;
    }

    // Design §3.1 — the three bands the landing dashboard was missing: the
    // bucket strip, the SLA figures, the throughput series, and the activity
    // feed behind them. Cached on the same key as the pivot: they are read
    // together on one page load, and a reader comparing a bucket count against
    // the pivot beneath it should not see two different instants.
    const bands = await bandsCache.getOrLoad(JSON.stringify({ scope, side: readerSideFor(principal) }), () =>
      loadBands(deps.pool, scope, readerSideFor(principal)),
    );

    return {
      total,
      // stable kind order (matches the product catalogue)
      by_kind: VALUATION_KINDS.filter((k) => byKind.has(k)).map((k) => ({ kind: k, ...byKind.get(k)! })),
      by_state: byState,
      by_source: bySource,
      ...bands,
    };
  });

  app.post('/api/v1/valuations/:id/clone', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const source = await findValuationById(deps.pool, id);
    if (!source || !canReadValuation(principal, { userId: source.user_id, partnerId: source.partner_id }))
      throw problems.notFound();
    if (!canCreateValuation(principal)) throw problems.forbidden();

    const parsed = z.object({ roll_forward: z.boolean().default(false) }).safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid clone request');

    // Ops clone on behalf of the original owner; a client clones as themselves.
    const userId = isOps(principal) ? source.user_id : principal.id;
    const valuation = await cloneValuation(
      deps.pool,
      source,
      { rollForward: parsed.data.roll_forward, userId },
      { actorType: 'human', actorId: principal.id, source: 'api' },
    );
    return reply.status(201).send({ valuation });
  });

  /**
   * Partner webhook delivery backlog (migration 0103). Ops need one number to
   * answer "is anything not getting through?" without reading fourteen
   * partners' delivery logs; `failed` is the one that matters, because a failed
   * row is terminal and nothing else will ever come back for it.
   */
  app.get('/api/v1/admin/webhooks/deliveries/stats', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    return deliveryBacklogStats(deps.pool);
  });

  /** On-demand sweep — the same code path the interval runs (index.ts). */
  app.post('/api/v1/admin/webhooks/retry', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    return retryDueDeliveries({ pool: deps.pool, log: req.log });
  });

  /**
   * The slowest statements this process has run, worst-first by total time
   * (db/queryStats.ts).
   *
   * Process-local and reset on deploy, which is the right scope for the
   * question it answers — "what is slow in the build that is running now" —
   * and avoids a metrics backend being a prerequisite for the answer. The
   * per-statement `warn` lines cover the same ground for a single request; this
   * is the view that ranks them.
   *
   * Ops-only: a fingerprint names tables and columns, which is more of the
   * schema than a client has any reason to see.
   */
  app.get('/api/v1/admin/db/slow-queries', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    const stats = deps.queryStats;
    // Instrumentation is wired in index.ts, so a test app or a future entry
    // point can legitimately have none. Report that rather than 500.
    if (!stats) return { instrumented: false, tracked: 0, queries: [] };
    const { limit } = req.query as { limit?: string };
    const parsed = Number(limit);
    const top = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 20;
    return { instrumented: true, tracked: stats.size, queries: stats.top(top) };
  });

  /**
   * Connection-pool health, and the state of every upstream circuit breaker.
   *
   * One endpoint for both because they are read together: an operator looking
   * at a slow service wants to know whether the pool is saturated *and*
   * whether we have stopped calling something, and the second explains the
   * first surprisingly often — a breaker that has just opened releases every
   * connection those calls were holding.
   *
   * `peek()` rather than `sample()`: this must not consume the once-only leak
   * and exhaustion reports that the interval in index.ts exists to log. A
   * curious operator refreshing this page should not be able to silence an
   * alert.
   *
   * Ops-only, like the slow-query view: an acquisition stack names files and
   * line numbers, which is more of the codebase than a client should see.
   */
  app.get('/api/v1/admin/db/pool', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    const health = deps.poolHealth;
    return {
      monitored: Boolean(health),
      pool: health ? health.peek() : null,
      circuits: circuits.snapshots(),
    };
  });
}
