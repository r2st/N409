import { describe, expect, it, vi } from 'vitest';
import { MigrationLockTimeoutError, migrationLockHolders } from '../../src/db/migrate.js';

/**
 * "Nobody holds it" and "I could not ask who does" are different answers
 * (R352, methodology M5).
 *
 * `migrationLockHolders` is best-effort by design — a diagnostic must never be
 * the thing that fails a boot — and it used to express that by returning `[]`
 * on any failure. But `MigrationLockTimeoutError` reads an empty holder list as
 * a *finding*, and writes a sentence explaining it: the lock "was released and
 * re-taken repeatedly while this runner waited (several replicas booting at
 * once)". So a `pg_locks` read that was refused, timed out, or ran on a
 * connection that had already gone away produced a boot failure asserting a
 * cause nothing had checked — while the one fact that ends the incident, the
 * pid holding the lock, was never named and never looked for again.
 *
 * The shape, from [[n409-silent-catch-census]]: the handler returns the value
 * that also means "there is none", so the failure reads from every other
 * surface exactly like the ordinary absence.
 */

/** A `Queryable` that answers the holder query with `rows`, or throws. */
function db(answer: { rows?: Array<{ pid: number }>; throws?: Error }) {
  return {
    query: vi.fn(async () => {
      if (answer.throws) throw answer.throws;
      return { rows: answer.rows ?? [], rowCount: (answer.rows ?? []).length } as never;
    }),
  };
}

describe('migrationLockHolders', () => {
  it('reports the pids it found', async () => {
    expect(await migrationLockHolders(db({ rows: [{ pid: 4211 }, { pid: 4212 }] }))).toEqual([4211, 4212]);
  });

  it('reports an empty list when it asked and nobody held the lock', async () => {
    expect(await migrationLockHolders(db({ rows: [] }))).toEqual([]);
  });

  it('reports null — not an empty list — when the question could not be asked', async () => {
    const refused = new Error('permission denied for view pg_locks');
    expect(await migrationLockHolders(db({ throws: refused }))).toBeNull();
  });
});

describe('MigrationLockTimeoutError', () => {
  it('names the holder when there is one', () => {
    const err = new MigrationLockTimeoutError(3_000, [4211]);
    expect(err.message).toContain('held by backend pid 4211');
  });

  it('explains the empty holder list as contention', () => {
    const err = new MigrationLockTimeoutError(3_000, []);
    expect(err.message).toContain('no holder is visible in pg_locks');
    expect(err.message).toContain('several replicas booting at once');
  });

  it('claims neither when pg_locks could not be read', () => {
    const err = new MigrationLockTimeoutError(3_000, null);
    // Says what it does not know, and hands over the query to ask by hand.
    expect(err.message).toContain('pg_locks could not be read');
    expect(err.message).toContain('cannot tell you whether anyone does');
    expect(err.message).toContain('SELECT pid FROM pg_locks');
    // And makes none of the claims the other two branches make.
    expect(err.message).not.toContain('several replicas booting at once');
    expect(err.message).not.toContain('held by backend pid');
  });
});
