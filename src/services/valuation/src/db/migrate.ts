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

/**
 * How long a runner waits for the migration lock before giving up.
 *
 * `pg_advisory_lock` blocks with no bound and no output. That reads as the safe
 * default and is the opposite of one here, because of where this call sits:
 * `migrate` is awaited in `index.ts` *before* `app.listen`, so a runner that
 * cannot get the lock never binds its port, never answers `/health` or
 * `/ready`, and never logs a word about why. systemd waits out its start
 * timeout and kills it; `deploy.sh` waits on the unit and reads as a hung
 * deploy. Every one of those symptoms points somewhere other than "another
 * process is holding the lock", which is the actual state.
 *
 * Sixty seconds is well past any migration this repository contains (the whole
 * set applies to an empty database in a couple of seconds) and well inside
 * systemd's 90s default, so the runner fails on its own terms with an error
 * naming the holder.
 */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;

/** How often the lock is re-tried while waiting. */
export const MIGRATION_LOCK_POLL_MS = 250;

/** Raised when the migration lock could not be taken inside its deadline. */
export class MigrationLockTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly holders: readonly number[],
  ) {
    super(
      `Could not acquire the migration advisory lock within ${timeoutMs}ms` +
        (holders.length > 0
          ? ` — held by backend pid ${holders.join(', ')}. ` +
            'That is another replica still migrating, or a session that took the lock by hand; ' +
            'check `SELECT * FROM pg_stat_activity WHERE pid = ANY(...)` before terminating it.'
          : ' — no holder is visible in pg_locks, which means it was released and re-taken ' +
            'repeatedly while this runner waited (several replicas booting at once).'),
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

/** Raised when a pending migration file has no statements to run. */
export class EmptyMigrationError extends Error {
  constructor(readonly file: string) {
    super(
      `Migration ${file} contains no SQL statements. ` +
        'A file created and left unwritten would be recorded as applied and, because migrations are ' +
        'forward-only and checksummed, could never be filled in — the only repair is deleting its ' +
        'schema_migrations row by hand on every environment. Write the migration or remove the file.',
    );
    this.name = 'EmptyMigrationError';
  }
}

/**
 * True when a migration file has nothing for Postgres to do.
 *
 * Comments and whitespace only — `--` to end of line and `/* ... *\/` blocks —
 * is the shape of a file somebody created from the template and never filled
 * in. Stripping is deliberately naive about string literals: a migration whose
 * *entire* content is one string literal is not a thing, and the check only has
 * to distinguish "empty" from "not empty".
 */
export function isEmptyMigration(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/;/g, ' ');
  return stripped.trim().length === 0;
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

/** Anything that can run a query — a Pool, a PoolClient, or a Client. */
type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Backend pids holding *this database's* migration advisory lock, best-effort.
 *
 * Every filter in the predicate is load-bearing, and the one that is easy to
 * omit is `database`. `pg_locks` is a cluster-wide view, while an advisory lock
 * is per-database — two databases on one server can hold LOCK_KEY at the same
 * moment, quite correctly, because they are migrating separate schemas. A query
 * without the database filter answers "is anyone anywhere holding this key",
 * which is not a question anybody here is asking: it turns a boot-log line into
 * a pid an operator can go and kill in the wrong database.
 *
 * Exported because the test suite has to ask this same question, and asking it
 * in its own words is how it drifted: see `migrationRunner.test.ts`.
 */
export async function migrationLockHolders(db: Queryable): Promise<number[]> {
  try {
    // `pg_advisory_lock(bigint)` splits its key across classid/objid: the high
    // 32 bits and the low 32. LOCK_KEY fits in 32 bits, so classid is 0.
    const { rows } = await db.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [LOCK_KEY],
    );
    return rows.map((r) => r.pid);
  } catch {
    // Diagnostics must never be the thing that fails the boot.
    return [];
  }
}

/**
 * Takes the migration lock, or gives up saying who has it.
 *
 * `pg_try_advisory_lock` in a poll rather than `pg_advisory_lock` with a
 * `lock_timeout`: the point is not only the deadline but the line in the log
 * while the wait is happening. Several replicas booting together is the normal
 * case, and "waiting for another replica to finish migrating" is a different
 * operational fact from "starting slowly" — one resolves itself and the other
 * does not.
 */
async function acquireMigrationLock(
  client: pg.PoolClient,
  opts: { timeoutMs: number; pollMs: number; log: (msg: string) => void; now?: () => number },
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  // A zero or negative bound means one attempt and no waiting, which is what a
  // test asserting contention wants and what nothing in production sets.
  const deadline = startedAt + Math.max(0, opts.timeoutMs);
  let announced = false;

  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      LOCK_KEY,
    ]);
    if (rows[0]?.locked) {
      if (announced) opts.log(`acquired the migration lock after ${now() - startedAt}ms`);
      return;
    }
    if (now() >= deadline) {
      throw new MigrationLockTimeoutError(opts.timeoutMs, await migrationLockHolders(client));
    }
    if (!announced) {
      announced = true;
      const holders = await migrationLockHolders(client);
      opts.log(
        `waiting for the migration lock (held by pid ${holders.join(', ') || 'unknown'}); ` +
          `giving up after ${opts.timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * Minimal forward-only SQL migration runner. Each file runs once, inside a
 * transaction, recorded in schema_migrations; a pg advisory lock serializes
 * concurrent runners (e.g. several service replicas booting at once), taken
 * under a deadline so a runner that cannot get it fails loudly rather than
 * hanging the boot — see {@link DEFAULT_MIGRATION_LOCK_TIMEOUT_MS}.
 *
 * A pending file with no statements in it is refused before it is applied
 * ({@link EmptyMigrationError}): recording an empty file as applied is the one
 * mistake this runner's own guarantees make unrepairable, because forward-only
 * plus checksums means the file can never be filled in afterwards.
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
  opts: {
    dir?: string;
    log?: (msg: string) => void;
    /** Cap on the wait for the advisory lock. See
     *  {@link DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} for why there is one at all. */
    lockTimeoutMs?: number;
    /** Poll interval while waiting; injected by the contention tests. */
    lockPollMs?: number;
  } = {},
): Promise<string[]> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const log = opts.log ?? (() => {});
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await acquireMigrationLock(client, {
      timeoutMs: opts.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
      pollMs: opts.lockPollMs ?? MIGRATION_LOCK_POLL_MS,
      log,
    });
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

      // Checked here rather than over the whole directory, so an empty file
      // that has *already* been applied on some environment stays a drift
      // question and not a second, unfixable boot failure.
      if (isEmptyMigration(sql)) throw new EmptyMigrationError(file);

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
