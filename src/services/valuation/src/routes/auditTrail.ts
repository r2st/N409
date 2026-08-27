import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps } from '../auth/rbac.js';
import {
  EVENT_CATEGORIES,
  EVENT_SEVERITIES,
  changeLogCsv,
  describeEvent,
  fieldHistory,
  filterAuditEntries,
  summarizeAuditTrail,
} from '../domain/auditTrail.js';
import { listEvents, type EventQuery } from '../events/record.js';
import { findValuationById } from '../repos/valuations.js';
import { contentDisposition } from './documents.js';
import { requirePrincipal } from '../plugins/auth.js';
import { pageParam } from '../domain/pagination.js';
import { checkWindowOrder, dateWindowFields } from '../domain/dateWindow.js';
import { sendExport } from './exports.js';
import { invalidQuery } from '../domain/validationProblem.js';

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

const ListQuery = z
  .object({
    category: z.enum(EVENT_CATEGORIES).optional(),
    severity: z.enum(EVENT_SEVERITIES).optional(),
    actor_type: z.enum(['human', 'ai', 'engine', 'system']).optional(),
    type: z.string().max(100).optional(),
    field: z.string().max(120).optional(),
    ...dateWindowFields,
    page: pageParam(),
    per_page: z.coerce.number().int().min(1).max(200).default(50),
  })
  .superRefine(checkWindowOrder);

const HistoryQuery = z.object({ field: z.string().min(1).max(120) });

/**
 * Hard ceiling on how much of the spine one request enriches. A valuation that
 * has been rolled forward for years accumulates a lot of events, and enriching
 * all of them allocates a payload-sized object per row. We keep the newest
 * MAX_TRAIL_EVENTS and say so in the response rather than silently truncating.
 */
export const MAX_TRAIL_EVENTS = 5_000;

export function registerAuditTrailRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  /**
   * Load the valuation, enforce read access, and enrich the slice of its event
   * spine the query asks for. The predicates that map to columns (type, actor
   * type, date window) are pushed into SQL; category, severity and changed
   * field are catalog-derived and can only be applied after enrichment.
   */
  async function loadTrail(req: FastifyRequest, query: EventQuery = {}) {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    const ref = { userId: valuation.user_id, partnerId: valuation.partner_id };
    if (!canReadValuation(principal, ref)) throw problems.notFound();

    const events = await listEvents(deps.pool, valuation.id, {
      ...query,
      limit: query.limit ?? MAX_TRAIL_EVENTS + 1,
    });
    const truncated = events.length > MAX_TRAIL_EVENTS;
    return {
      valuation,
      entries: events.slice(-MAX_TRAIL_EVENTS).map(describeEvent),
      includeInternal: isOps(principal),
      truncated,
    };
  }

  app.get('/api/v1/valuations/:id/audit-trail', { preHandler: app.authenticate }, async (req) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const q = parsed.data;

    const { entries, includeInternal, truncated } = await loadTrail(req, {
      types: q.type ? [q.type] : undefined,
      actorType: q.actor_type,
      from: q.from,
      to: q.to,
    });
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
      /** True when older events exist beyond MAX_TRAIL_EVENTS and were not read. */
      truncated,
    };
  });

  /**
   * The same trail as a flat CSV — one row per changed field, openable in
   * Excel. Same visibility rule as the JSON view.
   *
   * The filename was the valuation's id: `change-log-01JQ8ZK7...csv`, twenty-six
   * characters of Crockford base32 that name nothing a human recognises. An
   * auditor pulls the change log for several companies in one sitting and the
   * downloads folder ends up holding files distinguishable only by timestamp.
   * The company name is what the row is filed under everywhere else in the app,
   * so it is what the file is called; `contentDisposition` scrubs it and writes
   * the UTF-8 half, so a name outside ASCII survives the trip.
   */
  app.get('/api/v1/valuations/:id/audit-trail.csv', { preHandler: app.authenticate }, async (req, reply) => {
    const { valuation, entries, includeInternal, truncated } = await loadTrail(req);
    const visible = filterAuditEntries(entries, { includeInternal });
    /*
     * The same cap bit the JSON view above returns, on the format an auditor
     * actually opens.
     *
     * `loadTrail` has computed it all along and this route destructured around
     * it. MAX_TRAIL_EVENTS is where the spine stops being read, so a valuation
     * with a longer history exported a change log missing its *oldest* entries
     * — `entries` keeps the newest 5,000 — and the file said nothing. The whole
     * point of a change log is answering "when did this first move", which is a
     * question the dropped end holds.
     */
    return sendExport(reply, truncated)
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', contentDisposition(`change-log-${valuation.company_name}.csv`))
      .send(changeLogCsv(visible));
  });

  /** Every recorded change to a single field, newest first. */
  app.get(
    '/api/v1/valuations/:id/audit-trail/field-history',
    { preHandler: app.authenticate },
    async (req) => {
      const parsed = HistoryQuery.safeParse(req.query);
      if (!parsed.success) throw invalidQuery(parsed.error, 'A field name is required');

      const { entries, includeInternal } = await loadTrail(req);
      const visible = filterAuditEntries(entries, { includeInternal });
      return { field: parsed.data.field, history: fieldHistory(visible, parsed.data.field) };
    },
  );
}
