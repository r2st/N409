import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS tool module, deliberately outside the TS project
import {
  TEST_DB_NAME,
  dropTestDatabases,
  findStaleTestDatabases,
  parseArgs,
} from '../../../../../tools/drop-test-dbs.mjs';

/**
 * The sweeper that collects leaked `n409_test_*` databases.
 *
 * Two properties matter and neither is about the happy path. It runs from the
 * suite's own global setup on a Postgres that other people's suites are using,
 * so a wrong decision here does not leave a mess — it takes down somebody
 * else's test run, or drops a database that was not ours to drop. Both are
 * exercised against a stub client, which is the only way to put the query in a
 * state a real server will not reproduce on demand: a name that should never
 * have come back, a drop that fails halfway, an instance that refuses to stat
 * its own data directory.
 *
 * The end-to-end behaviour — that a real database is created, seen, and
 * dropped — is `test/integration/testDbSweep.test.ts`.
 */

/** A `pg.Client` stand-in that records what it was asked to run. */
function stubClient({
  rows = [],
  failAgeQuery = false,
  failDrops = [],
}: {
  rows?: Array<{ datname: string; created_at: Date | null }>;
  failAgeQuery?: boolean;
  failDrops?: string[];
} = {}) {
  const queries: string[] = [];
  return {
    queries,
    query(sql: string) {
      queries.push(sql);
      if (sql.includes('pg_stat_file')) {
        if (failAgeQuery) return Promise.reject(new Error('permission denied for function pg_stat_file'));
        return Promise.resolve({ rows });
      }
      if (sql.startsWith('\n  SELECT')) {
        return Promise.resolve({ rows: rows.map((r) => ({ ...r, created_at: null })) });
      }
      const dropped = /DROP DATABASE IF EXISTS (\S+)/.exec(sql)?.[1];
      if (dropped && failDrops.includes(dropped)) {
        return Promise.reject(new Error(`database "${dropped}" is being accessed by other users`));
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('findStaleTestDatabases', () => {
  it('selects only what is older than the threshold', async () => {
    const client = stubClient({
      rows: [
        { datname: 'n409_test_aaaaaaaaaaaa', created_at: minutesAgo(120) },
        { datname: 'n409_test_bbbbbbbbbbbb', created_at: minutesAgo(5) },
      ],
    });
    const { stale } = await findStaleTestDatabases(client, { olderThanMinutes: 60 });
    expect(stale.map((s: { name: string }) => s.name)).toEqual(['n409_test_aaaaaaaaaaaa']);
  });

  it('leaves a database created seconds ago alone', async () => {
    // The window this closes: `CREATE DATABASE` has returned but the pool has
    // not connected yet, so the in-use check cannot see it. Age is what covers
    // those few milliseconds, and it is the reason the default threshold is an
    // hour rather than a minute.
    const client = stubClient({
      rows: [{ datname: 'n409_test_cccccccccccc', created_at: new Date() }],
    });
    const { stale } = await findStaleTestDatabases(client, { olderThanMinutes: 60 });
    expect(stale).toEqual([]);
  });

  it('takes every idle database under --all, whatever its age', async () => {
    const client = stubClient({
      rows: [
        { datname: 'n409_test_aaaaaaaaaaaa', created_at: minutesAgo(120) },
        { datname: 'n409_test_bbbbbbbbbbbb', created_at: minutesAgo(1) },
      ],
    });
    const { stale } = await findStaleTestDatabases(client, { olderThanMinutes: 60, all: true });
    expect(stale).toHaveLength(2);
  });

  it('never selects a name that is not a test database', async () => {
    // Defence in depth: the SQL already filters on a LIKE, so anything else
    // arriving here means the query was widened or the rows came from
    // somewhere unexpected. Neither is a reason to interpolate it into a DROP.
    const client = stubClient({
      rows: [
        { datname: 'n409_dev', created_at: minutesAgo(10_000) },
        { datname: 'postgres', created_at: minutesAgo(10_000) },
        { datname: 'n409_test_prod_lookalike', created_at: minutesAgo(10_000) },
        { datname: 'n409_test_dddddddddddd', created_at: minutesAgo(10_000) },
      ],
    });
    const { stale } = await findStaleTestDatabases(client, { olderThanMinutes: 60, all: true });
    expect(stale.map((s: { name: string }) => s.name)).toEqual(['n409_test_dddddddddddd']);
  });

  it('reports ages as unknown rather than failing when it cannot stat the data directory', async () => {
    // A role without pg_read_server_files. The operator should still get the
    // list and the `--all` escape hatch, not an error they cannot act on.
    const client = stubClient({
      rows: [{ datname: 'n409_test_eeeeeeeeeeee', created_at: null }],
      failAgeQuery: true,
    });
    const result = await findStaleTestDatabases(client, { olderThanMinutes: 60 });
    expect(result.agesKnown).toBe(false);
    expect(result.candidates).toHaveLength(1);
    // …and with no age to judge by, nothing is stale on its own account.
    expect(result.stale).toEqual([]);
  });

  it('asks the server to exclude databases that have a backend connected', () => {
    // The guard that makes this safe to run while another suite is mid-flight,
    // and the one property the stub cannot demonstrate by behaviour — it is in
    // the SQL. Asserted on the query text so a rewrite that drops the NOT
    // EXISTS is caught here rather than by somebody's test run vanishing.
    const client = stubClient({ rows: [] });
    return findStaleTestDatabases(client, {}).then(() => {
      expect(client.queries[0]).toMatch(/NOT EXISTS[\s\S]*pg_stat_activity/);
    });
  });
});

describe('dropTestDatabases', () => {
  it('issues one DROP per database', async () => {
    const client = stubClient();
    const result = await dropTestDatabases(client, ['n409_test_aaaaaaaaaaaa', 'n409_test_bbbbbbbbbbbb']);
    expect(result.dropped).toHaveLength(2);
    expect(client.queries).toEqual([
      'DROP DATABASE IF EXISTS n409_test_aaaaaaaaaaaa',
      'DROP DATABASE IF EXISTS n409_test_bbbbbbbbbbbb',
    ]);
  });

  it('does not use FORCE, so a raced database is left for the next sweep', async () => {
    // FORCE terminates the connected backends. If the in-use check raced and
    // somebody is on that database now, FORCE would kill their test run to
    // reclaim 12 MB — the sweep is a courtesy and must never be that.
    const client = stubClient();
    await dropTestDatabases(client, ['n409_test_aaaaaaaaaaaa']);
    expect(client.queries[0]).not.toMatch(/FORCE/i);
  });

  it('keeps going after a failed drop', async () => {
    // Racing another sweeper is the ordinary case, not an exceptional one, and
    // it must not abandon the other three hundred.
    const client = stubClient({ failDrops: ['n409_test_bbbbbbbbbbbb'] });
    const result = await dropTestDatabases(client, [
      'n409_test_aaaaaaaaaaaa',
      'n409_test_bbbbbbbbbbbb',
      'n409_test_cccccccccccc',
    ]);
    expect(result.dropped).toEqual(['n409_test_aaaaaaaaaaaa', 'n409_test_cccccccccccc']);
    expect(result.failed).toEqual([
      { name: 'n409_test_bbbbbbbbbbbb', error: expect.stringContaining('being accessed') },
    ]);
  });

  it('refuses a name that does not match the pattern, whoever passed it', async () => {
    // The name goes into DDL as an identifier — it cannot be a bind parameter.
    // This is the last check before that happens.
    const client = stubClient();
    const result = await dropTestDatabases(client, ['n409_dev', 'n409_test_x; DROP DATABASE n409_dev']);
    expect(result.dropped).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(client.queries).toEqual([]);
  });

  it('runs no DDL at all under --dry-run', async () => {
    const client = stubClient();
    const result = await dropTestDatabases(client, ['n409_test_aaaaaaaaaaaa'], { dryRun: true });
    expect(result.dropped).toEqual(['n409_test_aaaaaaaaaaaa']);
    expect(client.queries).toEqual([]);
  });
});

describe('TEST_DB_NAME', () => {
  it('matches what setupTestDb generates', () => {
    // `n409_test_${randomBytes(6).toString('hex')}` — twelve hex characters.
    expect(TEST_DB_NAME.test('n409_test_67ef46925938')).toBe(true);
  });

  it('rejects everything that is not one', () => {
    for (const name of [
      'n409_dev',
      'postgres',
      'template1',
      'n409_test_', // the prefix alone
      'n409_test_nothex',
      'n409_test_aaaaaaaaaaaa; DROP DATABASE n409_dev',
      'xn409_test_aaaaaaaaaaaa',
      'n409_test_aaaaaaaaaaaa ',
    ]) {
      expect(TEST_DB_NAME.test(name), name).toBe(false);
    }
  });
});

describe('parseArgs', () => {
  it('defaults to an hour and drops nothing extra', () => {
    expect(parseArgs([])).toEqual({ olderThanMinutes: 60, all: false, dryRun: false });
  });

  it('reads the flags', () => {
    expect(parseArgs(['--older-than', '5', '--all', '--dry-run'])).toEqual({
      olderThanMinutes: 5,
      all: true,
      dryRun: true,
    });
  });

  it('accepts zero, which is what --older-than 0 has to mean', () => {
    expect(parseArgs(['--older-than', '0']).olderThanMinutes).toBe(0);
  });

  it('refuses a threshold it cannot make sense of, rather than treating it as zero', () => {
    // `Number('abc')` is NaN and every comparison against it is false, so an
    // unvalidated typo would silently sweep nothing — or, with the comparison
    // the other way round, everything.
    for (const bad of [['--older-than', 'abc'], ['--older-than', '-5'], ['--older-than']]) {
      expect(() => parseArgs(bad)).toThrow(/non-negative/);
    }
  });
});
