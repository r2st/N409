import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation } from '../auth/rbac.js';
import { COMMENT_KINDS, type CommentKind } from '../domain/operations.js';
import { pageParam } from '../domain/pagination.js';
import { flagParam } from '../domain/queryFlag.js';
import { listInbox, markAllRead, markThreadRead, unreadThreadCount } from '../repos/inbox.js';
import { findValuationById } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * The shared inbox (409.ai §17) — every engagement thread in one list, with
 * per-reader unread state.
 *
 * Scoping is delegated entirely to `repos/inbox.ts`, which reproduces
 * `valuationScope` in SQL. Nothing here filters rows: an inbox that filtered
 * after paginating would hand a partner user four rows and call it a page.
 *
 * There is no POST. Replying happens on the engagement's own thread
 * (`POST /valuations/:id/comments`), which already owns the kind rules, the
 * mention parsing and the realtime broadcast — a second write path would be a
 * second place for those to drift.
 */
export function registerInboxRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const ListQuery = z.object({
    kind: z.enum(COMMENT_KINDS).optional(),
    unread: flagParam(false),
    q: z.string().max(200).optional(),
    page: pageParam(),
    per_page: z.coerce.number().int().min(1).max(100).default(25),
  });

  app.get('/api/v1/inbox', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const q = parsed.data;

    const page = await listInbox(deps.pool, principal, {
      kinds: q.kind ? new Set<CommentKind>([q.kind]) : undefined,
      unreadOnly: q.unread,
      search: q.q,
      page: q.page,
      perPage: q.per_page,
    });
    return { ...page, page: q.page, per_page: q.per_page };
  });

  /** The nav badge. Threads that have moved, not comments — see the repo. */
  app.get('/api/v1/inbox/unread-count', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { unread_threads: await unreadThreadCount(deps.pool, principal) };
  });

  /**
   * Mark one engagement's thread read. Gated on `canReadValuation` and not on
   * the inbox scope alone: a read mark is a row keyed to an engagement id, and
   * writing one for an engagement the caller cannot see would let them confirm
   * it exists.
   */
  app.post('/api/v1/inbox/read', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = z.object({ valuation_id: z.string() }).safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid body', { errors: parsed.error.issues });
    if (!isUlid(parsed.data.valuation_id)) throw problems.notFound();

    const valuation = await findValuationById(deps.pool, parsed.data.valuation_id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    )
      throw problems.notFound();

    const lastReadAt = await markThreadRead(deps.pool, principal.id, valuation.id);
    return { valuation_id: valuation.id, last_read_at: lastReadAt };
  });

  app.post('/api/v1/inbox/read-all', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { marked: await markAllRead(deps.pool, principal) };
  });
}
