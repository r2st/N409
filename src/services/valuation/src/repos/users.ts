import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { RoleKey } from '../domain/roles.js';

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
      [id, args.email, args.firstName ?? null, args.lastName ?? null, args.provisionedBy, args.externalId ?? null],
    );
    await assignRoles(client, id, args.roles);
    return { ...rows[0]!, roles: args.roles };
  });
}

export async function findUserByExternalId(
  pool: pg.Pool,
  externalId: string,
): Promise<UserWithRoles | null> {
  const { rows } = await pool.query<UserWithRoles>(
    `SELECT u.*, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.scim_external_id = $1
      GROUP BY u.id`,
    [externalId],
  );
  return rows[0] ?? null;
}

/** Soft delete / reactivate for SCIM `active` toggling. */
export async function setUserActive(pool: pg.Pool, id: string, active: boolean): Promise<void> {
  await pool.query(
    `UPDATE users SET deleted_at = ${active ? 'NULL' : 'now()'} WHERE id = $1`,
    [id],
  );
}

export async function assignRoles(client: pg.PoolClient, userId: string, roles: RoleKey[]): Promise<void> {
  for (const role of roles) {
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE key = $2
       ON CONFLICT DO NOTHING`,
      [userId, role],
    );
  }
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

export async function updateOwnProfile(
  pool: pg.Pool,
  id: string,
  patch: OwnProfilePatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(
    ([k, v]) => v !== undefined && OWN_PROFILE_COLUMNS.has(k),
  );
  if (entries.length === 0) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${entries.length + 1}`, [
    ...entries.map(([, v]) => v),
    id,
  ]);
}

export async function setPasswordDigest(
  pool: pg.Pool,
  id: string,
  digest: string,
): Promise<void> {
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
