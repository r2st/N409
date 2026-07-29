import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { newUlid } from '@n409/shared';
import type { RoleKey } from '../../src/domain/roles.js';

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://n409:n409_dev@localhost:5432/n409_dev';

export async function isDbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export interface TestDb {
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

/** Creates a throwaway database, migrates it, and drops it on teardown. */
export async function setupTestDb(): Promise<TestDb> {
  const dbName = `n409_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  await migrate(pool);

  return {
    pool,
    teardown: async () => {
      await pool.end();
      const drop = new pg.Client({ connectionString: BASE_URL });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await drop.end();
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

/**
 * Stands in for the AI/engine `/ready` probes. `status` drives every probe;
 * pass 503 (or throw) to model a downstream outage.
 */
export function stubReadinessFetch(status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify({ status: 'ready' }), { status })) as typeof fetch;
}

export async function setupTestApp(
  env: Record<string, string> = {},
  deps: Partial<Parameters<typeof buildApp>[0]> = {},
): Promise<TestApp> {
  const db = await setupTestDb();
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: 'integration-test-secret-0123456789abcdef',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const app = buildApp({
    config,
    pool: db.pool,
    // /ready probes the AI and engine services, which no integration suite runs.
    // Default them to "up" so only the tests that care about readiness have to
    // think about them; those pass their own readinessFetch below.
    readinessFetch: stubReadinessFetch(),
    ...deps,
  });
  await app.ready();
  return {
    app,
    pool: db.pool,
    teardown: async () => {
      await app.close();
      await db.teardown();
    },
  };
}

/** Registers a user with the given roles directly in the DB and returns a bearer token. */
export async function seedUser(
  ctx: TestApp,
  args: { email?: string; roles: RoleKey[]; partnerId?: string | null },
): Promise<{ id: string; email: string; token: string }> {
  const email = args.email ?? `${newUlid().toLowerCase()}@test.example.com`;
  const password = 'test-password-123';
  const user = await createUser(ctx.pool, {
    email,
    passwordDigest: await hashPassword(password),
    roles: args.roles,
    partnerId: args.partnerId ?? null,
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`seedUser login failed: ${res.body}`);
  return { id: user.id, email, token: res.json().token as string };
}

export async function seedPartner(ctx: TestApp, name: string): Promise<string> {
  const id = newUlid();
  await ctx.pool.query('INSERT INTO partners (id, name, key) VALUES ($1, $2, $3)', [
    id,
    name,
    name.toLowerCase().replace(/\s+/g, '-'),
  ]);
  return id;
}

export const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });
