import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

/**
 * The migration lock, and the connection that must not carry it back to the
 * pool (R332, methodology M5).
 *
 * `db/sweepLock.ts` sets this out at length and states that its three keys are
 * "the service's only session-scoped locks". This is the fourth. The runner
 * borrows a client from the *application* pool — its own comments say so — and
 * `client.release()` hands it straight to the next request handler, so a
 * swallowed `pg_advisory_unlock` failure leaves LOCK_KEY held by an idle
 * pooled connection of a running, healthy service.
 *
 * The ending is the worst of the four: every later boot takes a different
 * connection, fails `pg_try_advisory_lock` for the whole lock timeout, and dies
 * with `MigrationLockTimeoutError` naming the pid of an application process
 * nobody suspects. A deploy that cannot come up, for a reason nothing recorded.
 */
async function emptyMigrationDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'n409-migrate-'));
}

/**
 * A pool whose only client answers the bookkeeping queries and optionally
 * refuses the unlock.
 */
function fakePool(opts: { unlockFails?: boolean } = {}) {
  const release = vi.fn();
  const queries: string[] = [];
  const query = vi.fn(async (text: string) => {
    queries.push(text);
    if (text.includes('pg_advisory_unlock')) {
      if (opts.unlockFails) throw new Error('connection terminated unexpectedly');
      return { rows: [{ ok: true }], rowCount: 1 };
    }
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release };
  return { pool: { connect: async () => client } as never, release, queries };
}

describe('the migration advisory lock', () => {
  it('is released and the connection pooled on the ordinary path', async () => {
    const { pool, release, queries } = fakePool();

    await migrate(pool, { dir: await emptyMigrationDir() });

    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    // No argument: a healthy connection goes back to the pool.
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('takes the connection down with it when the unlock is refused', async () => {
    const { pool, release } = fakePool({ unlockFails: true });

    await migrate(pool, { dir: await emptyMigrationDir() });

    // Destroying the connection ends the backend session, which is the only
    // thing left that can free a session-scoped key once the unlock itself has
    // failed. Retrying the unlock on the same connection is not a plan.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('says so, rather than leaving a failed deploy with nothing to read', async () => {
    const { pool } = fakePool({ unlockFails: true });
    const lines: string[] = [];

    await migrate(pool, { dir: await emptyMigrationDir(), log: (m) => lines.push(m) });

    expect(lines.some((l) => l.includes('could not release the migration lock'))).toBe(true);
  });

  it('does not turn a completed migration into a failure', async () => {
    const { pool } = fakePool({ unlockFails: true });
    // The migration ran. Reporting it as failed because the unlock did not
    // answer would send an operator re-running work that is already applied.
    await expect(migrate(pool, { dir: await emptyMigrationDir() })).resolves.toEqual([]);
  });
});
