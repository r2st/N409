// @ts-expect-error — plain-JS tool module, deliberately outside the TS project
import { sweepStaleTestDatabases } from '../../../../tools/drop-test-dbs.mjs';

/**
 * Collects the throwaway databases earlier runs leaked, before this one starts.
 *
 * `setupTestDb` drops its database in `afterAll`, which is exactly the hook
 * that does not run when a worker is killed, when a `beforeAll` throws partway,
 * or when somebody interrupts the run. Every one of those leaves a migrated
 * ~12 MB database behind. Nothing collected them, and nothing was ever going
 * to notice: they cost no CPU and raise no error. 344 had accumulated by the
 * time anyone counted, holding 4.3 GB, the oldest of them three weeks old.
 *
 * Here rather than in a CI step because the leak is not a CI phenomenon — it
 * is a developer hitting ^C, and a cleanup that only runs on the build server
 * never sees the machine with the problem. Running it at the start rather than
 * the end is deliberate too: the run that leaks a database is by definition the
 * run that did not reach its own cleanup.
 *
 * Safe on a shared server. The sweep never touches a database with a backend
 * connected to it, and never one younger than the threshold — so a suite
 * running in another terminal, or another agent's, is doubly out of reach. An
 * hour is far longer than any single test file lives and far shorter than the
 * intervals these were surviving.
 */
export async function setup(): Promise<void> {
  const result = await sweepStaleTestDatabases({
    olderThanMinutes: 60,
    log: (message: string) => console.log(`[test-db sweep] ${message}`),
  });
  if (result.failed.length > 0) {
    // Not a failure of this run: the usual cause is a race with another sweep
    // or a suite that connected mid-sweep, and the next run collects whatever
    // was missed. Reported so a genuinely stuck database is visible rather than
    // silently retried forever.
    console.log(`[test-db sweep] ${result.failed.length} could not be dropped; will retry next run.`);
  }
}
