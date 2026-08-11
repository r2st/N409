import pg from 'pg';
import { asPgError } from './pgError.js';

export interface PoolTuning {
  /** Hard ceiling on any single statement (ms). A slow query can otherwise pin
   *  a connection indefinitely; with only `max` connections that stalls the
   *  whole service. */
  statementTimeoutMs: number;
  /** Kills a transaction that sits idle holding a connection (ms). */
  idleInTransactionTimeoutMs: number;
  /** How long `pool.connect()` waits for a free/again-connectable client (ms). */
  connectionTimeoutMs: number;
  /** How long an idle client stays in the pool before being closed (ms). */
  idleTimeoutMs: number;
  /** Max clients in the pool. */
  max: number;
  /** TLS: true → verify; false → disabled; 'no-verify' → encrypt but skip CA
   *  verification (managed PG with self-signed chains). */
  ssl: boolean | 'no-verify';
}

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Whether the connection string already asks for TLS. */
function urlWantsSsl(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const mode = url.searchParams.get('sslmode');
    return mode !== null && mode !== 'disable';
  } catch {
    return /sslmode=(?!disable)/.test(databaseUrl);
  }
}

/**
 * Resolves pool tuning from env with production-safe defaults (B-3 §DB pool):
 * bounded statement/connection timeouts and TLS. Pure + exported so it can be
 * asserted in tests without opening a real connection.
 *
 * TLS is required in production unless `DB_SSL=disable` is set explicitly, so a
 * plaintext prod database is a deliberate opt-out rather than the silent default.
 */
export function resolvePoolTuning(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): PoolTuning {
  const sslEnv = env.DB_SSL?.trim().toLowerCase();
  let ssl: boolean | 'no-verify';
  if (sslEnv === 'disable' || sslEnv === 'false' || sslEnv === 'off') {
    ssl = false;
  } else if (sslEnv === 'no-verify') {
    ssl = 'no-verify';
  } else if (sslEnv === 'require' || sslEnv === 'true' || sslEnv === 'on') {
    ssl = true;
  } else {
    // Unset: infer from the URL, but default-on in production.
    ssl = urlWantsSsl(databaseUrl) || env.NODE_ENV === 'production';
  }

  return {
    statementTimeoutMs: num(env.DB_STATEMENT_TIMEOUT_MS, 15_000),
    idleInTransactionTimeoutMs: num(env.DB_IDLE_TX_TIMEOUT_MS, 15_000),
    connectionTimeoutMs: num(env.DB_CONNECTION_TIMEOUT_MS, 10_000),
    idleTimeoutMs: num(env.DB_IDLE_TIMEOUT_MS, 30_000),
    max: num(env.DB_POOL_MAX, 10),
    ssl,
  };
}

/** Builds the `pg.PoolConfig` from a URL + tuning. Exported for tests. */
export function buildPoolConfig(databaseUrl: string, tuning: PoolTuning): pg.PoolConfig {
  return {
    connectionString: databaseUrl,
    max: tuning.max,
    connectionTimeoutMillis: tuning.connectionTimeoutMs,
    idleTimeoutMillis: tuning.idleTimeoutMs,
    statement_timeout: tuning.statementTimeoutMs,
    idle_in_transaction_session_timeout: tuning.idleInTransactionTimeoutMs,
    ssl:
      tuning.ssl === false
        ? undefined
        : tuning.ssl === 'no-verify'
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true },
  };
}

/** The listener this module installs, tracked so a second call replaces it. */
const POOL_ERROR_HANDLER = Symbol('n409.pool.errorHandler');

type PoolErrorLog = { error: (obj: Record<string, unknown>, msg: string) => void };

/**
 * Makes a pool survive an idle client dying under it.
 *
 * pg raises `error` on the *pool* — not on any query — when a client sitting
 * idle in it loses its connection: a database restart or failover, a reaper on
 * the far side of a connection proxy, a `DROP DATABASE ... WITH (FORCE)` landing
 * on sockets that are still closing (57P01 `admin_shutdown`, which is how this
 * reaches the integration suite at teardown). By then pg has already removed the
 * client, and no statement was in flight, so there is nothing for the
 * application to fail — the next checkout simply dials a fresh connection.
 *
 * But `EventEmitter` throws an unhandled `error`, and every pool in this service
 * was built without a listener. So the routine reconnect became an
 * `uncaughtException`, and `installCrashHandlers` turns that into a process
 * exit that takes every in-flight request with it — the service killing itself
 * over an event whose only correct response is to note it and carry on.
 *
 * Called from `createPool` with no logger so a pool is never listener-less
 * between construction and the point the app log exists; call it again with the
 * log once it does.
 */
export function attachPoolErrorHandler(pool: pg.Pool, log?: PoolErrorLog): void {
  const tracked = pool as pg.Pool & { [POOL_ERROR_HANDLER]?: (err: Error) => void };
  const previous = tracked[POOL_ERROR_HANDLER];
  if (previous) pool.removeListener('error', previous);

  const handler = (err: Error): void => {
    log?.error(
      { err, code: asPgError(err)?.code },
      'idle database client error — client dropped, pool will reconnect',
    );
  };
  tracked[POOL_ERROR_HANDLER] = handler;
  pool.on('error', handler);
}

export function createPool(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const pool = new pg.Pool(buildPoolConfig(databaseUrl, resolvePoolTuning(databaseUrl, env)));
  attachPoolErrorHandler(pool);
  return pool;
}

/**
 * Runs fn inside a transaction on a client the caller already holds, rolling
 * back on any error. Separate from withTransaction because a caller holding a
 * session-scoped resource on that client — an advisory lock, say — must not
 * have the work moved to a different connection.
 */
export async function withClientTransaction<T>(
  client: pg.PoolClient,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Runs fn inside a transaction, rolling back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await withClientTransaction(client, fn);
  } finally {
    client.release();
  }
}
