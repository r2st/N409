import { mkdtemp, readFile } from 'node:fs/promises';
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

  it('reports the refusal on its own channel, not among the steps that went right', async () => {
    /*
     * R337, methodology M11. R332 gave this failure a voice and put it out
     * through `log` — the channel that also carries "applied 0161_foo.sql",
     * "waiting for the migration lock" and "acquired the migration lock after
     * 40ms". Every one of those is a step that went *right*, and the caller has
     * to choose one level and one message for the whole channel: `index.ts`
     * chose `info`, titled 'migration applied'. So the one line here that means
     * a later deploy will not come up was announced as a migration having been
     * applied, at the level used for routine progress, with no `alert` flag on
     * it — and the only way a caller could have told them apart was by reading
     * the prose.
     */
    const { pool } = fakePool({ unlockFails: true });
    const progress: string[] = [];
    const issues: Array<{ msg: string; err: unknown }> = [];

    await migrate(pool, {
      dir: await emptyMigrationDir(),
      log: (m) => progress.push(m),
      onIssue: (msg, err) => issues.push({ msg, err }),
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.msg).toContain('could not release the migration lock');
    // The error itself, not its `String()`. The caller classifies it — see
    // `logUnretried`, which puts `failure_reason` on the line — and it cannot
    // do that from prose.
    expect(issues[0]!.err).toBeInstanceOf(Error);
    expect(progress.some((l) => l.includes('migration lock'))).toBe(false);
  });

  it('still reaches a caller that only supplies the progress channel', async () => {
    // The fallback is deliberate: of the two ways to be wrong about a caller
    // that has not been updated, saying it on the wrong channel beats not
    // saying it. The case above is what holds the right channel in place.
    const { pool } = fakePool({ unlockFails: true });
    const lines: string[] = [];
    await migrate(pool, { dir: await emptyMigrationDir(), log: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes('could not release the migration lock'))).toBe(true);
  });

  it('is wired to the alert contract by its one production caller', async () => {
    /*
     * The channel exists so that a level and a flag can be chosen for it, and
     * the choosing happens in `index.ts`. Read from source because there is no
     * way to reach that line without booting the service — and without this,
     * the whole of the fix above can be undone by a caller passing the same
     * `app.log.info` to both.
     */
    const src = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf('await migrate(pool, {'), src.indexOf('markReady()'));
    expect(call).toContain('onIssue:');
    // `logUnretried` is the estate's shape for a failure nothing revisits: it
    // logs `error` with `alert: true` and classifies the cause. The cost here
    // lands on the *next* deploy, so no retry is coming for it.
    expect(call).toContain('logUnretried(');
    expect(call, "the runner's progress lines must not claim a migration was applied").not.toContain(
      "'migration applied'",
    );
  });

  it('does not turn a completed migration into a failure', async () => {
    const { pool } = fakePool({ unlockFails: true });
    // The migration ran. Reporting it as failed because the unlock did not
    // answer would send an operator re-running work that is already applied.
    await expect(migrate(pool, { dir: await emptyMigrationDir() })).resolves.toEqual([]);
  });
});
