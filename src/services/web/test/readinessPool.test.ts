import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildReadinessPool } from '../src/app.js';

/**
 * The pool `/ready` probes Postgres with.
 *
 * `ready.test.ts` injects a fake pool, which is right for testing the readiness
 * logic and leaves the real pool's construction — the only uncovered block left
 * in `app.ts` — untested. Two of its settings are load-bearing in a way that
 * fails quietly rather than loudly:
 *
 * The sizing exists so a probe can never queue behind real work. `/ready` is
 * what a load balancer trusts to decide whether to send traffic to this
 * process, so a probe that hangs takes the instance out of rotation (or worse,
 * keeps a broken one in it) for reasons that have nothing to do with whether
 * the instance is healthy.
 *
 * The TLS decision is the one worth a test of its own. It reads `sslmode` out
 * of the connection string and, when TLS is on, connects with certificate
 * verification off — deliberate, because managed Postgres commonly presents a
 * chain we ship no CA for, and this connection carries only `SELECT 1`. But
 * the two ways to get the predicate wrong are not symmetric: too eager and we
 * disable verification on a connection the operator asked to be plain, too
 * timid and startup fails against every managed provider. Neither shows up in
 * a test that injects a pool.
 */

const created: pg.Pool[] = [];

/** `new pg.Pool` connects lazily, so nothing here reaches a database. */
function poolFor(url: string): pg.Pool & { options: Record<string, unknown> } {
  const pool = buildReadinessPool(url) as pg.Pool & { options: Record<string, unknown> };
  created.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => p.end()));
});

describe('readiness pool', () => {
  it('is sized and timed so a probe cannot queue behind real work', () => {
    const pool = poolFor('postgres://u:p@db.internal:5432/n409');
    expect(pool.options.max).toBe(1);
    expect(pool.options.connectionTimeoutMillis).toBe(3000);
    // A probe that hangs is worse than one that fails, so the connect attempt
    // is bounded well inside any sane load-balancer probe interval.
    expect(pool.options.connectionTimeoutMillis).toBeLessThan(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(10_000);
    expect(pool.options.connectionString).toBe('postgres://u:p@db.internal:5432/n409');
  });

  it('connects over TLS without chain verification when sslmode asks for TLS', () => {
    for (const mode of ['require', 'verify-full', 'verify-ca', 'prefer', 'allow']) {
      const pool = poolFor(`postgres://u:p@db.internal:5432/n409?sslmode=${mode}`);
      expect(pool.options.ssl, mode).toEqual({ rejectUnauthorized: false });
    }
  });

  it('leaves TLS off for a connection string that disables it', () => {
    const pool = poolFor('postgres://u:p@localhost:5432/n409?sslmode=disable');
    // Not `{ rejectUnauthorized: false }` — an operator who wrote
    // `sslmode=disable` asked for a plain connection, and quietly upgrading it
    // is a different connection than the one they configured.
    expect(pool.options.ssl).toBeUndefined();
  });

  it('leaves TLS off when the connection string says nothing about it', () => {
    // The local and CI case: `postgres://n409:n409_dev@localhost:5432/n409_dev`
    // with no parameters at all. Defaulting this to TLS would fail every
    // developer machine, so the absence of `sslmode` is a decision, not a gap.
    const pool = poolFor('postgres://n409:n409_dev@localhost:5432/n409_dev');
    expect(pool.options.ssl).toBeUndefined();
  });

  it('is not fooled by a mode that merely starts with the word it looks for', () => {
    // `sslmode=disabled` is not a libpq mode, but the predicate is a negative
    // lookahead on the literal `disable`, so it reads as disabled rather than
    // as an unrecognised mode it should treat as TLS. Pinned because the
    // failure is silent: a typo here yields a plain connection where the
    // operator plainly meant TLS.
    const pool = poolFor('postgres://u:p@db.internal:5432/n409?sslmode=disabled');
    expect(pool.options.ssl).toBeUndefined();
  });

  it('reads sslmode wherever it sits among the other parameters', () => {
    const pool = poolFor(
      'postgres://u:p@db.internal:5432/n409?application_name=web&sslmode=require&connect_timeout=5',
    );
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: false });
  });
});
