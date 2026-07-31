import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps } from '../auth/rbac.js';
import {
  EVENT_CATEGORIES,
  EVENT_SEVERITIES,
  describeEvent,
  fieldHistory,
  filterAuditEntries,
  summarizeAuditTrail,
} from '../domain/auditTrail.js';
import { listEvents } from '../events/record.js';
import { findValuationById } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Per-valuation audit trail: the raw event spine enriched with category,
 * severity and field-level changes, so an auditor can answer "who changed the
 * DLOM, when, and from what?" without reading JSON payloads.
 *
 * Visibility follows the same rule as the rest of the platform — ops see
 * everything, clients and partners see only the client-visible slice of the
 * catalog, so analyst tooling (workbook edits, overwrites, draft revisions)
 * never leaks outside ops.
 */

const ListQuery = z.object({
  category: z.enum(EVENT_CATEGORIES).optional(),
  severity: z.enum(EVENT_SEVERITIES).optional(),
  actor_type: z.enum(['human', 'ai', 'engine', 'system']).optional(),
  type: z.string().max(100).optional(),
  field: z.string().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

const HistoryQuery = z.object({ field: z.string().min(1).max(120) });

export function registerAuditTrailRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  /** Load the valuation, enforce read access, and enrich its whole event spine. */
  async function loadTrail(req: FastifyRequest) {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    const ref = { userId: valuation.user_id, partnerId: valuation.partner_id };
    if (!canReadValuation(principal, ref)) throw problems.notFound();

    const events = await listEvents(deps.pool, valuation.id);
    return { entries: events.map(describeEvent), includeInternal: isOps(principal) };
  }

  app.get('/api/v1/valuations/:id/audit-trail', { preHandler: app.authenticate }, async (req) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const q = parsed.data;

    const { entries, includeInternal } = await loadTrail(req);
    const matched = filterAuditEntries(entries, {
      category: q.category,
      severity: q.severity,
      actorType: q.actor_type,
      type: q.type,
      field: q.field,
      from: q.from,
      to: q.to,
      includeInternal,
    });

    const start = (q.page - 1) * q.per_page;
    return {
      entries: matched.slice(start, start + q.per_page),
      summary: summarizeAuditTrail(matched),
      page: q.page,
      per_page: q.per_page,
      total: matched.length,
      includes_internal: includeInternal,
    };
  });

  /** Every recorded change to a single field, newest first. */
  app.get(
    '/api/v1/valuations/:id/audit-trail/field-history',
    { preHandler: app.authenticate },
    async (req) => {
      const parsed = HistoryQuery.safeParse(req.query);
      if (!parsed.success)
        throw problems.badRequest('A field name is required', { errors: parsed.error.issues });

      const { entries, includeInternal } = await loadTrail(req);
      const visible = filterAuditEntries(entries, { includeInternal });
      return { field: parsed.data.field, history: fieldHistory(visible, parsed.data.field) };
    },
  );
}
