/**
 * The accounts the suite runs as, and the one place that knows how to make one.
 *
 * Registration goes through the public API rather than an INSERT, so the users
 * these tests run as are made the same way a real one is — password hashing,
 * default role, org bootstrap and all. The only thing done behind the API's
 * back is granting the ops roles, because there is deliberately no endpoint
 * that lets an account promote itself.
 */

import pg from 'pg';

export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://n409:n409_dev@localhost:5432/n409_e2e';

export const ADMIN = {
  email: 'e2e-admin@n409.test',
  password: 'E2eAdminPassw0rd!',
  first_name: 'Ada',
  last_name: 'Admin',
  company_name: 'N409 E2E Admin Co',
};

export const ANALYST = {
  email: 'e2e-analyst@n409.test',
  password: 'E2eAnalystPassw0rd!',
  first_name: 'Nils',
  last_name: 'Analyst',
  company_name: 'Northwind Analytics',
};

export const STORAGE_STATE = {
  admin: 'e2e/.artifacts/state-admin.json',
  analyst: 'e2e/.artifacts/state-analyst.json',
};

export type Account = typeof ADMIN;

/**
 * Register through the API, tolerating an account that already exists so the
 * suite is re-runnable against a database somebody chose not to reset.
 */
export async function ensureAccount(apiBase: string, account: Account): Promise<void> {
  const res = await fetch(`${apiBase}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  if (res.ok) return;
  // Already registered is fine; anything else is not, and the body says why.
  const body = await res.text();
  if (res.status === 409 || /exists|taken|duplicate/i.test(body)) return;
  throw new Error(`could not register ${account.email}: ${res.status} ${body}`);
}

/** Grant ops roles directly — there is no self-promotion endpoint, by design. */
export async function grantRoles(email: string, roleKeys: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r
        WHERE u.email = $1 AND r.key = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [email, roleKeys],
    );
  } finally {
    await client.end();
  }
}

/** Mark the address verified, so a verification banner never covers a control. */
export async function markVerified(email: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE users SET verified = true WHERE email = $1`, [email]);
  } finally {
    await client.end();
  }
}
