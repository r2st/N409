import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import {
  countSavedViews,
  createSavedView,
  deleteSavedView,
  findSavedView,
  findVisibleViewByQuery,
  listVisibleViews,
  SAVED_VIEW_PAGE_LIMIT,
  updateSavedView,
  VIEW_VISIBILITIES,
  type SavedViewWithOwner,
} from '../repos/savedViews.js';
import { findPartnerById } from '../repos/adminUsers.js';
import { requirePrincipal } from '../plugins/auth.js';
import { isUniqueViolation } from '../db/pgError.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { sliceChars } from '../domain/textSlice.js';

/**
 * `saved_views` carries two unique indexes (migration 0088), and a write can
 * trip either. Naming them is what keeps the 409 truthful: a bare SQLSTATE
 * check told a user who lost the race to set a default that they already had
 * a view with that name, which is the one thing they could not fix.
 */
const NAME_TAKEN_INDEX = 'saved_views_owner_name_idx';
const ONE_DEFAULT_INDEX = 'saved_views_one_default_idx';

/**
 * The conflict a saved-view write can produce, as a problem the caller can act
 * on. Rethrows anything that is not one of the two.
 *
 * The default collision is genuinely transient — `createSavedView` and
 * `updateSavedView` clear the previous default inside the same transaction, so
 * reaching the index means another request did the same thing concurrently and
 * one of them has to lose. Saying "try again" is accurate; saying "rename it"
 * was not.
 */
function savedViewConflict(err: unknown): never {
  if (isUniqueViolation(err, NAME_TAKEN_INDEX)) {
    throw problems.conflict('You already have a view with that name');
  }
  if (isUniqueViolation(err, ONE_DEFAULT_INDEX)) {
    throw problems.conflict('Another view was made your default at the same moment — try again');
  }
  throw err;
}

/**
 * Saved worklist views (feature-improvements §2 "Saved views").
 *
 * The valuations list already encodes its whole state in the URL, so a view is
 * a name plus that query string. Nothing here interprets the filters: the list
 * endpoint re-parses and re-scopes them on replay, so a stored query can only
 * ever return rows the *viewer* is allowed to see — which is what makes it
 * safe for one analyst to share a view with the team.
 *
 * What this route does police is the shape: only keys the list actually
 * understands are stored, so a saved view cannot become a vector for arbitrary
 * query parameters, and pagination is dropped so a shared view always opens on
 * page one.
 */

/**
 * Keys the valuations list accepts (routes/valuations.ts ValuationFilterQuery
 * plus the list's own sort/tab). `page`/`per_page` are deliberately absent:
 * a saved view is a filter, not a scroll position.
 */
const ALLOWED_KEYS = new Set([
  'q',
  'state',
  'group',
  'kind',
  'source',
  'paid_status',
  'reviewer_id',
  'partner_id',
  'user_id',
  'waiting_on_client',
  'unread',
  'created_from',
  'created_to',
  'due_from',
  'due_to',
  'sort',
]);

const MAX_QUERY_CHARS = 1000;
const MAX_VIEWS_PER_USER = 50;

/**
 * The longest a saved view's name may be.
 *
 * Named because there are three writers of it and one of them is not a schema:
 * the "save this partner's default view" route below takes the *partner's*
 * name, which its own door bounds at 200, and cuts it to fit this column.
 */
const MAX_VIEW_NAME = 80;

/**
 * Drops unknown keys, empty values and pagination, and normalises ordering so
 * two views built by different click paths compare equal. Exported for tests.
 */
export function normalizeViewQuery(raw: string): string {
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const kept: [string, string][] = [];
  for (const [key, value] of params) {
    if (!ALLOWED_KEYS.has(key)) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    kept.push([key, trimmed]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new URLSearchParams(kept);
  const text = out.toString();
  if (text.length > MAX_QUERY_CHARS) throw problems.unprocessable('Saved view query is too long');
  return text;
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(MAX_VIEW_NAME),
  query: z.string().max(4000).default(''),
  visibility: z.enum(VIEW_VISIBILITIES).default('private'),
  is_default: z.boolean().default(false),
});

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(MAX_VIEW_NAME).optional(),
    query: z.string().max(4000).optional(),
    visibility: z.enum(VIEW_VISIBILITIES).optional(),
    is_default: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

function toJson(row: SavedViewWithOwner, viewerId: string) {
  const ownerName = [row.owner_first_name, row.owner_last_name].filter(Boolean).join(' ') || row.owner_email;
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    visibility: row.visibility,
    is_default: row.is_default,
    // The client needs this to decide whether to offer rename/delete, and to
    // label a shared view with whose it is.
    is_owner: row.owner_id === viewerId,
    owner_name: ownerName,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerSavedViewRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/saved-views', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(SAVED_VIEW_PAGE_LIMIT).default(SAVED_VIEW_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error);
    }
    const { views, truncated } = await listVisibleViews(deps.pool, {
      userId: principal.id,
      // Shared views are an ops-team artefact; a client has no use for
      // "Unpaid > 7 days" and no business seeing that the queue exists.
      includeShared: isOps(principal),
      limit: parsedQuery.data.limit,
    });
    return {
      views: views.map((r) => toJson(r, principal.id)),
      truncated,
      page_limit: SAVED_VIEW_PAGE_LIMIT,
    };
  });

  app.post('/api/v1/saved-views', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid view', parsed.error);
    const body = parsed.data;

    if (body.visibility === 'shared' && !isOps(principal)) {
      throw problems.forbidden('Only the operations team can share a view');
    }
    if ((await countSavedViews(deps.pool, principal.id)) >= MAX_VIEWS_PER_USER) {
      throw problems.unprocessable(`You can save at most ${MAX_VIEWS_PER_USER} views`);
    }

    try {
      const row = await createSavedView(deps.pool, {
        ownerId: principal.id,
        name: body.name,
        query: normalizeViewQuery(body.query),
        visibility: body.visibility,
        isDefault: body.is_default,
      });
      reply.code(201);
      return { view: { ...row, is_owner: true } };
    } catch (err) {
      // The unique indexes are the check — re-querying first would still race.
      savedViewConflict(err);
    }
  });

  app.patch('/api/v1/saved-views/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();

    const existing = await findSavedView(deps.pool, id);
    // 404 rather than 403 for someone else's view — don't confirm the id.
    if (!existing || existing.owner_id !== principal.id) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid view', parsed.error);
    const body = parsed.data;
    if (body.visibility === 'shared' && !isOps(principal)) {
      throw problems.forbidden('Only the operations team can share a view');
    }

    try {
      const row = await updateSavedView(deps.pool, id, {
        name: body.name,
        query: body.query === undefined ? undefined : normalizeViewQuery(body.query),
        visibility: body.visibility,
        isDefault: body.is_default,
      });
      if (!row) throw problems.notFound();
      return { view: { ...row, is_owner: true } };
    } catch (err) {
      savedViewConflict(err);
    }
  });

  /**
   * Pin a firm's engagement listing as a saved view (design §4.4, P2-19).
   *
   * The gap was a *saved entry point*, not a second listing page: a partner
   * listing that has to be reconstructed by picking a firm out of a dropdown
   * every morning is not an entry point. Building a second page for it would
   * duplicate the filter, sort, export and scope logic the sweep test covers
   * on the first one — and a second listing is a second place for the scope
   * rules to be wrong.
   *
   * So it is one row in `saved_views`, holding the same `?partner_id=…` query
   * the listing already understands and re-scopes on replay. Shared, because a
   * firm's queue is a team artefact and one analyst pinning it should not mean
   * every other analyst pins their own copy.
   *
   * Idempotent by construction: pinning a firm that is already pinned returns
   * the existing view rather than a conflict. The button says "open the firm's
   * queue" to the operator, and a second click has to mean that too.
   */
  app.post('/api/v1/partners/:partnerId/saved-view', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Partner views are an operations artefact');

    const { partnerId } = req.params as { partnerId: string };
    if (!isUlid(partnerId)) throw problems.notFound();
    const partner = await findPartnerById(deps.pool, partnerId);
    if (!partner) throw problems.notFound();

    const query = normalizeViewQuery(`partner_id=${partner.id}`);
    // Matched on the query rather than on the name: a firm renamed after its
    // view was pinned must not get a second one, and the query is what the
    // view actually *is*.
    const existing = await findVisibleViewByQuery(deps.pool, {
      userId: principal.id,
      includeShared: true,
      query,
    });
    if (existing) return { view: toJson(existing, principal.id), created: false };

    if ((await countSavedViews(deps.pool, principal.id)) >= MAX_VIEWS_PER_USER) {
      throw problems.unprocessable(`You can save at most ${MAX_VIEWS_PER_USER} views`);
    }
    try {
      const row = await createSavedView(deps.pool, {
        ownerId: principal.id,
        name: sliceChars(partner.name, MAX_VIEW_NAME),
        query,
        visibility: 'shared',
        isDefault: false,
      });
      reply.code(201);
      return { view: { ...row, is_owner: true }, created: true };
    } catch (err) {
      savedViewConflict(err);
    }
  });

  app.delete('/api/v1/saved-views/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();

    const existing = await findSavedView(deps.pool, id);
    if (!existing || existing.owner_id !== principal.id) throw problems.notFound();
    await deleteSavedView(deps.pool, id);
    reply.code(204);
    return null;
  });
}
