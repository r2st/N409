#!/usr/bin/env node
/**
 * Drops the throwaway databases the integration suite leaks.
 *
 * `setupTestDb` creates one `n409_test_<hex>` per test file and drops it in
 * `afterAll`. That teardown is correct and runs on every ordinary path — but
 * `afterAll` is the one hook that does not run when a worker is killed, when
 * `beforeAll` throws before returning the context, or when the run is
 * interrupted. Each of those leaves a fully migrated ~12 MB database behind,
 * and nothing has ever collected them: by the time this was written there were
 * 344 of them holding 4.3 GB, the oldest three weeks old. They are invisible
 * until `psql \l` takes a noticeable pause, or the disk fills.
 *
 * Two guards, and the sweep is safe to run at any moment on a shared instance
 * — which it has to be, because it runs from the test suite's own global setup
 * and more than one suite can be running:
 *
 *   1. A database with any backend connected to it is never a candidate. A
 *      suite that is currently using one always has its pool attached.
 *   2. Age. A test database lives for the length of one file; anything older
 *      than the threshold (default one hour) cannot belong to a live run. This
 *      is what makes guard 1 safe against the gap between `CREATE DATABASE`
 *      and the pool's first connection.
 *
 * Postgres does not record when a database was created, so age comes from the
 * mtime of its `PG_VERSION` file — written once, at creation. That needs
 * `pg_read_server_files` (superuser has it); where it is not granted the sweep
 * reports every candidate as age-unknown and refuses to drop any without an
 * explicit `--all`.
 *
 * Usage:
 *   node tools/drop-test-dbs.mjs                 # older than 60 minutes
 *   node tools/drop-test-dbs.mjs --older-than 5  # …than 5 minutes
 *   node tools/drop-test-dbs.mjs --all           # every idle one, any age
 *   node tools/drop-test-dbs.mjs --dry-run       # list, drop nothing
 */
import pg from 'pg';

/**
 * The names this will ever drop.
 *
 * A database name cannot be a bind parameter — `DROP DATABASE` takes an
 * identifier, so the name is interpolated into DDL. Every name here comes from
 * `pg_database` and was matched by a LIKE, so it is already ours; this is the
 * second check, against the day somebody widens the LIKE or passes a name in
 * from somewhere else. Interpolating an unvalidated identifier into a DROP is
 * not a mistake worth leaving one layer of protection against.
 */
export const TEST_DB_NAME = /^n409_test_[0-9a-f]{6,32}$/;

/** Idle `n409_test_*` databases, with the creation time of each. */
const CANDIDATES_WITH_AGE = `
  SELECT d.datname,
         (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification AS created_at
    FROM pg_database d
   WHERE d.datname LIKE 'n409\\_test\\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`;

/** The same, for an instance that will not let us stat the data directory. */
const CANDIDATES_WITHOUT_AGE = `
  SELECT d.datname, NULL::timestamptz AS created_at
    FROM pg_database d
   WHERE d.datname LIKE 'n409\\_test\\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`;

/**
 * Idle test databases and their ages, newest information available.
 *
 * `client` is anything with a `query` method, so this is exercised against a
 * stub as well as against a real server.
 */
export async function findStaleTestDatabases(client, { olderThanMinutes = 60, all = false } = {}) {
  let rows;
  let agesKnown = true;
  try {
    ({ rows } = await client.query(CANDIDATES_WITH_AGE));
  } catch {
    // Almost always insufficient_privilege. Falling back rather than failing:
    // an operator who cannot stat the data directory should still get the list
    // and the `--all` escape hatch, not an error they cannot act on.
    agesKnown = false;
    ({ rows } = await client.query(CANDIDATES_WITHOUT_AGE));
  }

  const cutoff = Date.now() - olderThanMinutes * 60_000;
  const candidates = rows
    .filter((r) => TEST_DB_NAME.test(r.datname))
    .map((r) => ({
      name: r.datname,
      createdAt: r.created_at ? new Date(r.created_at) : null,
    }));

  return {
    agesKnown,
    // `--all` waives the age check but never the in-use check, which is the one
    // that keeps this safe to run while another suite is mid-flight.
    stale: candidates.filter((c) => all || (c.createdAt !== null && c.createdAt.getTime() < cutoff)),
    candidates,
  };
}

/**
 * Drops what `findStaleTestDatabases` selected. Returns what it dropped and
 * what it could not.
 *
 * A failed drop is logged and the sweep continues. The overwhelmingly likely
 * cause is a race with another sweeper or with a suite that connected between
 * the SELECT and the DROP, and neither is a reason to abandon the other 300.
 */
export async function dropTestDatabases(client, names, { dryRun = false, log = () => {} } = {}) {
  const dropped = [];
  const failed = [];
  for (const name of names) {
    if (!TEST_DB_NAME.test(name)) {
      failed.push({ name, error: 'name does not match the test-database pattern' });
      continue;
    }
    if (dryRun) {
      dropped.push(name);
      continue;
    }
    try {
      // No FORCE: an unexpectedly live backend means the in-use check raced,
      // and the right answer there is to leave the database alone and let the
      // next sweep take it, not to terminate somebody's test run.
      await client.query(`DROP DATABASE IF EXISTS ${name}`);
      dropped.push(name);
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) });
      log(`  could not drop ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { dropped, failed };
}

/**
 * Connect, sweep, disconnect. The entry point for both the CLI and the test
 * suite's global setup.
 *
 * Never throws: a sweep is a courtesy, and a Postgres that is not up (or an
 * instance that refuses the connection) must not be the reason a test run
 * fails before it starts.
 */
export async function sweepStaleTestDatabases({
  connectionString = process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://n409:n409_dev@localhost:5432/n409_dev',
  olderThanMinutes = 60,
  all = false,
  dryRun = false,
  log = () => {},
} = {}) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch {
    return { dropped: [], failed: [], skipped: 'no database' };
  }
  try {
    const { stale, candidates, agesKnown } = await findStaleTestDatabases(client, {
      olderThanMinutes,
      all,
    });
    if (!agesKnown && !all) {
      log(
        `${candidates.length} idle test database(s) found, but this role cannot read their ` +
          'creation times (pg_read_server_files). Re-run with --all to drop them anyway.',
      );
      return { dropped: [], failed: [], skipped: 'ages unknown' };
    }
    if (stale.length === 0) return { dropped: [], failed: [] };

    log(
      `${dryRun ? 'Would drop' : 'Dropping'} ${stale.length} leaked test database(s)` +
        `${all ? '' : ` older than ${olderThanMinutes}m`}` +
        ` (${candidates.length - stale.length} left alone).`,
    );
    return await dropTestDatabases(
      client,
      stale.map((s) => s.name),
      { dryRun, log },
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/** `--older-than 5`, `--all`, `--dry-run`. */
export function parseArgs(argv) {
  const olderThanIndex = argv.indexOf('--older-than');
  // Absent is the default; present is whatever follows, including nothing —
  // `--older-than` with its value forgotten must not quietly mean 60, since the
  // whole point of typing it was to mean something else.
  const raw = olderThanIndex === -1 ? undefined : argv[olderThanIndex + 1];
  const minutes = olderThanIndex === -1 ? 60 : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`--older-than takes a non-negative number of minutes, got ${String(raw)}`);
  }
  return { olderThanMinutes: minutes, all: argv.includes('--all'), dryRun: argv.includes('--dry-run') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const result = await sweepStaleTestDatabases({ ...options, log: (m) => console.log(m) });
  if (result.skipped === 'no database') {
    console.log('No database reachable — nothing to sweep.');
  } else if (result.dropped.length === 0 && !result.skipped) {
    console.log('No leaked test databases.');
  } else if (result.dropped.length > 0) {
    console.log(`${options.dryRun ? 'Would have dropped' : 'Dropped'} ${result.dropped.length}.`);
  }
  if (result.failed.length > 0) process.exitCode = 1;
}
