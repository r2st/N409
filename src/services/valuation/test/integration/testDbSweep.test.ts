import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isDbAvailable } from './helpers.js';
// @ts-expect-error — plain-JS tool module, deliberately outside the TS project
import { findStaleTestDatabases, sweepStaleTestDatabases } from '../../../../../tools/drop-test-dbs.mjs';

const dbUp = await isDbAvailable();

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://n409:n409_dev@localhost:5432/n409_dev';

/**
 * The sweeper, against a real server.
 *
 * `dropTestDbs.test.ts` covers the decisions with a stub. What a stub cannot
 * check is whether the two SQL predicates mean on Postgres what they are meant
 * to mean — and those are the whole safety argument. This suite runs from the
 * same global setup the sweeper does, on the same instance other agents' suites
 * use, so "does the in-use guard actually work" is not a question to leave to a
 * unit test's idea of a query result.
 *
 * A real leaked database is created for each case: `CREATE DATABASE` and no
 * migration, which is what a run that died in `beforeAll` leaves behind.
 */
describe.skipIf(!dbUp)('the leaked-test-database sweep', () => {
  const created: string[] = [];

  /** A database shaped exactly like the ones the suite leaks. */
  const leak = async (): Promise<string> => {
    const name = `n409_test_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    created.push(name);
    return name;
  };

  const exists = async (name: string): Promise<boolean> => {
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    try {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      return rows.length === 1;
    } finally {
      await admin.end();
    }
  };

  const urlFor = (name: string): string => {
    const url = new URL(BASE_URL);
    url.pathname = `/${name}`;
    return url.toString();
  };

  afterEach(async () => {
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    for (const name of created.splice(0)) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    }
    await admin.end();
  });

  it('drops a leaked database', async () => {
    const name = await leak();
    // Threshold 0: everything idle is old enough, which is the state the real
    // sweep reaches an hour later.
    await sweepStaleTestDatabases({ connectionString: BASE_URL, olderThanMinutes: 0 });
    expect(await exists(name)).toBe(false);
  });

  it('leaves a database alone while something is connected to it', async () => {
    /*
     * The guard that matters. Another agent's suite is a pool attached to a
     * database that is minutes old — under a threshold of 0 the age check
     * cannot save it, so this is the in-use predicate on its own, and if it
     * does not hold on the real server the sweep deletes live test runs.
     */
    const name = await leak();
    const holder = new pg.Client({ connectionString: urlFor(name) });
    await holder.connect();
    try {
      await sweepStaleTestDatabases({ connectionString: BASE_URL, olderThanMinutes: 0 });
      expect(await exists(name)).toBe(true);
    } finally {
      await holder.end();
    }

    // …and once the connection goes, the next sweep collects it.
    await sweepStaleTestDatabases({ connectionString: BASE_URL, olderThanMinutes: 0 });
    expect(await exists(name)).toBe(false);
  });

  it('leaves a freshly created database alone at the default threshold', async () => {
    // The age half, which covers the window between `CREATE DATABASE` and the
    // pool's first connection — during which the in-use check sees nothing.
    const name = await leak();
    await sweepStaleTestDatabases({ connectionString: BASE_URL, olderThanMinutes: 60 });
    expect(await exists(name)).toBe(true);
  });

  it('reads a real creation time, not a null it would then ignore', async () => {
    // The age filter is only as good as `pg_stat_file` on this instance. If it
    // returned null here every database would be permanently unsweepable and
    // the previous test would still pass, for the wrong reason.
    const name = await leak();
    const client = new pg.Client({ connectionString: BASE_URL });
    await client.connect();
    try {
      const { candidates, agesKnown } = await findStaleTestDatabases(client, { all: true });
      const mine = candidates.find((c: { name: string }) => c.name === name);
      expect(agesKnown).toBe(true);
      expect(mine?.createdAt).toBeInstanceOf(Date);
      expect(Date.now() - (mine!.createdAt as Date).getTime()).toBeLessThan(120_000);
    } finally {
      await client.end();
    }
  });

  it('never touches a database that is not a test database', async () => {
    // The development database is on this same server, one LIKE pattern away.
    const name = await leak();
    await sweepStaleTestDatabases({ connectionString: BASE_URL, olderThanMinutes: 0, all: true });
    expect(await exists(name)).toBe(false);
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    const { rows } = await admin.query(
      "SELECT datname FROM pg_database WHERE datname IN ('postgres', 'template1')",
    );
    await admin.end();
    expect(rows).toHaveLength(2);
  });

  it('does not fail the run when there is no database to sweep', async () => {
    // It runs from global setup, before anything has decided whether this is an
    // integration run at all. A unit-only run on a machine with no Postgres
    // must not be stopped by it.
    const result = await sweepStaleTestDatabases({
      connectionString: 'postgres://nobody@127.0.0.1:1/nothing',
    });
    expect(result).toMatchObject({ dropped: [], skipped: 'no database' });
  });
});
