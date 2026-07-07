import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

// package-root migrations/ — same depth from src/db/*.ts and dist/db/*.js
const DEFAULT_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 0x6e343039; // 'n409'

/**
 * Minimal forward-only SQL migration runner. Each file runs once, inside a
 * transaction, recorded in schema_migrations; a pg advisory lock serializes
 * concurrent runners (e.g. several service replicas booting at once).
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
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
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
