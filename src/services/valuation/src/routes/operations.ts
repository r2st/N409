import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems, TtlCache } from '@n409/shared';
import { canCreateValuation, canReadValuation, isOps, valuationScope } from '../auth/rbac.js';
import { stateGroupOf, STATE_GROUP_KEYS, type StateGroup } from '../domain/operations.js';
import {
  cloneValuation,
  countValuationsByGroup,
  dashboardStats,
  findValuationById,
} from '../repos/valuations.js';
import { ValuationFilterQuery, toRepoFilters } from './valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import { VALUATION_KINDS } from '../domain/valuation.js';

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

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
 * M3 operations surface: tab counts (feature 15), CSV export (16), dashboard
 * analytics (17), clone / roll-forward (18).
 */
export function registerOperationsRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const countsCache = new TtlCache<Record<StateGroup | 'all', number>>({ ttlMs: COUNTS_CACHE_TTL_MS });
  const dashboardCache = new TtlCache<Awaited<ReturnType<typeof dashboardStats>>>({
    ttlMs: DASHBOARD_CACHE_TTL_MS,
  });

  app.get('/api/v1/valuations/counts', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ValuationFilterQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const scope = valuationScope(principal);
    const filters = toRepoFilters(parsed.data);
    const key = JSON.stringify({ scope, filters });
    const counts = await countsCache.getOrLoad(key, () =>
      countValuationsByGroup(deps.pool, scope, filters),
    );
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

    return {
      total,
      // stable kind order (matches the product catalogue)
      by_kind: VALUATION_KINDS.filter((k) => byKind.has(k)).map((k) => ({ kind: k, ...byKind.get(k)! })),
      by_state: byState,
      by_source: bySource,
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

    const parsed = z
      .object({ roll_forward: z.boolean().default(false) })
      .safeParse(req.body ?? {});
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
}
