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
  verified: boolean;
  sso_provider: 'google' | null;
  password_digest: string | null;
  partner_id: string | null;
  created_at: Date;
}

export interface UserWithRoles extends UserRow {
  roles: RoleKey[];
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
