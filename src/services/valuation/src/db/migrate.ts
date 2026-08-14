import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

// package-root migrations/ — same depth from src/db/*.ts and dist/db/*.js
const DEFAULT_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 0x6e343039; // 'n409'

/** Content hash recorded alongside an applied migration. */
export function migrationChecksum(sql: string): string {
  // Normalise line endings so a checkout with different git autocrlf settings
  // doesn't read as an edit. Nothing else is normalised: whitespace inside a
  // statement is exactly the kind of change that is worth noticing.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Raised when an already-applied migration file no longer matches what ran. */
export class MigrationDriftError extends Error {
  constructor(
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Migration ${file} has changed since it was applied ` +
        `(recorded sha256 ${expected.slice(0, 12)}, file is ${actual.slice(0, 12)}). ` +
        'Migrations are forward-only: add a new file instead of editing an applied one.',
    );
    this.name = 'MigrationDriftError';
  }
}

/**
 * Minimal forward-only SQL migration runner. Each file runs once, inside a
 * transaction, recorded in schema_migrations; a pg advisory lock serializes
 * concurrent runners (e.g. several service replicas booting at once).
 *
 * Each applied file's sha256 is recorded too, and re-checked on every boot.
 * Only the filename used to be, which made the one mistake this runner cannot
 * recover from completely invisible: editing a migration that has already run.
 * The edit is skipped on every environment that applied the old text and
 * applied in full on every environment that hasn't, so staging and production
 * silently diverge — and the schema each one actually has stops being a
 * function of the repository. Boot fails loudly instead.
 *
 * The column is backfilled rather than required: databases migrated before
 * checksums existed have rows with no hash, and refusing to boot on those would
 * turn a safety net into an outage. A null is filled in from the current file
 * on the next run and enforced from then on.
 */
export async function migrate(
  pool: pg.Pool,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<string[]> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const log = opts.log ?? (() => {});
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    // Not a numbered migration: this table is the runner's own bookkeeping and
    // has to exist before any numbered file can run.
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    const { rows } = await client.query<{ name: string; checksum: string | null }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = migrationChecksum(sql);

      if (done.has(file)) {
        const recorded = done.get(file) ?? null;
        if (recorded === null) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [file, checksum]);
        } else if (recorded !== checksum) {
          throw new MigrationDriftError(file, recorded, checksum);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : err}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
