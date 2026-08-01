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
  listVisibleViews,
  updateSavedView,
  VIEW_VISIBILITIES,
  type SavedViewWithOwner,
} from '../repos/savedViews.js';
import { requirePrincipal } from '../plugins/auth.js';

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
  name: z.string().trim().min(1).max(80),
  query: z.string().max(4000).default(''),
  visibility: z.enum(VIEW_VISIBILITIES).default('private'),
  is_default: z.boolean().default(false),
});

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    query: z.string().max(4000).optional(),
    visibility: z.enum(VIEW_VISIBILITIES).optional(),
    is_default: z.boolean().optional(),
  })
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
    const rows = await listVisibleViews(deps.pool, {
      userId: principal.id,
      // Shared views are an ops-team artefact; a client has no use for
      // "Unpaid > 7 days" and no business seeing that the queue exists.
      includeShared: isOps(principal),
    });
    return { views: rows.map((r) => toJson(r, principal.id)) };
  });

  app.post('/api/v1/saved-views', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid view', { errors: parsed.error.issues });
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
      // The (owner, lower(name)) unique index is the check — re-querying first
      // would still race.
      if (isUniqueViolation(err)) throw problems.conflict('You already have a view with that name');
      throw err;
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
    if (!parsed.success) throw problems.unprocessable('Invalid view', { errors: parsed.error.issues });
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
      if (isUniqueViolation(err)) throw problems.conflict('You already have a view with that name');
      throw err;
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

/** Postgres unique-violation SQLSTATE. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
