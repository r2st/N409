import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { isDbAvailable, setupTestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** `SCAN_LOCK_KEY` in `hooks/autoEmails.ts` — 'n4AE'. */
const SCAN_LOCK_KEY = 0x6e34_4145;

/**
 * The one session-scoped advisory lock in the service, and what happens when it
 * cannot be released.
 *
 * Every other advisory lock here is `pg_advisory_xact_lock`, which COMMIT or
 * ROLLBACK releases whatever goes wrong. The auto-email scan's is not: it is
 * taken with `pg_try_advisory_lock` and held for the length of the pass, so it
 * is released by the explicit unlock or by the backend going away, and by
 * nothing else.
 *
 * The unlock's failure was swallowed, and then the connection went back into
 * the pool still holding the lock. Nothing after that can take it: every later
 * tick draws a different connection, `pg_try_advisory_lock` answers false, and
 * the pass logs "auto email scan already in progress; skipping this pass" —
 * which is the line for the ordinary contended case. So the drip campaigns stop
 * for the life of the process and the log reads healthy the whole time.
 *
 * Asserted against `pg_locks` from a separate connection rather than by running
 * the scan again: an advisory lock is re-entrant within its own session, so a
 * second pass that happened to draw the leaked connection would take the lock
 * and report success while the leak was still there.
 */
describe.skipIf(!dbUp)('the auto email scan lock', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;

  beforeAll(async () => {
    db = await setupTestDb();
  }, 60_000);
  afterAll(async () => db?.teardown());

  /**
   * Backends holding the scan lock right now.
   *
   * The one-argument `pg_try_advisory_lock(bigint)` splits its key across
   * `pg_locks` the way `db/migrate.ts` describes: `classid` is the high 32
   * bits — zero for this key — `objid` the low 32, and `objsubid` 1 marks it as
   * the single-bigint form rather than the two-int one. Matching on `classid`
   * alone finds nothing and would make this assertion vacuous.
   */
  async function heldLocks(): Promise<number> {
    const count = async () =>
      Number(
        (
          await db.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks
              WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1`,
            [SCAN_LOCK_KEY >>> 0],
          )
        ).rows[0]!.n,
      );
    // Client destruction closes the socket; the backend exits a moment later,
    // so this is polled rather than read once.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await count()) === 0) return 0;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return count();
  }

  /**
   * The pool the sweep runs on, with the unlock — and only the unlock — broken
   * on whatever connection it draws.
   *
   * Wrapping `connect` rather than `pool.query`: the lock lives on the client
   * the scan holds for the whole pass, which is the connection this has to
   * reach and the one `pool.query` never hands out.
   */
  function poolWithFailingUnlock(pool: pg.Pool): pg.Pool {
    const connect = pool.connect.bind(pool);
    const patched = async () => {
      const client = (await connect()) as pg.PoolClient;
      const query = client.query.bind(client);
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
        if (text.includes('pg_advisory_unlock')) {
          return Promise.reject(new Error('connection reset while releasing the scan lock'));
        }
        return (query as (...a: unknown[]) => unknown)(...args);
      };
      return client;
    };
    return new Proxy(pool, {
      get: (target, prop, receiver) => (prop === 'connect' ? patched : Reflect.get(target, prop, receiver)),
    }) as pg.Pool;
  }

  it('holds no lock after a pass whose unlock failed', async () => {
    expect(await heldLocks()).toBe(0);

    const errors: unknown[] = [];
    const log = {
      info: () => {},
      warn: () => {},
      error: (obj: unknown) => errors.push(obj),
    } as unknown as Parameters<typeof runDueAutoEmails>[0]['log'];

    // No campaigns are configured, so the scan itself has nothing to do — the
    // pass is here for its lock handling, not its output.
    const result = await runDueAutoEmails({ pool: poolWithFailingUnlock(db.pool), log });
    expect(result).toEqual({ queued: 0, skipped: 0, suppressed: 0, failed: 0 });

    // The assertion this test exists for, made first: whatever else happened,
    // the lock must not have survived the pass.
    expect(await heldLocks()).toBe(0);
    // And the caller is not told the pass failed — it did not — but the failure
    // is on the record, which is the half that was missing entirely.
    expect(errors).toHaveLength(1);
  });

  it('holds no lock after an ordinary pass, and can run again', async () => {
    const first = await runDueAutoEmails({ pool: db.pool });
    expect(first).toEqual({ queued: 0, skipped: 0, suppressed: 0, failed: 0 });
    expect(await heldLocks()).toBe(0);

    const second = await runDueAutoEmails({ pool: db.pool });
    expect(second).toEqual({ queued: 0, skipped: 0, suppressed: 0, failed: 0 });
  });
});
