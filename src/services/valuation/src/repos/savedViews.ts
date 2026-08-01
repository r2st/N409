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
 * Everything the principal may see: their own views always, plus every shared
 * view when they are ops. Own views sort first so a picker can show them
 * without a second query.
 */
export async function listVisibleViews(
  pool: pg.Pool,
  args: { userId: string; includeShared: boolean },
): Promise<SavedViewWithOwner[]> {
  const { rows } = await pool.query<SavedViewWithOwner>(
    `SELECT v.*, u.email AS owner_email, u.first_name AS owner_first_name, u.last_name AS owner_last_name
       FROM saved_views v
       JOIN users u ON u.id = v.owner_id
      WHERE v.owner_id = $1
         OR ($2::boolean AND v.visibility = 'shared')
      ORDER BY (v.owner_id = $1) DESC, lower(v.name)`,
    [args.userId, args.includeShared],
  );
  return rows;
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
