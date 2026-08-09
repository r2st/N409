import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { pageParam } from '../domain/pagination.js';
import { findValuationById } from '../repos/valuations.js';
import { findNetworkItem, listNetworkItems } from '../repos/networkItems.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * The network log for one engagement (409.ai §11, "Network Items").
 *
 * Every call this service made to the engine and AI tiers on behalf of this
 * valuation: what was sent, what came back, the status and how long it took —
 * including the calls that failed, which is the half no result table holds. A
 * calculation row exists only when the engine answered; a research row only
 * when synthesis succeeded. The timeout, the retry and the 422 are here and
 * nowhere else.
 *
 * Operations-only, like the calculations routes and for a stronger reason: the
 * payloads are the raw inputs and outputs of the valuation machinery, and a
 * client who can read their own engagement has no business reading the engine's
 * working state.
 */
export function registerNetworkItemRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (principal: Principal, id: string): Promise<void> => {
    if (!isOps(principal)) throw problems.forbidden('The network log is operations-only');
    if (!isUlid(id)) throw problems.notFound();
    // Existence is checked against the whole table rather than the reader's
    // scope: `isOps` above is already the access rule, and a second scope test
    // here would only make an ops user's 404 depend on who they are.
    if (!(await findValuationById(deps.pool, id))) throw problems.notFound();
  };

  const ListQuery = z.object({
    /**
     * The tier: 'engine' or 'ai'. Not an enum — `service` is deliberately open
     * in the schema so a new internal service is logged the day it is added,
     * and a filter that rejected its name would hide those rows behind a 422.
     */
    service: z.string().max(40).optional(),
    page: pageParam(),
    per_page: z.coerce.number().int().min(1).max(200).default(50),
  });

  app.get('/api/v1/valuations/:id/network-items', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadValuation(principal, id);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { service, page, per_page: perPage } = parsed.data;

    // The page carries its own per-tier counts: the tab strip has to show what
    // the tabs the reader is *not* on contain, and `total` is derived from the
    // same counts so it stays right on a page past the end.
    return listNetworkItems(deps.pool, id, { service, page, perPage });
  });

  /**
   * One call, with both payloads.
   *
   * Separate from the list because the payloads are the weight of the table: an
   * engine compute request is the entire cap table and every projection period.
   * The list renders timestamps and status codes; a row is opened to read what
   * it carried.
   */
  app.get('/api/v1/valuations/:id/network-items/:itemId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, itemId } = req.params as { id: string; itemId: string };
    await loadValuation(principal, id);
    if (!isUlid(itemId)) throw problems.notFound();
    const item = await findNetworkItem(deps.pool, id, itemId);
    if (!item) throw problems.notFound();
    return { item };
  });
}
