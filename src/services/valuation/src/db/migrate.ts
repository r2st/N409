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

/**
 * How long a migration statement waits for a *table* lock before giving up.
 *
 * A different lock from the advisory one above, and the distinction is the
 * whole point. {@link DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} bounds the wait for
 * the right to migrate at all; this bounds each statement's wait for the
 * relation it is about to alter — and until now nothing bounded it, because
 * `lock_timeout` is `0` (unbounded) by default and the pool never set one.
 *
 * Unbounded is the dangerous setting, not the patient one, because of what a
 * blocked `ALTER TABLE` does to everything behind it. Postgres's lock queue is
 * ordered: a statement waiting for ACCESS EXCLUSIVE sits ahead of every request
 * that arrives after it, so while the migration waits on one long-running
 * reader, *ordinary traffic to that table stops too* — including plain SELECTs
 * that conflict with nothing. Measured on a real database (a reader holding one
 * open transaction, an `ALTER TABLE ADD COLUMN` behind it): an unrelated
 * `SELECT count(*)` issued afterwards was still blocked six seconds later, and
 * would have stayed blocked for the full statement timeout.
 *
 * So the deploy did not merely stall — it took the table down for the length of
 * the stall and then failed anyway. Three seconds is chosen to be shorter than
 * anyone would notice as an outage and longer than any lock this schema
 * actually contends for. Failing is the right outcome: the unit is
 * `Restart=always` with `RestartSec=3`, so a migration that loses this race is
 * retried in seconds and succeeds once the blocker clears, which is precisely
 * the behaviour "wait forever" was pretending to provide.
 */
export const DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS = 3_000;

/**
 * How long one migration statement may run once it holds its locks.
 *
 * This one has to go *up*, and it is the half that was actively broken. The
 * runner borrows a client from the application pool, and `buildPoolConfig` sets
 * `statement_timeout` to 15s — a good ceiling for a request handler and far too
 * low for DDL. There are 164 `CREATE INDEX` statements in this directory and
 * none of them can be CONCURRENTLY (see the note in 0148: the runner wraps each
 * file in a transaction and Postgres forbids it there), so each one builds
 * under a lock, in one statement, for as long as the table takes.
 *
 * The failure that produces is the worst shape available: it is a function of
 * how much data an environment has. An index build over an empty CI database
 * finishes in milliseconds and the pipeline is green; the same file against a
 * production table crosses 15s, Postgres cancels it (`57014`), the transaction
 * rolls back, and `migrate()` throws before `app.listen` — so valuation never
 * binds its port, never answers `/health`, and `deploy.sh` reads it as a hung
 * deploy. Restarting cannot help, because the next attempt is equally slow.
 *
 * Five minutes is not a target, it is a backstop: it exists so that a migration
 * is bounded by something, while being far enough above any real build that
 * hitting it means a genuinely stuck statement rather than a large table.
 */
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 300_000;

/** The two session bounds a migration runs under. */
export interface MigrationTimeouts {
  /** Per-statement wait for a table lock (ms). */
  ddlLockTimeoutMs: number;
  /** Per-statement execution ceiling (ms). */
  statementTimeoutMs: number;
}

/**
 * Resolves the migration session bounds from env, with the defaults above.
 *
 * Pure and exported for the same reason `resolvePoolTuning` is: the interesting
 * cases are all about a malformed value, and none of them should need a
 * database to assert. A non-numeric, negative or absent value falls back to the
 * default rather than being passed through — these end up interpolated into a
 * `SET LOCAL`, which cannot take a bind parameter, so "is this an integer" is a
 * correctness question before it is a tidiness one.
 */
export function resolveMigrationTimeouts(env: NodeJS.ProcessEnv = process.env): MigrationTimeouts {
  const ms = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    ddlLockTimeoutMs: ms(env.MIGRATION_DDL_LOCK_TIMEOUT_MS, DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS),
    statementTimeoutMs: ms(env.MIGRATION_STATEMENT_TIMEOUT_MS, DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS),
  };
}

/**
 * Raised when the migration lock could not be taken inside its deadline.
 *
 * `holders` is `null` when {@link migrationLockHolders} could not ask — which
 * is a third thing, and used to be spelled the same as the second. See there.
 */
export class MigrationLockTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly holders: readonly number[] | null,
  ) {
    super(
      `Could not acquire the migration advisory lock within ${timeoutMs}ms` +
        (holders === null
          ? ' — and pg_locks could not be read to say who holds it, so this message ' +
            'cannot tell you whether anyone does. Ask it by hand: `SELECT pid FROM pg_locks ' +
            "WHERE locktype = 'advisory' AND classid = 0 AND objid = " +
            `${LOCK_KEY} AND granted\`.`
          : holders.length > 0
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

/**
 * Turns a failed migration into a message that names the cause.
 *
 * Two of these failures are the session bounds doing their job, and both arrive
 * from Postgres as a bare sentence — "canceling statement due to lock timeout"
 * — that says what happened and nothing about what to do. They are also the two
 * an operator meets during a deploy rather than while writing SQL, which is the
 * worst moment to have to work out whether the migration is wrong or merely
 * unlucky. The distinction is the whole message: one is retryable and one is
 * not.
 */
export function explainMigrationFailure(file: string, err: unknown, timeouts: MigrationTimeouts): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const head = `Migration ${file} failed: ${message}`;

  // 55P03 lock_not_available — `lock_timeout` fired, so the statement never
  // began. Nothing was applied and nothing is wrong with the file.
  if (code === '55P03') {
    return (
      `${head}. It waited ${timeouts.ddlLockTimeoutMs}ms for a table lock and gave up, which means ` +
      'another session was holding a conflicting lock — a long-running query, an open transaction, or ' +
      'a hand-run statement left uncommitted. The migration itself is fine and was not applied; the ' +
      'unit is Restart=always, so the next boot retries it and will succeed once the holder is gone. ' +
      "Find it with `SELECT * FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_start` " +
      'before raising MIGRATION_DDL_LOCK_TIMEOUT_MS, which only lengthens the queue behind it.'
    );
  }

  // 57014 query_canceled — `statement_timeout` fired, so the statement did run
  // and simply did not finish. A retry does the same thing again.
  if (code === '57014') {
    return (
      `${head}. It ran for ${timeouts.statementTimeoutMs}ms and was cancelled. Unlike a lock timeout ` +
      'this will not pass on a retry: the statement holds its locks and is genuinely that slow, which ' +
      'on this schema means an index build or a table rewrite over more rows than the environment it ' +
      'was tested against. Apply it by hand under a longer MIGRATION_STATEMENT_TIMEOUT_MS during a ' +
      'maintenance window, or split it so each statement is bounded.'
    );
  }

  return head;
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
 *
 * `null` when the question could not be asked, which is not the same answer as
 * the empty array (R352, methodology M5). It used to be: a failed read returned
 * `[]`, and `MigrationLockTimeoutError` reads an empty holder list as a
 * *finding* — "no holder is visible in pg_locks, which means it was released
 * and re-taken repeatedly while this runner waited (several replicas booting at
 * once)". So a permission error on `pg_locks`, a statement timeout, or a
 * connection that had already gone away made a boot failure assert a specific
 * cause that nothing had checked, and sent whoever was reading it during a
 * stalled deploy to look for a contention problem that may not exist — while
 * the one fact that would end the incident, the pid holding the lock, was
 * never named. Diagnostics still must not fail the boot; what they must not do
 * either is answer a question they did not get to ask.
 */
export async function migrationLockHolders(db: Queryable): Promise<number[] | null> {
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
    // Diagnostics must never be the thing that fails the boot — but "I could
    // not look" is what this returns, not "I looked and found nobody".
    return null;
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
      const held =
        holders === null ? 'unreadable — pg_locks could not be queried' : holders.join(', ') || 'unknown';
      opts.log(
        `waiting for the migration lock (held by pid ${held}); ` + `giving up after ${opts.timeoutMs}ms`,
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
 * Each file's transaction also sets its own `lock_timeout` and
 * `statement_timeout` — see {@link DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS} and
 * {@link DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS}. The client comes from the
 * application pool, whose bounds are tuned for request handlers and are wrong
 * for DDL in both directions at once: too short to let an index build finish,
 * and (for locks) absent entirely, so a blocked ALTER TABLE stalled every
 * request queued behind it on the same table.
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
    /**
     * Progress. One line per step the runner takes, and every one of them is a
     * thing that went right: a lock waited for, a lock acquired, a file
     * applied.
     *
     * Separated from {@link MigrateOptions.onIssue} below because the caller
     * has to pick a level and a message, and it cannot do that from a string
     * without reading the prose (R337, methodology M11). `index.ts` rendered
     * every line this channel carries as `info` under the fixed message
     * 'migration applied' — so "waiting for the migration lock, held by pid
     * 8134" and "could not release the migration lock" were both announced, at
     * `info`, as a migration having been applied.
     */
    log?: (msg: string) => void;
    /**
     * A failure the run survived and nothing will come back for.
     *
     * There is exactly one today and it is the reason this channel exists: a
     * refused `pg_advisory_unlock`. The migration itself succeeded, so the
     * caller must not be told the run failed — and the consequence is a *later*
     * deploy that cannot come up, which makes it precisely the shape
     * `logUnretried` is for. It reached the same `info` line as the successes.
     *
     * Defaults to the progress channel so a caller that has not been updated
     * still hears about it, which is the safer of the two ways to be wrong.
     */
    onIssue?: (msg: string, err: unknown) => void;
    /** Cap on the wait for the advisory lock. See
     *  {@link DEFAULT_MIGRATION_LOCK_TIMEOUT_MS} for why there is one at all. */
    lockTimeoutMs?: number;
    /** Poll interval while waiting; injected by the contention tests. */
    lockPollMs?: number;
    /** Per-statement table-lock wait. See
     *  {@link DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS}. */
    ddlLockTimeoutMs?: number;
    /** Per-statement execution ceiling. See
     *  {@link DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS}. */
    statementTimeoutMs?: number;
  } = {},
): Promise<string[]> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const log = opts.log ?? (() => {});
  const onIssue = opts.onIssue ?? ((msg: string) => log(msg));
  const env = resolveMigrationTimeouts();
  const timeouts: MigrationTimeouts = {
    ddlLockTimeoutMs: opts.ddlLockTimeoutMs ?? env.ddlLockTimeoutMs,
    statementTimeoutMs: opts.statementTimeoutMs ?? env.statementTimeoutMs,
  };
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
        // SET LOCAL rather than SET, and the difference is not stylistic. This
        // client was borrowed from the *application* pool and is returned to it
        // — pg runs no DISCARD on release — so a plain SET would leave a
        // five-minute statement_timeout on a connection that the next request
        // handler picks up, quietly removing the 15s ceiling every other query
        // in the service relies on. LOCAL is scoped to the transaction and
        // reverts on COMMIT and on ROLLBACK alike, so both exits are covered
        // without a restore step that could itself be skipped.
        //
        // Interpolated because SET takes no bind parameter; both values are
        // integers by construction (see resolveMigrationTimeouts).
        await client.query(`SET LOCAL lock_timeout = ${timeouts.ddlLockTimeoutMs}`);
        await client.query(`SET LOCAL statement_timeout = ${timeouts.statementTimeoutMs}`);
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        // A failed ROLLBACK must not become the error the operator sees. When
        // the connection is what broke, ROLLBACK throws too, and an unguarded
        // one replaces a message naming the migration with a socket error
        // naming nothing.
        // swallow: ROLLBACK in a catch that is re-raising the error that caused it.
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(explainMigrationFailure(file, err, timeouts));
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    /*
     * The unlock, and the connection dropped when it does not happen (R332,
     * methodology M5).
     *
     * Still swallowed as far as the caller is concerned — a migration that ran
     * must not be reported as a failure because the unlock did not answer — but
     * no longer *silent*, and no longer returning the connection to the pool.
     * The comment this replaces said the session ending releases the lock
     * anyway. This session does not end: the client comes from the application
     * pool and `client.release()` hands it straight back for a request handler
     * to pick up, still holding a session-scoped key.
     *
     * `db/sweepLock.ts` sets out what that costs, and states that its three are
     * "the service's only session-scoped locks" — this is the fourth, and the
     * one with the worst ending. `pg_advisory_unlock` is the only thing that
     * frees it short of the backend going away, so a swallowed failure leaves
     * LOCK_KEY held by an idle pooled connection of a *running* service. Every
     * later boot takes a different connection, fails `pg_try_advisory_lock` for
     * the full `DEFAULT_MIGRATION_LOCK_TIMEOUT_MS`, and dies with
     * `MigrationLockTimeoutError` naming the pid of a healthy application
     * process — a deploy that cannot come up, for a reason nothing recorded.
     *
     * `release(err)` destroys the connection instead of pooling it, which ends
     * the backend session and takes the lock with it. That is the only remedy
     * available: the unlock is the thing that just failed, so retrying it on
     * the same connection is not a plan.
     */
    let unreleasedLock: unknown = null;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch (err) {
      unreleasedLock = err;
      // `onIssue`, not `log` (R337, methodology M11). Every other line this
      // runner writes is a step that went right, and the caller renders the
      // channel as one level with one message — so R332 gave this failure a
      // voice and put it out as `info`, titled 'migration applied'. It is
      // neither: the deploy it costs is the *next* one, and no retry is coming.
      onIssue(
        'could not release the migration lock; dropped the connection so the lock cannot outlive it',
        err,
      );
    }
    client.release(unreleasedLock ? (unreleasedLock as Error) : undefined);
  }
  return applied;
}
