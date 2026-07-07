import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
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

// ── Partners (pickers + admin creation) ──────────────────────────────────────

export interface PartnerRow {
  id: string;
  name: string;
  key: string;
  created_at: Date;
}

export async function listPartners(pool: pg.Pool): Promise<PartnerRow[]> {
  const { rows } = await pool.query<PartnerRow>(
    'SELECT id, name, key, created_at FROM partners ORDER BY name ASC',
  );
  return rows;
}

export async function createPartner(
  pool: pg.Pool,
  args: { name: string; key: string },
): Promise<PartnerRow> {
  const { rows } = await pool.query<PartnerRow>(
    'INSERT INTO partners (id, name, key) VALUES ($1, $2, $3) RETURNING id, name, key, created_at',
    [newUlid(), args.name, args.key],
  );
  return rows[0]!;
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
