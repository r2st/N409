import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EmptyMigrationError,
  MigrationDriftError,
  MigrationLockTimeoutError,
  isEmptyMigration,
  migrate,
  migrationChecksum,
  migrationLockHolders,
} from '../../src/db/migrate.js';
import { buildPoolConfig, resolvePoolTuning } from '../../src/db/pool.js';
import { isDbAvailable } from './helpers.js';

const dbUp = await isDbAvailable();

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://n409:n409_dev@localhost:5432/n409_dev';

/**
 * The runner's own guarantees, against a real database and a throwaway
 * migrations directory — so the assertions are about the runner rather than
 * about whichever numbered file happens to be last this week.
 *
 * The one that matters in production is drift: editing a file that has already
 * been applied is skipped on every database that ran the old text and applied
 * in full on every database that hasn't, so environments diverge with nothing
 * in the logs. That has to fail the boot.
 */
describe.skipIf(!dbUp)('migration runner', () => {
  let dir: string;
  let dbName: string;
  let pool: pg.Pool;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'n409-mig-'));
    dbName = `n409_migrunner_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(BASE_URL);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    pool.on('error', () => {});
  });

  afterEach(async () => {
    await pool.end().catch(() => {});
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql: string) => writeFile(path.join(dir, name), sql, 'utf8');

  it('applies files in filename order and records each one', async () => {
    await write('0002_second.sql', 'CREATE TABLE second (id int);');
    await write('0001_first.sql', 'CREATE TABLE first (id int);');

    expect(await migrate(pool, { dir })).toEqual(['0001_first.sql', '0002_second.sql']);

    const { rows } = await pool.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((r) => r.name)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
  });

  it('applies nothing on a second run', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await migrate(pool, { dir });
    expect(await migrate(pool, { dir })).toEqual([]);
  });

  it('applies only the new file when one is added', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await migrate(pool, { dir });
    await write('0002_second.sql', 'CREATE TABLE second (id int);');
    expect(await migrate(pool, { dir })).toEqual(['0002_second.sql']);
  });

  it('refuses to boot when an applied migration was edited', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await migrate(pool, { dir });

    await write('0001_first.sql', 'CREATE TABLE first (id bigint);');
    await expect(migrate(pool, { dir })).rejects.toThrow(MigrationDriftError);
    await expect(migrate(pool, { dir })).rejects.toThrow(/forward-only/);
  });

  it('does not apply later migrations once drift is detected', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await migrate(pool, { dir });

    await write('0001_first.sql', '-- edited\nCREATE TABLE first (id int);');
    await write('0002_second.sql', 'CREATE TABLE second (id int);');
    await expect(migrate(pool, { dir })).rejects.toThrow(MigrationDriftError);

    const { rows } = await pool.query("SELECT to_regclass('public.second') AS t");
    expect(rows[0]?.t).toBeNull();
  });

  it('backfills a checksum recorded before checksums existed, then enforces it', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await migrate(pool, { dir });
    // A row as an older runner left it.
    await pool.query('UPDATE schema_migrations SET checksum = NULL');

    expect(await migrate(pool, { dir })).toEqual([]);
    const { rows } = await pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations');
    expect(rows[0]?.checksum).toBe(migrationChecksum('CREATE TABLE first (id int);'));

    await write('0001_first.sql', 'CREATE TABLE first (id bigint);');
    await expect(migrate(pool, { dir })).rejects.toThrow(MigrationDriftError);
  });

  it('rolls back a failing migration and leaves it unrecorded', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int); INSERT INTO nope VALUES (1);');
    await expect(migrate(pool, { dir })).rejects.toThrow(/Migration 0001_first\.sql failed/);

    const { rows } = await pool.query("SELECT to_regclass('public.first') AS t");
    expect(rows[0]?.t).toBeNull();
    const recorded = await pool.query('SELECT name FROM schema_migrations');
    expect(recorded.rows).toEqual([]);
  });

  it('releases the advisory lock when a migration fails', async () => {
    await write('0001_first.sql', 'INSERT INTO nope VALUES (1);');
    await expect(migrate(pool, { dir })).rejects.toThrow();

    expect(await migrationLockHolders(pool)).toEqual([]);
  });

  /**
   * The scoping the assertion above depends on, asserted rather than assumed.
   *
   * This used to read `count(*) FROM pg_locks WHERE locktype = 'advisory'` — no
   * key filter and, the part that bit, no database filter. `pg_locks` is
   * cluster-wide and an advisory lock is per-database, so the count included
   * every other database on the same server. Each file in this suite migrates
   * its own throwaway database and they run in parallel, so the test failed
   * whenever a sibling happened to be inside `migrate()` at that instant: a red
   * run that said "the runner leaked its lock" when the runner had done nothing
   * wrong. Passing it in isolation is what kept it alive.
   *
   * So the leak check now goes through `migrationLockHolders` — the same
   * predicate the boot log names a pid from — and this test holds LOCK_KEY from
   * a second database in the same cluster to prove that predicate cannot see
   * it. Without the `database` filter this fails; with it, the flake cannot
   * come back in either file.
   */
  it('does not see the same key held in another database of the same cluster', async () => {
    const otherName = `n409_migrunner_other_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${otherName}`);
    await admin.end();

    const otherUrl = new URL(BASE_URL);
    otherUrl.pathname = `/${otherName}`;
    const other = new pg.Client({ connectionString: otherUrl.toString() });
    try {
      await other.connect();
      // The key `migrate` takes, held from a database this pool is not on.
      await other.query('SELECT pg_advisory_lock($1)', [0x6e343039]);

      // Visible cluster-wide — otherwise the rest of this proves nothing.
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted",
        [0x6e343039],
      );
      expect(rows[0]?.n).toBeGreaterThan(0);

      // …and invisible to the predicate, which is the point.
      expect(await migrationLockHolders(pool)).toEqual([]);
    } finally {
      await other.end().catch(() => {});
      const drop = new pg.Client({ connectionString: BASE_URL });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${otherName} WITH (FORCE)`);
      await drop.end();
    }
  });

  it('serializes concurrent runners so a file is applied exactly once', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await write('0002_second.sql', 'CREATE TABLE second (id int);');

    // Two replicas booting together. Without the advisory lock one of them
    // sees an empty schema_migrations and re-runs a CREATE TABLE that the
    // other has already committed.
    const results = await Promise.all([migrate(pool, { dir }), migrate(pool, { dir })]);
    expect(results.flat().sort()).toEqual(['0001_first.sql', '0002_second.sql']);

    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows[0]?.n).toBe(2);
  });

  it('ignores non-.sql files in the directory', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await write('README.md', 'not a migration');
    await write('0002_second.sql.bak', 'CREATE TABLE nope (id int);');
    expect(await migrate(pool, { dir })).toEqual(['0001_first.sql']);
  });
});

/**
 * The real migrations/ directory, end to end, on an empty database — the exact
 * thing a first production boot does. Every other integration suite migrates a
 * fresh database too, but each of those fails for a hundred reasons other than
 * the schema; this one only fails for the schema.
 */
describe.skipIf(!dbUp)('the shipped migration set', () => {
  it('applies cleanly to an empty database and is a no-op on the second run', async () => {
    const dbName = `n409_migset_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const url = new URL(BASE_URL);
    url.pathname = `/${dbName}`;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    pool.on('error', () => {});
    try {
      const applied = await migrate(pool);
      expect(applied.length).toBeGreaterThan(100);
      expect(applied).toEqual([...applied].sort());
      expect(await migrate(pool)).toEqual([]);

      // The tables the service cannot start without.
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['users', 'partners', 'valuations', 'roles', 'user_roles', 'schema_migrations']],
      );
      expect(rows.map((r) => r.table_name).sort()).toEqual([
        'partners',
        'roles',
        'schema_migrations',
        'user_roles',
        'users',
        'valuations',
      ]);
    } finally {
      await pool.end().catch(() => {});
      const drop = new pg.Client({ connectionString: BASE_URL });
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await drop.end();
    }
  }, 120_000);
});

describe('isEmptyMigration', () => {
  it('accepts a file with a statement in it', () => {
    expect(isEmptyMigration('CREATE TABLE t (id int);')).toBe(false);
    expect(isEmptyMigration('-- adds t\nCREATE TABLE t (id int);')).toBe(false);
  });

  it('rejects a file that is blank, or only comments', () => {
    expect(isEmptyMigration('')).toBe(true);
    expect(isEmptyMigration('   \n\t \n')).toBe(true);
    expect(isEmptyMigration('-- 0164: add the thing\n-- TODO\n')).toBe(true);
    expect(isEmptyMigration('/* written next sprint */')).toBe(true);
    expect(isEmptyMigration('/* multi\n   line */\n-- and a line comment\n;\n')).toBe(true);
  });
});

describe.skipIf(!dbUp)('migration lock and pre-apply validation', () => {
  let dir: string;
  let dbName: string;
  let pool: pg.Pool;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'n409-miglock-'));
    dbName = `n409_miglock_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(BASE_URL);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    pool.on('error', () => {});
  });

  afterEach(async () => {
    await pool.end().catch(() => {});
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql: string) => writeFile(path.join(dir, name), sql, 'utf8');

  /**
   * The failure this bound exists for. `migrate` is awaited before
   * `app.listen`, so a runner blocked on the lock binds no port, answers no
   * health check and says nothing — systemd kills it on its start timeout and
   * the deploy reads as hung.
   */
  it('gives up on a lock another session holds, naming the holder', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [0x6e343039]);
    try {
      const err = await migrate(pool, { dir, lockTimeoutMs: 150, lockPollMs: 25 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationLockTimeoutError);
      const timeout = err as MigrationLockTimeoutError;
      expect(timeout.timeoutMs).toBe(150);
      // The pid is the actionable half: it names the session to look at.
      expect(timeout.holders.length).toBeGreaterThan(0);
      expect(timeout.message).toContain('backend pid');
      // Nothing was applied — the lock is what guards the whole run.
      const { rows } = await pool.query("SELECT to_regclass('first') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [0x6e343039]);
      holder.release();
    }
  });

  it('logs that it is waiting, then proceeds once the lock is released', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [0x6e343039]);

    const lines: string[] = [];
    const run = migrate(pool, {
      dir,
      lockTimeoutMs: 10_000,
      lockPollMs: 20,
      log: (m) => lines.push(m),
    });
    // Long enough for at least one failed attempt and the waiting line.
    await new Promise((r) => setTimeout(r, 120));
    expect(lines.some((l) => l.startsWith('waiting for the migration lock'))).toBe(true);

    await holder.query('SELECT pg_advisory_unlock($1)', [0x6e343039]);
    holder.release();

    expect(await run).toEqual(['0001_first.sql']);
    expect(lines.some((l) => l.startsWith('acquired the migration lock after'))).toBe(true);
  });

  it('says nothing about the lock when it is free', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    const lines: string[] = [];
    await migrate(pool, { dir, log: (m) => lines.push(m) });
    expect(lines).toEqual(['applied 0001_first.sql']);
  });

  /**
   * Forward-only plus checksums means an empty file recorded as applied can
   * never be filled in — the only repair is deleting its schema_migrations row
   * by hand on every environment. So it is refused before it is recorded.
   */
  it('refuses an empty migration file rather than recording it as applied', async () => {
    await write('0001_first.sql', 'CREATE TABLE first (id int);');
    await write('0002_placeholder.sql', '-- 0002: the thing, next sprint\n');
    await write('0003_third.sql', 'CREATE TABLE third (id int);');

    const err = await migrate(pool, { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyMigrationError);
    expect((err as EmptyMigrationError).file).toBe('0002_placeholder.sql');

    // The file before it stands; the empty one and everything after it did not run.
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['0001_first.sql']);
    const { rows: tables } = await pool.query("SELECT to_regclass('third') AS t");
    expect(tables[0].t).toBeNull();
  });

  it('releases the advisory lock when an empty migration is refused', async () => {
    await write('0001_empty.sql', '/* nothing yet */');
    await expect(migrate(pool, { dir })).rejects.toBeInstanceOf(EmptyMigrationError);

    // A second runner must be able to take the lock immediately.
    await rm(path.join(dir, '0001_empty.sql'));
    await write('0001_real.sql', 'CREATE TABLE real_one (id int);');
    expect(await migrate(pool, { dir, lockTimeoutMs: 500, lockPollMs: 25 })).toEqual(['0001_real.sql']);
  });
  /**
   * The session bounds a migration runs under.
   *
   * The runner takes its client from the application pool, and the pool is
   * tuned for request handlers: `statement_timeout` 15s, `lock_timeout` unset
   * and therefore 0. Both are wrong for DDL, in opposite directions, and both
   * failures are invisible until an environment has enough data to expose them
   * — which is never CI.
   *
   * The pools built here set a deliberately tiny `statement_timeout`, so the
   * override can be proved with a one-second statement instead of a real index
   * build.
   */
  describe('migration session timeouts', () => {
    /** A pool configured the way the service configures its own. */
    const appPool = (overrides: Partial<pg.PoolConfig> = {}): pg.Pool => {
      const url = new URL(BASE_URL);
      url.pathname = `/${dbName}`;
      const target = url.toString();
      const config = buildPoolConfig(target, resolvePoolTuning(target, { DB_SSL: 'disable' }));
      const p = new pg.Pool({ ...config, max: 3, ...overrides });
      p.on('error', () => {});
      return p;
    };

    it('runs a migration under its own statement ceiling, not the pool request one', async () => {
      const tiny = appPool({ statement_timeout: 300 });
      try {
        // Would be cancelled at 300ms by the pool's own setting.
        await write('0001_slow.sql', 'CREATE TABLE slow (id int); SELECT pg_sleep(1);');
        expect(await migrate(tiny, { dir, statementTimeoutMs: 20_000 })).toEqual(['0001_slow.sql']);

        const { rows } = await tiny.query("SELECT to_regclass('slow') AS t");
        expect(rows[0].t).not.toBeNull();
      } finally {
        await tiny.end().catch(() => {});
      }
    });

    /**
     * The reason it is `SET LOCAL` and not `SET`.
     *
     * pg runs no DISCARD when a client goes back to the pool, so a plain SET
     * would hand the next request handler a connection with the migration's
     * five-minute ceiling on it — silently removing the bound that stops one
     * runaway query pinning a connection. The leak would never fail a test
     * about migrations; it would surface much later as a service that stopped
     * timing anything out.
     */
    it('does not leak its raised ceiling back onto the pooled connection', async () => {
      const tiny = appPool({ statement_timeout: 300 });
      try {
        await write('0001_first.sql', 'CREATE TABLE first (id int);');
        await migrate(tiny, { dir, statementTimeoutMs: 300_000, ddlLockTimeoutMs: 3000 });

        // Every client in the pool, since the runner only borrowed one of them
        // and the next request may get any.
        for (let i = 0; i < 3; i += 1) {
          const client = await tiny.connect();
          const { rows } = await client.query<{ st: string; lt: string }>(
            "SELECT current_setting('statement_timeout') st, current_setting('lock_timeout') lt",
          );
          expect(rows[0]).toEqual({ st: '300ms', lt: '0' });
          client.release();
        }
      } finally {
        await tiny.end().catch(() => {});
      }
    });

    /**
     * The half that protects everyone *else*.
     *
     * Postgres's lock queue is ordered, so an ALTER TABLE waiting for ACCESS
     * EXCLUSIVE sits in front of every request that arrives after it — and
     * ordinary reads of that table stop until it is resolved. With the default
     * `lock_timeout` of 0 that wait was bounded only by `statement_timeout`,
     * so a deploy landing during one long-running reader took the table down
     * for fifteen seconds and then failed the migration anyway.
     */
    it('gives up on a contended table lock instead of blocking the queue behind it', async () => {
      const url = new URL(BASE_URL);
      url.pathname = `/${dbName}`;
      await write('0001_first.sql', 'CREATE TABLE first (id int);');
      await migrate(pool, { dir });

      // A reader holding an ordinary open transaction on the table.
      const reader = new pg.Client({ connectionString: url.toString() });
      await reader.connect();
      await reader.query('BEGIN');
      await reader.query('SELECT * FROM first');

      try {
        await write('0002_alter.sql', 'ALTER TABLE first ADD COLUMN added int;');
        const startedAt = Date.now();
        const err = await migrate(pool, { dir, ddlLockTimeoutMs: 400 }).catch((e: unknown) => e);
        const waitedMs = Date.now() - startedAt;

        expect(err).toBeInstanceOf(Error);
        // Bounded by the lock timeout, nowhere near the 15s the pool allows.
        expect(waitedMs).toBeLessThan(5000);
        // And it says which of the two cancellations this was, because the
        // operational conclusions are opposites.
        expect((err as Error).message).toContain('waited 400ms for a table lock');
        expect((err as Error).message).toContain('was not applied');

        // Nothing was recorded, so the retry the unit performs is a clean one.
        const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
        expect(rows.map((r) => r.name)).toEqual(['0001_first.sql']);
      } finally {
        await reader.query('ROLLBACK').catch(() => {});
        await reader.end().catch(() => {});
      }
    });

    it('applies the migration once the lock holder goes away', async () => {
      // The point of failing fast rather than waiting: the unit is
      // Restart=always, so this is what the next boot does.
      await write('0001_first.sql', 'CREATE TABLE first (id int);');
      await write('0002_alter.sql', 'ALTER TABLE first ADD COLUMN added int;');
      expect(await migrate(pool, { dir, ddlLockTimeoutMs: 400 })).toEqual([
        '0001_first.sql',
        '0002_alter.sql',
      ]);
    });
  });
});
