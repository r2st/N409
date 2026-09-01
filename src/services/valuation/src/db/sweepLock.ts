import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Advisory-lock keys for the passes that must not overlap themselves.
 *
 * Session-scoped `pg_try_advisory_lock`, one namespace per database, so every
 * key here has to be distinct from every other and from the migrate lock
 * (`db/migrate.ts`). Spelled as four ASCII bytes for the same reason that one
 * is — a key that appears in `pg_locks` during an incident should say what it
 * belongs to.
 */
export const SWEEP_LOCKS = {
  /** The auto-email drip scan (`hooks/autoEmails.ts`). */
  autoEmailScan: 0x6e34_4145, // 'n4AE'
  /** The overdue-engagement reminder sweep (`routes/engagements.ts`). */
  overdueReminders: 0x6e34_4f52, // 'n4OR'
  /** The job-queue alert scan (`hooks/jobAlerts.ts`). */
  jobAlertScan: 0x6e34_4a41, // 'n4JA'
} as const;

/**
 * Run a sweep with a session-scoped advisory lock held, or decline to run it.
 *
 * WHY EVERY MAILING SWEEP NEEDS ONE. A sweep that decides whether to act by
 * reading committed rows is a stale-read-then-write in the large: two passes
 * that overlap both read the same "not done yet" and both do it. That is not a
 * rare interleaving on any of these — an ops double-click fires the endpoint
 * twice, a scheduler firing on an interval shorter than the pass takes overlaps
 * with itself, and a deployment can run more than one instance against one
 * database. When the thing both passes do is send mail, the second one is not a
 * wasted round trip: mail cannot be un-sent.
 *
 * `try` rather than a blocking lock, which is `autoEmails`' argument and holds
 * for every caller: a pass that waited its turn would only wake up to re-read a
 * backlog the holder has just drained, and "the sweep you asked for is already
 * happening" is the honest answer to a collision rather than a queue.
 *
 * WHY THE CONNECTION IS DESTROYED WHEN THE UNLOCK FAILS. These are the service's
 * only session-scoped locks — every other one is `pg_advisory_xact_lock`,
 * released by COMMIT or ROLLBACK whatever happens. A session lock is released by
 * the explicit unlock below or by the backend going away, and nothing else, so a
 * swallowed unlock failure returns a *healthy* connection to the pool still
 * holding the key. The lock then outlives the pass, the sweep and the deploy:
 * every later run takes a different connection, fails the try, and reports
 * "already in progress" — which is the line for the benign case, so the sweep
 * simply stops and the log says the healthy thing forever. `release(err)` with a
 * truthy argument destroys the connection instead of pooling it, which ends the
 * backend session and takes the lock with it. That is the only remedy available:
 * the unlock is the thing that just failed, so retrying it on the same
 * connection is not a plan.
 *
 * The callback gets the locked client. A caller whose reads must be covered by
 * the lock has to use it — work moved to another pool connection is serialized
 * against other *passes* but is not inside this session — and a caller that only
 * needs the mutual exclusion may ignore it.
 */
export async function withSweepLock<T>(
  pool: pg.Pool,
  key: number,
  log: FastifyBaseLogger | undefined,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  /** Set when the unlock did not happen, and why this connection must not go back. */
  let unreleasedLock: unknown = null;
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      key,
    ]);
    if (!rows[0]!.locked) return { ran: false };
    try {
      return { ran: true, value: await run(client) };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      } catch (err) {
        // Still swallowed as far as the caller is concerned — a sweep that did
        // its work must not report failure because the unlock did not answer —
        // but recorded, because the alternative is a sweep that never runs
        // again with nothing anywhere saying why.
        unreleasedLock = err;
        log?.error(
          { err, key },
          'could not release a sweep lock; dropping the connection so the lock cannot outlive it',
        );
      }
    }
  } finally {
    client.release(unreleasedLock ? (unreleasedLock as Error) : undefined);
  }
}
