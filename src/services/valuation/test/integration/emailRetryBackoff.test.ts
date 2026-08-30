import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, markEmail, settleClaimedEmail } from '../../src/repos/emailOutbox.js';
import { EMAIL_MAX_ATTEMPTS, emailRetryWindowMs } from '../../src/domain/emailRetry.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

/**
 * The schedule a failed outbox row carries, and the sweep honouring it.
 *
 * The ladder itself is unit-tested (emailRetryLadder.test.ts) — it is a pure
 * function of the attempt count. What can only be asserted against a database
 * is the half that lives in SQL: the UPDATE that stamps `next_attempt_at` in
 * the same statement that records the failure, and the claim that refuses a row
 * whose time has not come.
 *
 * The bug this pins is not "retries are wrong", it is "there was no schedule".
 * `settleClaimedEmail` cleared the lease on failure and nothing else spaced the
 * attempts, so a message's whole allowance was spent at the sweep interval —
 * against a relay outage, five attempts inside two hours and then the mail was
 * gone. So the tests below are about *when* a row is next eligible, and the
 * load-bearing one is the negative: a just-failed row must not come back on the
 * very next sweep.
 */
const failingTransport: EmailTransport = {
  async send() {
    throw new Error('smtp connect refused');
  },
};

describe.skipIf(!dbUp)('email outbox retry backoff', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  // Every case here reasons about which rows a sweep takes, so each starts from
  // an outbox with nothing else claimable in it.
  beforeEach(async () => {
    await ctx.pool.query(`UPDATE email_outbox SET status = 'sent', claimed_at = NULL`);
  });

  const seed = async (toEmail: string): Promise<string> => {
    const row = await enqueueEmail(ctx.pool, {
      toEmail,
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    return row.id;
  };

  const rowOf = async (id: string): Promise<{ attempts: number; next_attempt_at: Date | null }> => {
    const { rows } = await ctx.pool.query<{ attempts: number; next_attempt_at: Date | null }>(
      'SELECT attempts, next_attempt_at FROM email_outbox WHERE id = $1',
      [id],
    );
    if (!rows[0]) throw new Error(`outbox row ${id} not found`);
    return rows[0];
  };

  /** Brings a scheduled row's time forward, as waiting out the ladder would. */
  const makeDue = async (id: string): Promise<void> => {
    await ctx.pool.query(
      `UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
  };

  it('schedules a first failure instead of leaving it claimable', async () => {
    const before = new Date();
    const id = await seed('sched-first@test.example.com');
    await markEmail(ctx.pool, id, 'failed', 'smtp connect refused');

    const row = await rowOf(id);
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at, 'a failed row with no schedule is claimable immediately').not.toBeNull();

    // Inside the window the ladder specifies for one attempt made. Asserted as
    // a window rather than a value because the delay is jittered on purpose.
    const window = emailRetryWindowMs(1)!;
    const waited = row.next_attempt_at!.getTime() - before.getTime();
    expect(waited).toBeGreaterThanOrEqual(window.minMs - 1_000);
    expect(waited).toBeLessThanOrEqual(window.maxMs + 5_000);
  });

  it('does not hand a just-failed row back to the very next sweep', async () => {
    const id = await seed('backoff-holds@test.example.com');
    await markEmail(ctx.pool, id, 'failed', 'smtp connect refused');

    const delivered: string[] = [];
    const result = await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          delivered.push(e.id);
        },
      },
    });

    expect(delivered, 'the row is inside its backoff and must not be claimed').not.toContain(id);
    expect(result.attempted).toBe(0);
    // And the attempt was not burned by the sweep that declined to make it —
    // a claim that counts an attempt it never tried would spend the ladder on
    // polling.
    expect((await rowOf(id)).attempts).toBe(1);
  });

  it('delivers the same row once its backoff has elapsed', async () => {
    const id = await seed('backoff-elapses@test.example.com');
    await markEmail(ctx.pool, id, 'failed', 'smtp connect refused');
    await makeDue(id);

    const delivered: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          delivered.push(e.id);
        },
      },
    });

    expect(delivered).toContain(id);
  });

  it('lengthens the wait with each successive failure', async () => {
    const id = await seed('backoff-grows@test.example.com');
    await markEmail(ctx.pool, id, 'failed', 'first');

    const waits: number[] = [];
    for (let made = 1; made < EMAIL_MAX_ATTEMPTS - 1; made += 1) {
      await makeDue(id);
      const startedAt = new Date();
      await retryFailedEmails({ pool: ctx.pool, transport: failingTransport });
      const row = await rowOf(id);
      expect(row.attempts, 'each sweep costs exactly one attempt').toBe(made + 1);
      expect(row.next_attempt_at, `attempt ${made + 1} left no schedule`).not.toBeNull();
      waits.push(row.next_attempt_at!.getTime() - startedAt.getTime());
    }

    // The whole of the fix: successive failures wait longer, so the attempts
    // are not all spent inside the outage that caused them.
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i], `wait after failure ${i + 1} vs ${i}: ${waits.join(', ')}`).toBeGreaterThan(
        waits[i - 1]!,
      );
    }
  });

  it('agrees with the ladder the domain module specifies, at every step', async () => {
    // The schedule is computed in SQL (it has to share the statement that
    // records the failure), so this is what keeps the SQL and the specification
    // from drifting apart.
    const id = await seed('backoff-spec@test.example.com');
    for (let made = 1; made < EMAIL_MAX_ATTEMPTS; made += 1) {
      // settleClaimedEmail does not count an attempt — the claim already did —
      // so the counter is set to what a claim would have left, and the settle
      // then schedules off it.
      await ctx.pool.query('UPDATE email_outbox SET attempts = $2 WHERE id = $1', [id, made]);
      const startedAt = new Date();
      await settleClaimedEmail(ctx.pool, id, 'failed', 'boom', made);
      const row = await rowOf(id);

      const window = emailRetryWindowMs(made)!;
      const waited = row.next_attempt_at!.getTime() - startedAt.getTime();
      expect(waited, `step ${made} below the ladder's floor`).toBeGreaterThanOrEqual(window.minMs - 1_000);
      expect(waited, `step ${made} above the ladder's step`).toBeLessThanOrEqual(window.maxMs + 5_000);
    }
  });

  it('stops scheduling once the ladder is spent, and the ceiling holds the row', async () => {
    const id = await seed('backoff-terminal@test.example.com');
    await ctx.pool.query('UPDATE email_outbox SET attempts = $2 WHERE id = $1', [id, EMAIL_MAX_ATTEMPTS]);
    await settleClaimedEmail(ctx.pool, id, 'failed', 'boom', EMAIL_MAX_ATTEMPTS);

    const row = await rowOf(id);
    // Null rather than a far-future stamp: terminality is expressed once, by
    // the attempt ceiling, so raising EMAIL_RETRY_MAX_ATTEMPTS can still pick
    // an old row up instead of finding it pinned behind a schedule.
    expect(row.next_attempt_at).toBeNull();

    const delivered: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          delivered.push(e.id);
        },
      },
    });
    expect(delivered).not.toContain(id);
  });

  it('leaves a stranded queued row on the lease, with no backoff to serve', async () => {
    // A 'queued' row past the claim lease is one a crash stranded between the
    // INSERT and the transport call. It has never been attempted, so there is
    // nothing to back off from, and its wait is the lease — the schedule must
    // not be what decides it.
    const id = await seed('stranded@test.example.com');
    await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '1 hour' WHERE id = $1`, [
      id,
    ]);
    expect((await rowOf(id)).next_attempt_at).toBeNull();

    const delivered: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          delivered.push(e.id);
        },
      },
    });
    expect(delivered).toContain(id);
  });

  it('clears the schedule when the row finally sends', async () => {
    const id = await seed('backoff-cleared@test.example.com');
    await markEmail(ctx.pool, id, 'failed', 'smtp connect refused');
    await makeDue(id);
    await retryFailedEmails({ pool: ctx.pool, transport: { async send() {} } });

    const row = await rowOf(id);
    expect(row.next_attempt_at, 'a sent row must not keep a retry schedule').toBeNull();
  });

  /**
   * Two sweepers holding one row, which is the same story `settleDelivery`
   * next door was given in R196 and this settle was not.
   *
   * The lease is a flat fifteen minutes and a batch is up to five hundred rows
   * sent one at a time, so a sweeper still working its batch — or holding a
   * transport call that hangs past the lease — is settling a row a second
   * sweeper has re-claimed. There are three ways to have a second sweeper: the
   * timer, the ops retry route that runs outside it, and a second instance.
   *
   * Written unconditionally, the loser's outcome landed last and landed over a
   * row already settled. The shape that matters is the one below: the winner
   * delivered the mail and stamped `sent_at`, and the loser's late failure put
   * the row back to 'failed' with a fresh place on the ladder — so the next
   * sweep sent the same message again, and the table that is supposed to be the
   * record of what was sent said the send had failed.
   */
  describe('a settle from a claim somebody else has taken over', () => {
    it('is refused, and leaves the winner’s outcome standing', async () => {
      const id = await seed('takeover@test.example.com');

      // The first sweeper's claim: one attempt counted, lease held.
      await ctx.pool.query(
        `UPDATE email_outbox SET status = 'failed', attempts = 1, claimed_at = now() WHERE id = $1`,
        [id],
      );
      // The lease lapses and a second sweeper re-claims — a second attempt
      // counted — then delivers and settles.
      await ctx.pool.query('UPDATE email_outbox SET attempts = 2 WHERE id = $1', [id]);
      expect(await settleClaimedEmail(ctx.pool, id, 'sent', undefined, 2)).toBe(true);

      // Now the first sweeper's hung transport finally reports back.
      const stale = await settleClaimedEmail(ctx.pool, id, 'failed', 'smtp connect refused', 1);
      expect(stale, 'a settle against a superseded claim must not be applied').toBe(false);

      const { rows } = await ctx.pool.query<{
        status: string;
        error: string | null;
        next_attempt_at: Date | null;
        sent_at: Date | null;
      }>('SELECT status, error, next_attempt_at, sent_at FROM email_outbox WHERE id = $1', [id]);
      const row = rows[0]!;
      expect(row.status, 'mail that was delivered must not read as failed').toBe('sent');
      expect(row.sent_at).not.toBeNull();
      expect(row.error).toBeNull();
      // The half that turned a wrong badge into a duplicate delivery.
      expect(row.next_attempt_at, 'a delivered message must not be scheduled again').toBeNull();
    });

    it('still applies while the claim it names is the one on the row', async () => {
      const id = await seed('takeover-live@test.example.com');
      await ctx.pool.query(
        `UPDATE email_outbox SET status = 'failed', attempts = 1, claimed_at = now() WHERE id = $1`,
        [id],
      );
      expect(await settleClaimedEmail(ctx.pool, id, 'sent', undefined, 1)).toBe(true);
    });
  });
});
