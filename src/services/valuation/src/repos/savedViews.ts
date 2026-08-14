import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';

/**
 * Saved worklist views (feature-improvements §2). A view is a name plus the
 * valuations list's own query string; see migrations/0088 for why it is stored
 * verbatim rather than normalised into filter columns.
 */

export const VIEW_VISIBILITIES = ['private', 'shared'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];

export interface SavedViewRow {
  id: string;
  owner_id: string;
  name: string;
  query: string;
  visibility: ViewVisibility;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A view plus the owner's name, which is what a shared view needs to be trusted. */
export interface SavedViewWithOwner extends SavedViewRow {
  owner_email: string;
  owner_first_name: string | null;
  owner_last_name: string | null;
}

/**
 * The visibility predicate, shared by the two readers below.
 *
 * The outer parentheses are load-bearing. `AND` binds tighter than `OR`, so a
 * caller appending `AND v.query = $3` to an unparenthesized
 * `owner_id = $1 OR (shared)` gets the filter applied to the shared branch
 * only, and every view the principal owns matches whatever the filter said.
 * That is not a slow query, it is the wrong row: it made the partner pin hand
 * back the first firm the operator had ever pinned, for every firm after it.
 */
const VISIBLE_VIEWS_SQL = `
  SELECT v.*, u.email AS owner_email, u.first_name AS owner_first_name, u.last_name AS owner_last_name
    FROM saved_views v
    JOIN users u ON u.id = v.owner_id
   WHERE (v.owner_id = $1
      OR ($2::boolean AND v.visibility = 'shared'))`;

export const SAVED_VIEW_PAGE_LIMIT = 200;

/**
 * Everything the principal may see: their own views always, plus every shared
 * view when they are ops. Own views sort first so a picker can show them
 * without a second query.
 *
 * `MAX_VIEWS_PER_USER` caps what one person can save, which is why this looked
 * bounded and was not: the shared half is every ops user's views at once, and
 * that grows with the size of the team times the cap each of them has. Own
 * views sorting first is what makes the cap safe to apply — a long shared list
 * can never push somebody's own view off the end of their own picker.
 */
export async function listVisibleViews(
  pool: pg.Pool,
  args: { userId: string; includeShared: boolean; limit?: number },
): Promise<{ views: SavedViewWithOwner[]; truncated: boolean }> {
  const limit = Math.min(Math.max(args.limit ?? SAVED_VIEW_PAGE_LIMIT, 1), SAVED_VIEW_PAGE_LIMIT);
  const { rows } = await pool.query<SavedViewWithOwner>(
    `${VISIBLE_VIEWS_SQL}
      ORDER BY (v.owner_id = $1) DESC, lower(v.name)
      LIMIT $3`,
    [args.userId, args.includeShared, limit + 1],
  );
  return { views: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * The one visible view whose stored query is exactly `query`, if there is one.
 *
 * Asked of the database rather than found in {@link listVisibleViews}'s result,
 * because the caller — pinning a firm's queue — is an idempotency check, and an
 * idempotency check that reads a *page* stops being one as soon as the page is
 * full: the existing pin sorts past the cut, the second click does not find it,
 * and the firm quietly gets a duplicate view. Ordered so the principal's own
 * pin wins over a colleague's when both exist.
 */
export async function findVisibleViewByQuery(
  pool: pg.Pool,
  args: { userId: string; includeShared: boolean; query: string },
): Promise<SavedViewWithOwner | null> {
  const { rows } = await pool.query<SavedViewWithOwner>(
    `${VISIBLE_VIEWS_SQL}
       AND v.query = $3
      ORDER BY (v.owner_id = $1) DESC, lower(v.name)
      LIMIT 1`,
    [args.userId, args.includeShared, args.query],
  );
  return rows[0] ?? null;
}

export async function findSavedView(pool: pg.Pool, id: string): Promise<SavedViewRow | null> {
  const { rows } = await pool.query<SavedViewRow>('SELECT * FROM saved_views WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Clears any existing default for the owner. The partial unique index makes
 * two defaults impossible; this is what keeps a "make default" from tripping
 * over it rather than what enforces the rule.
 */
async function clearDefault(client: pg.PoolClient, ownerId: string, exceptId?: string): Promise<void> {
  await client.query(
    `UPDATE saved_views SET is_default = false, updated_at = now()
      WHERE owner_id = $1 AND is_default AND ($2::text IS NULL OR id <> $2)`,
    [ownerId, exceptId ?? null],
  );
}

export async function createSavedView(
  pool: pg.Pool,
  args: {
    ownerId: string;
    name: string;
    query: string;
    visibility: ViewVisibility;
    isDefault: boolean;
  },
): Promise<SavedViewRow> {
  return withTransaction(pool, async (client) => {
    if (args.isDefault) await clearDefault(client, args.ownerId);
    const { rows } = await client.query<SavedViewRow>(
      `INSERT INTO saved_views (id, owner_id, name, query, visibility, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [newUlid(), args.ownerId, args.name, args.query, args.visibility, args.isDefault],
    );
    return rows[0]!;
  });
}

export async function updateSavedView(
  pool: pg.Pool,
  id: string,
  patch: {
    name?: string;
    query?: string;
    visibility?: ViewVisibility;
    isDefault?: boolean;
  },
): Promise<SavedViewRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query<SavedViewRow>(
      'SELECT * FROM saved_views WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = existing[0];
    if (!row) return null;
    if (patch.isDefault === true) await clearDefault(client, row.owner_id, id);

    const { rows } = await client.query<SavedViewRow>(
      `UPDATE saved_views
          SET name       = COALESCE($2, name),
              query      = COALESCE($3, query),
              visibility = COALESCE($4, visibility),
              is_default = COALESCE($5, is_default),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, patch.name ?? null, patch.query ?? null, patch.visibility ?? null, patch.isDefault ?? null],
    );
    return rows[0] ?? null;
  });
}

export async function deleteSavedView(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM saved_views WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function countSavedViews(pool: pg.Pool, ownerId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM saved_views WHERE owner_id = $1',
    [ownerId],
  );
  return Number(rows[0]?.count ?? '0');
}
