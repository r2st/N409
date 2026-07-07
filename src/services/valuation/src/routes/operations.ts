import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canCreateValuation, canReadValuation, isOps, valuationScope } from '../auth/rbac.js';
import { stateGroupOf, STATE_GROUP_KEYS, type StateGroup } from '../domain/operations.js';
import { toCsv } from '../domain/csv.js';
import {
  cloneValuation,
  countValuationsByGroup,
  dashboardStats,
  exportValuations,
  findValuationById,
} from '../repos/valuations.js';
import { ValuationFilterQuery, toRepoFilters } from './valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import { VALUATION_KINDS } from '../domain/valuation.js';

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * M3 operations surface: tab counts (feature 15), CSV export (16), dashboard
 * analytics (17), clone / roll-forward (18).
 */
export function registerOperationsRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/counts', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ValuationFilterQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const counts = await countValuationsByGroup(
      deps.pool,
      valuationScope(principal),
      toRepoFilters(parsed.data),
    );
    return { counts };
  });

  app.get('/api/v1/valuations/export', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = ValuationFilterQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });

    const rows = await exportValuations(
      deps.pool,
      valuationScope(principal),
      toRepoFilters(parsed.data),
    );
    const columns = [
      'id',
      'number',
      'workflow_id',
      'kind',
      'state',
      'company_name',
      'service_name',
      'owner_email',
      'partner_name',
      'source',
      'currency',
      'paid_status',
      'waiting_on_client',
      'reviewer_email',
      'created_at',
      'due_date',
      'published_at',
    ];
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="valuations.csv"')
      .send(toCsv(columns, rows));
  });

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

    const rows = await dashboardStats(deps.pool, valuationScope(principal), {
      createdFrom: parsed.data.created_from,
      createdTo: parsed.data.created_to,
    });

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
