/**
 * Drop, recreate and migrate the end-to-end database.
 *
 * Run before Playwright starts, never from inside it. The valuation service is
 * a Playwright `webServer`, so it holds a connection pool for the whole run — a
 * reset from a global-setup hook would either race the pool or be blocked by
 * it. Doing it here means every run starts from an empty schema with no live
 * connection to fight, which is what makes the suite order-independent.
 *
 * The database name is deliberately its own (`n409_e2e`, not `n409_dev`): these
 * tests drop the whole thing, and a developer's local data is not something a
 * test command should be able to take with it.
 */

import { execFileSync } from 'node:child_process';
import pg from 'pg';

const DB_NAME = process.env.E2E_DB_NAME ?? 'n409_e2e';
const ADMIN_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://n409:n409_dev@localhost:5432/postgres';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `postgres://n409:n409_dev@localhost:5432/${DB_NAME}`;

if (!/n409_e2e|_e2e|_test/.test(DATABASE_URL)) {
  throw new Error(
    `refusing to reset ${DATABASE_URL} — the e2e database name must contain _e2e or _test, ` +
      'so that pointing this at a real database is a typo that fails rather than one that wipes it',
  );
}

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
// Terminate stragglers first: a leftover `tsx watch` from an interrupted run
// keeps its pool open and DROP DATABASE would just fail on it.
await admin.query(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()`,
  [DB_NAME],
);
await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
await admin.query(`CREATE DATABASE ${DB_NAME}`);
await admin.end();

execFileSync('npm', ['run', 'migrate'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL,
    JWT_SECRET: process.env.E2E_JWT_SECRET ?? 'e2e-only-secret-change-me-0123456789abcdef',
  },
});

console.log(`e2e database ${DB_NAME} reset and migrated`);
