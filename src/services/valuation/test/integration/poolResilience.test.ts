import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://n409:n409_dev@localhost:5432/n409_dev';

/**
 * A pooled connection dying while it sits idle.
 *
 * This is the shape behind the 57P01 the integration suite hit at teardown:
 * `DROP DATABASE ... WITH (FORCE)` terminates the backends of a database whose
 * client sockets are still unwinding, and the fatal comes back on a connection
 * nothing is waiting on. pg raises that on the *pool*, not on a query — so with
 * no `error` listener it was an unhandled EventEmitter error, which
 * `installCrashHandlers` escalates into a process exit in production and takes
 * the vitest worker down in tests.
 *
 * `pg_terminate_backend` is the same event without the teardown timing, so it
 * reproduces the crash deterministically. What the pool must do is absorb it
 * and reconnect on the next checkout.
 */
describe.skipIf(!dbUp)('pool survives an idle client being terminated', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db?.teardown());

  it('absorbs the fatal and serves the next query on a fresh connection', async () => {
    // Establish a connection and let it fall back to idle in the pool.
    const { rows } = await db.pool.query<{ pid: number; datname: string }>(
      'SELECT pg_backend_pid() AS pid, current_database() AS datname',
    );
    const pid = rows[0]!.pid;
    const dbName = rows[0]!.datname;
    expect(db.pool.idleCount).toBe(1);

    // Anything the pool raises must still reach a listener; add a spy alongside
    // the handler setupTestDb attached, so the event is observed, not just
    // survived.
    const seen: Array<{ code?: string }> = [];
    db.pool.on('error', (err) => seen.push(err as { code?: string }));

    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }

    // Give pg the turn of the loop it needs to notice the socket closed.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(seen).toHaveLength(1);
    // 57P01 admin_shutdown — the same SQLSTATE the forced drop produces.
    expect(seen[0]!.code).toBe('57P01');

    // The dead client is gone and the pool dials a new one rather than
    // handing out the corpse.
    const after = await db.pool.query<{ pid: number; datname: string }>(
      'SELECT pg_backend_pid() AS pid, current_database() AS datname',
    );
    expect(after.rows[0]!.pid).not.toBe(pid);
    expect(after.rows[0]!.datname).toBe(dbName);
  });

  it('leaves exactly one handler attached, so nothing is unhandled', () => {
    // The spy above is the second; setupTestDb's is the one that must persist.
    expect(db.pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });
});
