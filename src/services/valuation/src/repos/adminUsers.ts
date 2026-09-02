import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { likeContains, userSearchSql } from '../db/like.js';
import { stateGroupOf } from '../domain/operations.js';
import { NAMED_BUCKET_KEYS, namedBucketsFor } from '../domain/workflow.js';
import { assignRoles, type UserWithRoles } from './users.js';
import { invalidateReleased, releaseAssignedWork, type ReleasedWork } from './assignedWork.js';
import type { EventActor } from '../events/record.js';
import { revokeInvitationsFrom } from './invitations.js';
import type { RoleKey } from '../domain/roles.js';
import { SUSPENDED_ROLE } from '../auth/rbac.js';

/** Admin console queries (M3 feature 13) — list/edit/soft-delete users. */

/**
 * Ceiling on a picker response.
 *
 * High enough that every ops team and all but the largest partner rosters come
 * back whole — so the dropdowns keep behaving exactly as they did — and low
 * enough that one customer's growth cannot turn a page load into a full table
 * scan serialised over the wire. Past it the caller gets `truncated` and is
 * expected to search rather than scroll.
 */
export const PICKER_LIMIT = 200;

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
  if (filters.q) {
    // Not through `add`: the predicate uses its one bound parameter twice, and
    // `add` substitutes a single placeholder. See `userSearchSql`.
    params.push(likeContains(filters.q));
    where.push(userSearchSql(`$${params.length}`, 'u'));
  }
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
  /*
   * Started here and joined below, so the count and the page overlap rather
   * than costing this console the sum of two round trips (R351, M8 — the shape
   * R338 fixed on the activity log and the firm roster). Neither statement
   * reads anything the other produces; `paged` exists precisely because they
   * carry different parameter lists.
   *
   * The count is the half with no ceiling on it: the page below stops at
   * `perPage` ids out of 0148's partial index, and `count(*)` over the same
   * predicate reads every account that matches. The `role` filter makes it a
   * correlated EXISTS over `user_roles` per row on top of that.
   */
  const counting = pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM users u ${whereSql}`,
    params,
  );

  /*
   * Page first, then join — not the other way round.
   *
   * The single-statement form joined `partners`, `user_roles` and `roles`
   * across every matching user, grouped the lot, sorted it, and only then
   * threw all but 25 rows away. LIMIT cannot be pushed under a GROUP BY, so
   * the aggregate's cost was the size of the *table*, not the size of the
   * page: a console listing 25 of 40,000 accounts built 40,000 role arrays to
   * print 25 of them, and the work grew with every sign-up. The partial index
   * on `users (created_at DESC) WHERE deleted_at IS NULL` (0148) can serve the
   * ordering directly, but only for a plan that reads `users` alone — which is
   * what the CTE is.
   *
   * The tiebreaker is not cosmetic. `created_at DESC` alone leaves ties in
   * whatever order the plan happens to produce, and this query is paginated:
   * two users created in the same millisecond (a SCIM import, a seeded test
   * fixture) could appear on both page one and page two, or on neither. The
   * ids are ULIDs, so `id DESC` continues the ordering the timestamp started
   * rather than cutting across it.
   */
  const paged = [...params, filters.perPage, (filters.page - 1) * filters.perPage];
  const [{ rows: countRows }, { rows }] = await Promise.all([
    counting,
    pool.query<AdminUserRow>(
      `WITH page AS (
       SELECT u.id, u.created_at
         FROM users u
         ${whereSql}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $${paged.length - 1} OFFSET $${paged.length}
     )
     SELECT u.*, p.name AS partner_name,
            coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM page
     JOIN users u ON u.id = page.id
     LEFT JOIN partners p ON p.id = u.partner_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id, p.name
     ORDER BY u.created_at DESC, u.id DESC`,
      paged,
    ),
  ]);
  return { items: rows, total: Number(countRows[0]!.count) };
}

export interface AdminUserPatch {
  first_name?: string | null;
  last_name?: string | null;
  email?: string;
  phone?: string | null;
  job_title?: string | null;
  company_name?: string | null;
  verified?: boolean;
  partner_id?: string | null;
  roles?: RoleKey[];
}

/**
 * Columns an admin may patch, mirroring OWN_PROFILE_COLUMNS in repos/users.ts.
 * The keys of this patch become raw SQL identifiers, so — as there — the
 * allow-list is repeated at the point of interpolation instead of being trusted
 * from whatever the route's parsed body happened to contain. A future schema
 * change to AdminUserPatch, or a route that forwards an unvalidated object,
 * then cannot reach `password_digest`, `session_epoch` or `deleted_at`.
 */
const ADMIN_PATCH_COLUMNS: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'email',
  'phone',
  'job_title',
  'company_name',
  'verified',
  'partner_id',
]);

/** Field patch + full role replacement in one transaction. */
export async function adminPatchUser(pool: pg.Pool, id: string, patch: AdminUserPatch): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { roles, ...fields } = patch;
    const entries = Object.entries(fields).filter(([k, v]) => v !== undefined && ADMIN_PATCH_COLUMNS.has(k));
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
/**
 * Close an account: soft-delete it, drop its roles, retire the invitations it
 * still has outstanding, and release the work it was holding.
 *
 * The fourth of those is the one that was missing, and it is the one nothing
 * could see — see {@link releaseAssignedWork}, which is the rule and holds the
 * argument, because the directory's deprovision reaches this same state through
 * `setUserActive` and had the same hole.
 *
 * All four in one transaction: a closure that took the roles and left the file
 * on the departed analyst's name is the state this is meant to make
 * unreachable, and a second statement after the commit is one a crash can skip.
 */
export async function softDeleteUser(
  pool: pg.Pool,
  id: string,
  actor: EventActor,
): Promise<ReleasedWork | null> {
  const released = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if ((rowCount ?? 0) === 0) return null;
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
    await revokeInvitationsFrom(client, id);
    return releaseAssignedWork(client, id, actor, 'account_closed');
  });
  invalidateReleased(released);
  return released;
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
  /** White-label workflow email overrides: template key → { subject, body }. */
  email_templates: Record<string, { subject: string; body: string }>;
  /** The firm's public address (0106), or null while it is still on ours. */
  subdomain: string | null;
  /** Bulk-paid firm: its engagements never see a payment link (0113). */
  prepaid: boolean;
  /** The firm's shared mailbox, copied on client correspondence (0113). */
  cc_emails: string[];
  /**
   * The firm's public-facing name (0091), and whether its brand is live.
   *
   * Both belong on this row because the ops console shows a preview of the
   * branded login page, and without them that preview was of a page that no
   * longer exists: it drew the ops channel label and the firm's colour on a
   * page the client sees platform branding on until the switch is on.
   */
  brand_name: string | null;
  white_label_enabled: boolean;
  user_count: number;
  valuation_count: number;
}

/** Per-partner rollups keep the admin Partners page a single request. */
const PARTNER_COUNTS_SQL = `
  (SELECT count(*)::int FROM users u WHERE u.partner_id = p.id AND u.deleted_at IS NULL) AS user_count,
  (SELECT count(*)::int FROM valuations v WHERE v.partner_id = p.id) AS valuation_count`;

const PARTNER_COLUMNS_SQL = `p.id, p.name, p.key, p.created_at, p.archived_at, p.brand_color, p.logo_url,
  p.email_templates, p.subdomain, p.prepaid, p.cc_emails, p.brand_name, p.white_label_enabled`;

/**
 * Archived partners are hidden by default so pickers only offer live channels.
 *
 * Capped on the same terms as `listUserOptions`, and for a sharper reason: each
 * row carries two correlated counts over `users` and `valuations`, so the work
 * this query does grows with the partner roster *and* with everything every
 * partner owns. Truncation is reported rather than hidden.
 */
export async function listPartners(
  pool: pg.Pool,
  opts: { includeArchived?: boolean; q?: string; limit?: number } = {},
): Promise<{ partners: PartnerRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? PICKER_LIMIT, 1), PICKER_LIMIT);
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeArchived) where.push('p.archived_at IS NULL');
  if (opts.q) {
    params.push(likeContains(opts.q));
    where.push(`concat_ws(' ', p.name, p.key) ILIKE $${params.length}`);
  }
  params.push(limit + 1);
  const { rows } = await pool.query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS_SQL}, ${PARTNER_COUNTS_SQL}
     FROM partners p
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.name ASC
     LIMIT $${params.length}`,
    params,
  );
  return { partners: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findPartnerById(pool: pg.Pool, id: string): Promise<PartnerRow | null> {
  const { rows } = await pool.query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS_SQL}, ${PARTNER_COUNTS_SQL} FROM partners p WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createPartner(pool: pg.Pool, args: { name: string; key: string }): Promise<PartnerRow> {
  const { rows } = await pool.query<PartnerRow>(
    `INSERT INTO partners (id, name, key) VALUES ($1, $2, $3)
     RETURNING id, name, key, created_at, archived_at, brand_color, logo_url, email_templates,
               subdomain, prepaid, cc_emails, brand_name, white_label_enabled,
               0 AS user_count, 0 AS valuation_count`,
    [newUlid(), args.name, args.key],
  );
  return rows[0]!;
}

export interface PartnerPatch {
  name?: string;
  brand_color?: string | null;
  logo_url?: string | null;
  email_templates?: Record<string, { subject: string; body: string }>;
  /**
   * Normalised and reserved-word-checked by the route (domain/partnerSubdomain.ts);
   * null releases the address. The unique index is the real arbiter — two
   * admins can claim the same label in the same second, and only one insert
   * wins.
   */
  subdomain?: string | null;
  prepaid?: boolean;
  cc_emails?: string[];
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
  if (patch.email_templates !== undefined) add('email_templates = ?', JSON.stringify(patch.email_templates));
  if (patch.subdomain !== undefined) add('subdomain = ?', patch.subdomain);
  if (patch.prepaid !== undefined) add('prepaid = ?', patch.prepaid);
  if (patch.cc_emails !== undefined) add('cc_emails = ?', patch.cc_emails);
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
  /**
   * The nine named buckets (design §4.2), scoped to this firm — the counts the
   * partner-scoped entry point carries (§4.4). The listing tab strip and the
   * sidebar badges read the same definition from `domain/workflow.ts`, so this
   * page and the page it links to cannot disagree about what "in progress"
   * means.
   */
  valuations_by_bucket: Record<string, number>;
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
    pool.query<{ state: string; waiting_on_client: boolean; count: number }>(
      `SELECT state::text, waiting_on_client, count(*)::int AS count FROM valuations
       WHERE partner_id = $1 GROUP BY state, waiting_on_client`,
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
  const byBucket: Record<string, number> = Object.fromEntries(NAMED_BUCKET_KEYS.map((k) => [k, 0]));
  for (const row of groups) {
    const state = row.state as Parameters<typeof stateGroupOf>[0];
    byGroup[stateGroupOf(state)] = (byGroup[stateGroupOf(state)] ?? 0) + row.count;
    // `namedBucketsFor` already returns `all`, and a state in none of the
    // named buckets deliberately has no fallback — it shows up as counts that
    // do not add up rather than being filed silently under Ignored.
    for (const key of namedBucketsFor(state)) byBucket[key] = (byBucket[key] ?? 0) + row.count;
    if (row.waiting_on_client) {
      byBucket.waiting_on_client = (byBucket.waiting_on_client ?? 0) + row.count;
    }
  }
  return {
    ...partner,
    valuations_by_group: byGroup,
    valuations_by_bucket: byBucket,
    last_activity_at: activity[0]?.last_activity_at ?? null,
    users: users as PartnerDetail['users'],
  };
}

export interface UserOptionRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Lightweight id+label list for filter dropdowns (reviewer picker etc.).
 *
 * Capped, and honest about it. The `partner` group is every partner user on
 * the platform and the `ops` group is every member of staff; neither is bounded
 * by anything but how well the business does, and both were being read in full
 * to populate a `<select>`. The cap alone would be worse than the unbounded
 * read, though — a reviewer missing from the picker cannot be assigned, and
 * silently short lists are how that happens — so the caller is told when the
 * list was trimmed and can offer the search that narrows it.
 *
 * One row past the limit is fetched rather than counted: it answers "is there
 * more" without a second pass over the join.
 */
export async function listUserOptions(
  pool: pg.Pool,
  group: 'ops' | 'partner',
  opts: { q?: string; limit?: number } = {},
): Promise<{ options: UserOptionRow[]; truncated: boolean }> {
  const keys =
    group === 'ops'
      ? [
          'admin',
          'god',
          'supervisor',
          'support',
          'support_supervisor',
          'reviewer',
          'main_reviewer',
          'contributing_reviewer',
          'data',
          'data_supervisor',
          'auto',
          'spa',
        ]
      : ['partner', 'member'];
  const limit = Math.min(Math.max(opts.limit ?? PICKER_LIMIT, 1), PICKER_LIMIT);
  const params: unknown[] = [keys];
  let search = '';
  if (opts.q) {
    params.push(likeContains(opts.q));
    search = `AND ${userSearchSql(`$${params.length}`, 'u')}`;
  }
  params.push(SUSPENDED_ROLE);
  const suspended = `$${params.length}`;
  params.push(limit + 1);
  const { rows } = await pool.query<UserOptionRow>(
    /*
     * Suspended accounts are excluded as well as deactivated ones, and the
     * `NOT EXISTS` is why it takes a subquery rather than another `AND`: this
     * join is on a role row, and `ignored` is *additive*. A suspended
     * administrator keeps the `admin` grant that put them in `keys`, so the
     * outer join matches on that row and says nothing about the suspension —
     * which is exactly how they went on being offered, by name, in the picker
     * an operator assigns reviewers from.
     *
     * A dropdown that offers somebody is a dropdown that expects them to be
     * assignable, and since `assignableUser` they are not: the assignment is
     * refused. Offering an option the write will reject is worse than the
     * suspension being invisible here — the operator picks a colleague, is told
     * no, and has no way to tell that from a bug. Both sides now read the same
     * rule; see `SUSPENDED_ROLE`, which is the one spelling of it.
     */
    `SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.key = ANY($1) AND u.deleted_at IS NULL ${search}
       AND NOT EXISTS (
         SELECT 1 FROM user_roles sur JOIN roles sr ON sr.id = sur.role_id
          WHERE sur.user_id = u.id AND sr.key = ${suspended}
       )
     ORDER BY u.email ASC
     LIMIT $${params.length}`,
    params,
  );
  return { options: rows.slice(0, limit), truncated: rows.length > limit };
}
