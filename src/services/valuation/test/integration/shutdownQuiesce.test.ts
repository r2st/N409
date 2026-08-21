import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { nonOverlapping, quiesceAndLog, type NamedScheduler } from '@n409/shared';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, markEmail } from '../../src/repos/emailOutbox.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

/**
 * What SIGTERM costs a background sweep, and what waiting for it saves.
 *
 * `index.ts` clears eleven intervals at shutdown, which stops the *next* tick
 * and does nothing to the one already running. The premise that made that look
 * sufficient — that `pool.end()` waits for whatever is still using the pool —
 * is false for a sweep, and this file is the proof rather than the argument:
 * `pool.end()` waits for checked-out *clients*, and a sweep between two queries
 * holds none, because `pool.query()` returns its client before it resolves.
 *
 * The email retry sweep is the case that shows why this is a client-visible
 * bug and not untidiness. It claims a batch, then per row sends and settles.
 * Cut between those two calls, the message has left SMTP and nothing recorded
 * it: the row keeps its claim until the lease expires and the next sweep sends
 * it again.
 */

/** A transport that records every send and holds the first one open. */
function gatedTransport(): {
  transport: EmailTransport;
  sent: string[];
  releaseFirst: () => void;
  firstStarted: Promise<void>;
} {
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let announceStarted!: () => void;
  const firstStarted = new Promise<void>((r) => {
    announceStarted = r;
  });
  let first = true;
  return {
    sent,
    releaseFirst: () => release(),
    firstStarted,
    transport: {
      async send(email: { to_email: string }) {
        sent.push(email.to_email);
        if (first) {
          first = false;
          announceStarted();
          await gate;
        }
      },
    } as unknown as EmailTransport,
  };
}

/** Two rows the retry sweep will claim, oldest first. */
async function seedTwoRetryableEmails(pool: pg.Pool): Promise<void> {
  for (const to of ['first@test.example.com', 'second@test.example.com']) {
    const row = await enqueueEmail(pool, {
      toEmail: to,
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await markEmail(pool, row.id, 'failed', 'smtp connect refused');
    await pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [row.id]);
  }
}

interface OutboxState {
  to_email: string;
  status: string;
  claimed: boolean;
}

async function outboxState(pool: pg.Pool): Promise<OutboxState[]> {
  const { rows } = await pool.query<{ to_email: string; status: string; claimed_at: Date | null }>(
    'SELECT to_email, status::text AS status, claimed_at FROM email_outbox ORDER BY created_at',
  );
  return rows.map((r) => ({ to_email: r.to_email, status: r.status, claimed: r.claimed_at !== null }));
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!dbUp)('shutdown with a background sweep in flight', () => {
  /**
   * The old sequence, kept as a test so the regression is a failing assertion
   * rather than a paragraph. Nothing in `src/` does this any more.
   */
  it('ending the pool under a running sweep loses the delivery record', async () => {
    const db: TestDb = await setupTestDb();
    try {
      await seedTwoRetryableEmails(db.pool);
      const { transport, sent, releaseFirst, firstStarted } = gatedTransport();

      let sweepError: unknown;
      const sweep = nonOverlapping(
        () => retryFailedEmails({ pool: db.pool, transport, log: silent }),
        (err) => {
          sweepError = err;
        },
      );
      sweep.run();
      // Mid-flight: the first message is out on the wire and unrecorded.
      await firstStarted;

      // SIGTERM, as it used to be handled: clearInterval (nothing to do for a
      // one-shot run) and straight into ending the pool.
      const endedAt = Date.now();
      await db.pool.end();
      const endTookMs = Date.now() - endedAt;

      releaseFirst();
      // Let the sweep unwind against the ended pool.
      await new Promise((r) => setTimeout(r, 50));

      // `end()` did not wait: a sweep between two queries holds no client.
      expect(endTookMs).toBeLessThan(200);
      expect(sent).toEqual(['first@test.example.com']);
      expect(sweepError).toBeInstanceOf(Error);
      expect((sweepError as Error).message).toContain('Cannot use a pool after calling end');
    } finally {
      // The pool is already ended; drop the database directly.
      const drop = new pg.Client({
        connectionString:
          process.env.TEST_DATABASE_URL ??
          process.env.DATABASE_URL ??
          'postgres://n409:n409_dev@localhost:5432/n409_dev',
      });
      await drop.connect();
      const name = (db.pool as unknown as { options: { database: string } }).options.database;
      await drop.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await drop.end();
    }
  });

  /**
   * The sequence `index.ts` runs now: clear the intervals, wait for the tick
   * already in flight, and only then end the pool.
   */
  it('quiescing first lets the sweep settle every row it claimed', async () => {
    const db: TestDb = await setupTestDb();
    try {
      await seedTwoRetryableEmails(db.pool);
      const { transport, sent, releaseFirst, firstStarted } = gatedTransport();

      let sweepError: unknown;
      const scheduler = nonOverlapping(
        () => retryFailedEmails({ pool: db.pool, transport, log: silent }),
        (err) => {
          sweepError = err;
        },
      );
      const sweeps: NamedScheduler[] = [{ name: 'email-retry', scheduler }];
      scheduler.run();
      await firstStarted;
      expect(scheduler.running).toBe(true);

      // Shutdown: the wait is what the interval clear cannot do.
      const quiesced = quiesceAndLog(sweeps, silent, { timeoutMs: 5_000 });
      // Still held — the wait is real, not a formality.
      await new Promise((r) => setTimeout(r, 20));
      expect(scheduler.running).toBe(true);

      releaseFirst();
      const result = await quiesced;

      expect(result.idle).toBe(true);
      expect(result.running).toEqual([]);
      expect(sweepError).toBeUndefined();
      // Both messages sent, and both rows say so — no claim left holding a
      // message the transport already delivered.
      expect(sent).toEqual(['first@test.example.com', 'second@test.example.com']);
      expect(await outboxState(db.pool)).toEqual([
        { to_email: 'first@test.example.com', status: 'sent', claimed: false },
        { to_email: 'second@test.example.com', status: 'sent', claimed: false },
      ]);
    } finally {
      await db.teardown();
    }
  });

  /** A wedged sweep must not hold the process past its deadline. */
  it('gives up on a sweep that will not finish, naming it', async () => {
    const db: TestDb = await setupTestDb();
    try {
      const scheduler = nonOverlapping(
        () => new Promise<void>(() => {}),
        () => {},
      );
      scheduler.run();

      const warns: Array<[Record<string, unknown>, string]> = [];
      const log = { info: () => {}, warn: (o: Record<string, unknown>, m: string) => warns.push([o, m]) };
      const result = await quiesceAndLog([{ name: 'email-retry', scheduler }], log, { timeoutMs: 30 });

      expect(result.idle).toBe(false);
      expect(result.running).toEqual(['email-retry']);
      expect(warns[0]?.[1]).toContain('quiesce deadline reached');
    } finally {
      await db.teardown();
    }
  });
});
