import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationDriftError, migrate, migrationChecksum } from '../../src/db/migrate.js';
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

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
    );
    expect(rows[0]?.n).toBe(0);
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
