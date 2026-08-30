import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems, TtlCache } from '@n409/shared';
import { canReadValuation } from '../auth/rbac.js';
import { COMMENT_KINDS, type CommentKind } from '../domain/operations.js';
import { pageParam } from '../domain/pagination.js';
import { flagParam } from '../domain/queryFlag.js';
import {
  listInbox,
  markAllRead,
  markThreadRead,
  unreadThreadCount,
  unreadThreadCountKey,
} from '../repos/inbox.js';
import { findValuationById } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

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
 * realtime broadcast and the notification fan-out — a second write path would
 * be a second place for those to drift. (It does not own mention parsing:
 * nothing in this service parses `@name`, and `comment_mentions` from
 * migration 0089 has never had a writer.)
 */

/**
 * How long the nav badge's count may be stale.
 *
 * The same 15s the listing tab strip's counts use (`COUNTS_CACHE_TTL_MS`,
 * routes/operations.ts), and for the same reason: AppLayout polls
 * `/inbox/unread-count`, `/notifications/unread-count` and `/valuations/counts`
 * on one 60s timer, and all three `useEffect`s carry `location.pathname` in
 * their dependency list — so every client-side navigation tears the timer down
 * and fires all three again immediately. The timer is not what this absorbs;
 * the navigation storm and the operator's six open tabs are.
 *
 * Of those three polls this was the only unprotected one, and the most
 * expensive by some way. `/notifications/unread-count` is a lookup on the
 * partial index `notifications (user_id) WHERE read_at IS NULL`, and
 * `/valuations/counts` has had a TTL cache since the tab strip was built. This
 * one joins `valuation_comments` to `valuations` and takes a
 * `count(DISTINCT …)` over the reader's whole scope — for an ops principal the
 * scope clause is `v.archived_at IS NULL` and nothing else, so the work is a
 * pass over every comment the platform has ever stored, to produce one integer
 * for a badge.
 *
 * A cache and not a rewrite: the obvious rewrite counts `valuations` rows on
 * `v.last_comment_at > r.last_read_at` and never touches the comments table,
 * but `last_comment_at` is stamped by *any* comment while this query counts
 * only `c.kind = ANY(visible kinds)`. That rewrite would show a client user a
 * badge for an internal note they cannot open. The kind filter is load-bearing,
 * so the join stays and the repetition goes.
 */
const UNREAD_COUNT_CACHE_TTL_MS = 15_000;

export function registerInboxRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  /**
   * Per-reader, and keyed by everything the query varies on — see
   * {@link unreadThreadCountKey}, which is built beside the SQL rather than
   * here so the two cannot drift apart.
   */
  const unreadCountCache = new TtlCache<number>({ ttlMs: UNREAD_COUNT_CACHE_TTL_MS });

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
    if (!parsed.success) throw invalidQuery(parsed.error);
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
    const unread = await unreadCountCache.getOrLoad(unreadThreadCountKey(principal), () =>
      unreadThreadCount(deps.pool, principal),
    );
    return { unread_threads: unread };
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
    if (!parsed.success) throw invalidBody('Invalid body', parsed.error);
    if (!isUlid(parsed.data.valuation_id)) throw problems.notFound();

    const valuation = await findValuationById(deps.pool, parsed.data.valuation_id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    )
      throw problems.notFound();

    const lastReadAt = await markThreadRead(deps.pool, principal.id, valuation.id);
    // The reader just changed their own badge and is watching it. A TTL is the
    // right staleness budget for somebody *else's* comment arriving; it is the
    // wrong one for the click that is supposed to clear the number, which would
    // otherwise sit there for up to fifteen seconds and read as a failed write.
    unreadCountCache.delete(unreadThreadCountKey(principal));
    return { valuation_id: valuation.id, last_read_at: lastReadAt };
  });

  app.post('/api/v1/inbox/read-all', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const marked = await markAllRead(deps.pool, principal);
    // Same reasoning as `/inbox/read`, and more visibly so: "clear inbox" that
    // leaves a non-zero badge behind is the one result this button must not
    // produce.
    unreadCountCache.delete(unreadThreadCountKey(principal));
    return { marked };
  });
}
