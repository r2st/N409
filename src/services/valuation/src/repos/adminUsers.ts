import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { stateGroupOf } from '../domain/operations.js';
import { assignRoles, type UserWithRoles } from './users.js';
import type { RoleKey } from '../domain/roles.js';

/** Admin console queries (M3 feature 13) — list/edit/soft-delete users. */

export interface UserListFilters {
  q?: string; // matches email or name, case-insensitive substring
  role?: RoleKey;
  partnerId?: string;
  includeDeleted?: boolean;
  page: number;
  perPage: number;
}

export interface AdminUserRow extends UserWithRoles {
  deleted_at: Date | null;
  partner_name: string | null;
}

function buildUserWhere(filters: UserListFilters): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (!filters.includeDeleted) where.push('u.deleted_at IS NULL');
  if (filters.q) add(`concat_ws(' ', u.email, u.first_name, u.last_name) ILIKE ?`, `%${filters.q}%`);
  if (filters.partnerId) add('u.partner_id = ?', filters.partnerId);
  if (filters.role)
    add(
      `EXISTS (SELECT 1 FROM user_roles fr JOIN roles fk ON fk.id = fr.role_id
               WHERE fr.user_id = u.id AND fk.key = ?)`,
      filters.role,
    );
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listUsers(
  pool: pg.Pool,
  filters: UserListFilters,
): Promise<{ items: AdminUserRow[]; total: number }> {
  const { whereSql, params } = buildUserWhere(filters);
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM users u ${whereSql}`,
    params,
  );

  const paged = [...params, filters.perPage, (filters.page - 1) * filters.perPage];
  const { rows } = await pool.query<AdminUserRow>(
    `SELECT u.*, p.name AS partner_name,
            coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN partners p ON p.id = u.partner_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     ${whereSql}
     GROUP BY u.id, p.name
     ORDER BY u.created_at DESC
     LIMIT $${paged.length - 1} OFFSET $${paged.length}`,
    paged,
  );
  return { items: rows, total: Number(countRows[0]!.count) };
}

export interface AdminUserPatch {
  first_name?: string | null;
  last_name?: string | null;
  email?: string;
  phone?: string | null;
  verified?: boolean;
  partner_id?: string | null;
  roles?: RoleKey[];
}

/** Field patch + full role replacement in one transaction. */
export async function adminPatchUser(
  pool: pg.Pool,
  id: string,
  patch: AdminUserPatch,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { roles, ...fields } = patch;
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
      await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${entries.length + 1}`, [
        ...entries.map(([, v]) => v),
        id,
      ]);
    }
    if (roles) {
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      await assignRoles(client, id, roles);
    }
  });
}

/** Soft delete: the user keeps their audit trail but can no longer sign in. */
export async function softDeleteUser(pool: pg.Pool, id: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if ((rowCount ?? 0) === 0) return false;
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
    return true;
  });
}

/**
 * Reactivate a soft-deleted user (feature #9). Deactivation dropped their
 * roles, so the restored account comes back role-less — the admin re-assigns
 * roles from the console before the user can see anything.
 */
export async function restoreUser(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE users SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

// ── Partners (pickers + admin management, P1 #7) ─────────────────────────────

export interface PartnerRow {
  id: string;
  name: string;
  key: string;
  created_at: Date;
  archived_at: Date | null;
  brand_color: string | null;
  logo_url: string | null;
  user_count: number;
  valuation_count: number;
}

/** Per-partner rollups keep the admin Partners page a single request. */
const PARTNER_COUNTS_SQL = `
  (SELECT count(*)::int FROM users u WHERE u.partner_id = p.id AND u.deleted_at IS NULL) AS user_count,
  (SELECT count(*)::int FROM valuations v WHERE v.partner_id = p.id) AS valuation_count`;

const PARTNER_COLUMNS_SQL = `p.id, p.name, p.key, p.created_at, p.archived_at, p.brand_color, p.logo_url`;

/** Archived partners are hidden by default so pickers only offer live channels. */
export async function listPartners(
  pool: pg.Pool,
  opts: { includeArchived?: boolean } = {},
): Promise<PartnerRow[]> {
  const { rows } = await pool.query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS_SQL}, ${PARTNER_COUNTS_SQL}
     FROM partners p
     ${opts.includeArchived ? '' : 'WHERE p.archived_at IS NULL'}
     ORDER BY p.name ASC`,
  );
  return rows;
}

export async function findPartnerById(pool: pg.Pool, id: string): Promise<PartnerRow | null> {
  const { rows } = await pool.query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS_SQL}, ${PARTNER_COUNTS_SQL} FROM partners p WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createPartner(
  pool: pg.Pool,
  args: { name: string; key: string },
): Promise<PartnerRow> {
  const { rows } = await pool.query<PartnerRow>(
    `INSERT INTO partners (id, name, key) VALUES ($1, $2, $3)
     RETURNING id, name, key, created_at, archived_at, brand_color, logo_url,
               0 AS user_count, 0 AS valuation_count`,
    [newUlid(), args.name, args.key],
  );
  return rows[0]!;
}

export interface PartnerPatch {
  name?: string;
  brand_color?: string | null;
  logo_url?: string | null;
  /** true → stamp archived_at (idempotent); false → clear it. */
  archived?: boolean;
}

export async function updatePartner(
  pool: pg.Pool,
  id: string,
  patch: PartnerPatch,
): Promise<PartnerRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (sql: string, value?: unknown) => {
    if (value === undefined) {
      sets.push(sql);
    } else {
      params.push(value);
      sets.push(sql.replace('?', `$${params.length}`));
    }
  };
  if (patch.name !== undefined) add('name = ?', patch.name);
  if (patch.brand_color !== undefined) add('brand_color = ?', patch.brand_color);
  if (patch.logo_url !== undefined) add('logo_url = ?', patch.logo_url);
  if (patch.archived === true) add('archived_at = coalesce(archived_at, now())');
  if (patch.archived === false) add('archived_at = NULL');
  if (sets.length === 0) return findPartnerById(pool, id);

  const { rows } = await pool.query<PartnerRow>(
    `UPDATE partners p SET ${sets.join(', ')} WHERE p.id = $1
     RETURNING ${PARTNER_COLUMNS_SQL}, ${PARTNER_COUNTS_SQL}`,
    params,
  );
  return rows[0] ?? null;
}

export interface PartnerDetail extends PartnerRow {
  valuations_by_group: Record<string, number>;
  last_activity_at: Date | null;
  users: Array<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    roles: string[];
  }>;
}

/** Detail rollups for the admin partner page: states, users, last activity. */
export async function getPartnerDetail(pool: pg.Pool, id: string): Promise<PartnerDetail | null> {
  const partner = await findPartnerById(pool, id);
  if (!partner) return null;

  const [{ rows: groups }, { rows: users }, { rows: activity }] = await Promise.all([
    pool.query<{ state: string; count: number }>(
      `SELECT state::text, count(*)::int AS count FROM valuations
       WHERE partner_id = $1 GROUP BY state`,
      [id],
    ),
    pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name,
              coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.partner_id = $1 AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.email ASC`,
      [id],
    ),
    pool.query<{ last_activity_at: Date | null }>(
      `SELECT max(e.occurred_at) AS last_activity_at
       FROM valuation_events e
       JOIN valuations v ON v.id = e.valuation_id
       WHERE v.partner_id = $1`,
      [id],
    ),
  ]);

  const byGroup: Record<string, number> = {};
  for (const row of groups) {
    const group = stateGroupOf(row.state as Parameters<typeof stateGroupOf>[0]);
    byGroup[group] = (byGroup[group] ?? 0) + row.count;
  }
  return {
    ...partner,
    valuations_by_group: byGroup,
    last_activity_at: activity[0]?.last_activity_at ?? null,
    users: users as PartnerDetail['users'],
  };
}

/** Lightweight id+label list for filter dropdowns (reviewer picker etc.). */
export async function listUserOptions(
  pool: pg.Pool,
  group: 'ops' | 'partner',
): Promise<Array<{ id: string; email: string; first_name: string | null; last_name: string | null }>> {
  const keys =
    group === 'ops'
      ? ['admin', 'god', 'supervisor', 'support', 'support_supervisor', 'reviewer', 'main_reviewer', 'contributing_reviewer', 'data', 'data_supervisor', 'auto', 'spa']
      : ['partner', 'member'];
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.key = ANY($1) AND u.deleted_at IS NULL
     ORDER BY u.email ASC`,
    [keys],
  );
  return rows;
}
