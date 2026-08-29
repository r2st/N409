import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { RoleKey } from '../domain/roles.js';
import { revokeInvitationsFrom } from './invitations.js';

export interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  job_title: string | null;
  company_name: string | null;
  timezone: string | null;
  verified: boolean;
  sso_provider: 'google' | null;
  password_digest: string | null;
  partner_id: string | null;
  created_at: Date;
  /** Soft delete (M3 admin console): set = cannot authenticate. */
  deleted_at: Date | null;
  /** Bumped to invalidate every session JWT minted for this user so far. */
  session_epoch: number;
  /** AES-256-GCM-encrypted base32 TOTP secret (feature: MFA/2FA). */
  totp_secret: string | null;
  /** True once a TOTP enrolment has been confirmed with a valid code. */
  totp_enabled: boolean;
  totp_confirmed_at: Date | null;
  /** External-provisioning provenance (feature 9): 'saml' | 'scim' | null. */
  provisioned_by: string | null;
  scim_external_id: string | null;
}

export interface UserWithRoles extends UserRow {
  roles: RoleKey[];
}

/** Columns a user may edit on their own account. */
export interface OwnProfilePatch {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  job_title?: string | null;
  company_name?: string | null;
  timezone?: string | null;
  email?: string;
}

export async function findUserByEmail(pool: pg.Pool, email: string): Promise<UserWithRoles | null> {
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE lower(u.email) = lower($1)
     GROUP BY u.id`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(pool: pg.Pool, id: string): Promise<UserWithRoles | null> {
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}

/** The columns the `authenticate` preHandler actually reads. */
export interface AuthPrincipalRow {
  id: string;
  roles: RoleKey[];
  partner_id: string | null;
  deleted_at: Date | null;
  session_epoch: number;
}

/**
 * The narrow read behind bearer authentication.
 *
 * This runs on *every authenticated request* — it is the single most-executed
 * statement in the service — and it used to be `findUserById`, which is
 * `SELECT u.*`. The preHandler reads five fields; the other seventeen columns
 * were fetched, decoded and thrown away several times per page load, and among
 * them are `password_digest` and the encrypted `totp_secret`, which have no
 * business being materialised into the request path of a route that only wants
 * to know who is calling.
 *
 * Deliberately *not* cached. `plugins/auth.ts` documents why: roles and partner
 * are re-read per request so that a role change or a removal takes effect
 * immediately rather than at token expiry, and a TTL — however short — is
 * exactly the window in which a revoked operator keeps their access. Making
 * the read cheap is the alternative to making it rare.
 */
export async function findAuthPrincipal(pool: pg.Pool, id: string): Promise<AuthPrincipalRow | null> {
  const { rows } = await pool.query<AuthPrincipalRow>(
    `SELECT u.id, u.partner_id, u.deleted_at, u.session_epoch,
            coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Whether a user id names a row — for the reviewer and assignee checks.
 *
 * Four routes (workflow reassign, bulk assign_reviewer, the valuation patch and
 * task assignment) called `findUserById` and did nothing with the result but
 * test it for null. That is `SELECT u.*` plus a two-table join to build a role
 * array nobody reads.
 *
 * Soft-deleted accounts count as existing, which is what `findUserById`
 * returned and therefore what those routes already accepted. Whether a deleted
 * user should be assignable is a real question, but it is a behaviour change
 * and not this one's to make.
 */
export async function userExists(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * Several users by id, keyed by id — one query for a set the caller already
 * knows the whole of.
 *
 * The shape that wants this is a sweep holding a list of rows that each name a
 * user: the monitoring scan looking up an assigned reviewer per firing trigger,
 * re-reading the same reviewer for every trigger on the same engagement. Ids
 * are de-duplicated here so the caller does not have to.
 */
/**
 * Users by id, deactivated accounts excluded.
 *
 * Both callers use the result to decide who to *write to* — the state-change
 * hook resolves the owner and reviewer of a transition, the monitoring sweep
 * resolves the reviewer to alert — and neither applied the soft delete that
 * `listUsers`, the firm roster, the reviewer picker, password reset and email
 * verification all apply. The drip-campaign candidate query grew its own
 * `u.deleted_at IS NULL` for exactly this reason; these two are the rest of it.
 * A deactivated account kept receiving workflow email and in-app notifications,
 * which is the one thing deactivating it was supposed to stop.
 *
 * Filtered here rather than at the two call sites so a third caller inherits
 * the rule instead of rediscovering it.
 */
export async function findUsersByIds(
  pool: pg.Pool,
  ids: readonly string[],
): Promise<Map<string, UserWithRoles>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = ANY($1::ulid[]) AND u.deleted_at IS NULL
     GROUP BY u.id`,
    [unique],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

export async function createUser(
  pool: pg.Pool,
  args: {
    email: string;
    passwordDigest?: string;
    ssoProvider?: 'google';
    firstName?: string;
    lastName?: string;
    partnerId?: string | null;
    verified?: boolean;
    roles: RoleKey[];
  },
): Promise<UserWithRoles> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (id, email, password_digest, sso_provider, first_name, last_name, partner_id, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        args.email,
        args.passwordDigest ?? null,
        args.ssoProvider ?? null,
        args.firstName ?? null,
        args.lastName ?? null,
        args.partnerId ?? null,
        args.verified ?? false,
      ],
    );
    await assignRoles(client, id, args.roles);
    return { ...rows[0]!, roles: args.roles };
  });
}

/**
 * Create a user provisioned by an external identity source (SAML JIT / SCIM),
 * with no password and no Google link — the relaxed users_auth_method
 * constraint (migration 0082) accepts a `provisioned_by` account.
 */
export async function createProvisionedUser(
  pool: pg.Pool,
  args: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    provisionedBy: 'saml' | 'scim';
    externalId?: string | null;
    roles: RoleKey[];
  },
): Promise<UserWithRoles> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (id, email, first_name, last_name, verified, provisioned_by, scim_external_id)
       VALUES ($1, $2, $3, $4, true, $5, $6)
       RETURNING *`,
      [
        id,
        args.email,
        args.firstName ?? null,
        args.lastName ?? null,
        args.provisionedBy,
        args.externalId ?? null,
      ],
    );
    await assignRoles(client, id, args.roles);
    return { ...rows[0]!, roles: args.roles };
  });
}

/**
 * Active users holding any of the given roles — the audience for a system
 * alert that has no single owner to send to.
 *
 * Soft-deleted accounts are excluded: a notification nobody can log in to read
 * is the same as no notification, and it is exactly the alert that must not go
 * missing. Capped because a billing alert fanned out across a large ops team is
 * noise, and the first few holders of an admin role are enough for someone to
 * act; callers that need everyone should page, not notify.
 */
export async function listUserIdsWithRoles(
  pool: pg.Pool,
  roles: readonly RoleKey[],
  limit = 25,
): Promise<string[]> {
  if (roles.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT DISTINCT u.id, u.created_at
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.key = ANY($1::text[]) AND u.deleted_at IS NULL
      ORDER BY u.created_at ASC
      LIMIT $2`,
    [roles as readonly string[], limit],
  );
  return rows.map((r) => r.id);
}

/** Soft delete / reactivate for SCIM `active` toggling. */
/**
 * The directory's half of activation (SCIM deprovision / reactivate).
 *
 * Unlike `softDeleteUser` this deliberately keeps the account's roles: a SCIM
 * `active: false` is routinely followed by an `active: true` on the next
 * resync, and dropping the roles would hand the reactivated user an account
 * that can sign in and see nothing. But a deprovision is still the end of that
 * person's access, so the invitations they have outstanding go with it — the
 * same rule the console's own deactivation applies, for the same reason:
 * nothing else can revoke a link that is already in somebody's inbox.
 */
export async function setUserActive(pool: pg.Pool, id: string, active: boolean): Promise<void> {
  if (active) {
    await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [id]);
    return;
  }
  await withTransaction(pool, async (client) => {
    await client.query('UPDATE users SET deleted_at = now() WHERE id = $1', [id]);
    await revokeInvitationsFrom(client, id);
  });
}

/**
 * Grant a set of roles, in one statement rather than one per role.
 *
 * `key = ANY($2)` matches the whole set at once. A role key with no `roles` row
 * inserts nothing, which is what the per-role loop did too — the set is
 * validated where it is chosen, not here.
 */
export async function assignRoles(client: pg.PoolClient, userId: string, roles: RoleKey[]): Promise<void> {
  if (roles.length === 0) return;
  await client.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE key = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [userId, roles as readonly string[]],
  );
}

/** First Google sign-in creates the account; later sign-ins link/refresh it. */
export async function upsertGoogleUser(
  pool: pg.Pool,
  identity: { email: string; givenName?: string; familyName?: string },
): Promise<UserWithRoles> {
  const existing = await findUserByEmail(pool, identity.email);
  if (existing) {
    if (existing.sso_provider !== 'google') {
      await pool.query(`UPDATE users SET sso_provider = 'google', verified = true WHERE id = $1`, [
        existing.id,
      ]);
    }
    return { ...existing, sso_provider: 'google', verified: true };
  }
  return createUser(pool, {
    email: identity.email,
    ssoProvider: 'google',
    firstName: identity.givenName,
    lastName: identity.familyName,
    verified: true,
    roles: ['valuation_user'],
  });
}

/**
 * Self-service profile edit. The column allow-list is repeated here rather
 * than trusted from the caller's parsed body — this builds raw SQL identifiers,
 * so an unexpected key must be impossible, not merely unlikely.
 */
const OWN_PROFILE_COLUMNS: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'phone',
  'job_title',
  'company_name',
  'timezone',
  'email',
]);

export async function updateOwnProfile(pool: pg.Pool, id: string, patch: OwnProfilePatch): Promise<void> {
  const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && OWN_PROFILE_COLUMNS.has(k));
  if (entries.length === 0) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${entries.length + 1}`, [
    ...entries.map(([, v]) => v),
    id,
  ]);
}

export async function setPasswordDigest(pool: pg.Pool, id: string, digest: string): Promise<void> {
  await pool.query('UPDATE users SET password_digest = $2 WHERE id = $1', [id, digest]);
}

/**
 * Invalidates every session JWT issued to this user so far, and returns the
 * new epoch so the caller can mint a replacement token for the session that
 * asked for the revocation.
 */
export async function bumpSessionEpoch(pool: pg.Pool, id: string): Promise<number> {
  const { rows } = await pool.query<{ session_epoch: number }>(
    'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1 RETURNING session_epoch',
    [id],
  );
  const epoch = rows[0]?.session_epoch;
  if (epoch === undefined) throw new Error(`no such user: ${id}`);
  return epoch;
}
