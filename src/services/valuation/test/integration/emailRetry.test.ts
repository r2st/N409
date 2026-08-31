import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { oldestActiveJobs } from '../../src/repos/jobs.js';
import { enqueueEmail, listOutbox, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

/** A transport whose send() always throws, to seed 'failed' outbox rows. */
const failingTransport: EmailTransport = {
  async send() {
    throw new Error('smtp connect refused');
  },
};

/**
 * Fails a row and brings its retry schedule forward.
 *
 * A failed row carries `next_attempt_at` since migration 0159, so it is not
 * claimable until its backoff has elapsed. *When* a row comes back is the
 * subject of emailRetryBackoff.test.ts; the cases in this file are about what a
 * sweep does with a row it is allowed to take, so they wait the ladder out by
 * clearing the stamp rather than by sleeping through it.
 *
 * Written as a helper rather than folded into the `beforeEach` reset because
 * the reset runs before the seeding, and a stamp cleared before it is written
 * is not cleared at all.
 */
async function failAndMakeDue(ctx: TestApp, id: string, error: string): Promise<void> {
  await markEmail(ctx.pool, id, 'failed', error);
  await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [id]);
}

async function seedFailedEmail(
  ctx: TestApp,
  overrides: Partial<{ toEmail: string }> = {},
): Promise<EmailOutboxRow> {
  const email = await enqueueEmail(ctx.pool, {
    toEmail: overrides.toEmail ?? 'client@test.example.com',
    templateKey: 'test_template',
    subject: 'Test',
    body: 'Body',
  });
  await failAndMakeDue(ctx, email.id, 'smtp connect refused');
  return { ...email, status: 'failed', attempts: email.attempts + 1, error: 'smtp connect refused' };
}

/**
 * A 'queued' row backdated past the claim lease — what a process killed between
 * the outbox INSERT and the transport call leaves behind. Backdated in SQL
 * rather than by shrinking `leaseMs`, because the lease is also the window that
 * protects an in-flight send, and a test that shrinks it stops pinning that.
 */
async function seedStrandedQueuedEmail(ctx: TestApp, toEmail: string): Promise<EmailOutboxRow> {
  const email = await enqueueEmail(ctx.pool, {
    toEmail,
    templateKey: 'test_template',
    subject: 'Test',
    body: 'Body',
  });
  await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '1 hour' WHERE id = $1`, [
    email.id,
  ]);
  return email;
}

/** The row with this id, whatever else the outbox is holding. */
async function outboxRow(ctx: TestApp, id: string): Promise<EmailOutboxRow> {
  const row = (await listOutbox(ctx.pool, { limit: 500 })).find((e) => e.id === id);
  if (!row) throw new Error(`outbox row ${id} not found`);
  return row;
}

describe.skipIf(!dbUp)('retryFailedEmails', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  // The app, and so the outbox, is shared by every case in this describe.
  // Each one reasons about which rows a sweep picks up, so it has to start
  // from an outbox with nothing retryable left behind by the last: a case that
  // leaves a 'failed' row behind is otherwise swept again by the next, whose
  // own row is then not the only thing the transport was handed.
  beforeEach(async () => {
    await ctx.pool.query(`UPDATE email_outbox SET status = 'sent', claimed_at = NULL`);
  });

  it('resends a failed row and marks it sent', async () => {
    const email = await seedFailedEmail(ctx);
    let delivered: EmailOutboxRow | undefined;
    const transport: EmailTransport = {
      async send(e) {
        delivered = e;
      },
    };

    const result = await retryFailedEmails({ pool: ctx.pool, transport });
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(delivered?.id).toBe(email.id);

    // By id, not by position: listOutbox orders newest-first over the whole
    // table, so asserting on the first 'sent' row pins this case to the order
    // the file's other cases happen to run in.
    expect((await outboxRow(ctx, email.id)).status).toBe('sent');
  });

  it('leaves the row failed and increments attempts when the retry itself fails', async () => {
    const email = await seedFailedEmail(ctx, { toEmail: 'retry-fail@test.example.com' });
    const before = await outboxRow(ctx, email.id);

    await retryFailedEmails({ pool: ctx.pool, transport: failingTransport });

    const after = await outboxRow(ctx, email.id);
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(before.attempts + 1);
  });

  it('does not retry a row that has already hit maxAttempts', async () => {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: 'exhausted@test.example.com',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    // Fail it up to the cap.
    for (let i = 0; i < 3; i++) await markEmail(ctx.pool, email.id, 'failed', 'boom');

    // Track *which* ids the transport was asked to deliver rather than a bare
    // boolean: "the sweep delivered nothing" would also pass if the sweep had
    // simply found nothing to do, which is not what this pins.
    const deliveredIds: string[] = [];
    const transport: EmailTransport = {
      async send(e) {
        deliveredIds.push(e.id);
      },
    };
    await retryFailedEmails({ pool: ctx.pool, transport, maxAttempts: 3 });
    expect(deliveredIds).not.toContain(email.id);

    const row = await outboxRow(ctx, email.id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
  });

  /**
   * A suppression that arrived after the row did.
   *
   * `enqueueEmail` asks whether the address is suppressed; the claim did not.
   * It read only the row's own `bounce_kind`, which is what that row's own
   * attempt learned — so an address suppressed by *another* message's hard
   * bounce, by a provider webhook reporting a complaint, or by an operator
   * adding it to the list on purpose still had every message already sitting
   * queued or failed for it delivered by the ladder.
   */
  describe('an address suppressed after the row was written', () => {
    const suppress = (address: string) =>
      ctx.pool.query(
        `INSERT INTO email_suppressions (to_email, reason) VALUES ($1, 'hard')
         ON CONFLICT (to_email) DO UPDATE SET released_at = NULL`,
        [address],
      );

    it('is not mailed by the ladder', async () => {
      const email = await seedFailedEmail(ctx, { toEmail: 'gone@test.example.com' });
      await suppress('gone@test.example.com');
      const sent: string[] = [];

      await retryFailedEmails({
        pool: ctx.pool,
        transport: {
          async send(e) {
            sent.push(e.id);
          },
        },
      });

      expect(sent).not.toContain(email.id);
      // Skipped, not settled: a release is something an operator does, and a
      // row marked failed here could not be un-failed by one.
      expect((await outboxRow(ctx, email.id)).status).toBe('failed');
    });

    it('is mailed again once the suppression is released', async () => {
      const email = await seedFailedEmail(ctx, { toEmail: 'back@test.example.com' });
      await suppress('back@test.example.com');
      await retryFailedEmails({ pool: ctx.pool, transport: failingTransport });

      await ctx.pool.query('UPDATE email_suppressions SET released_at = now() WHERE to_email = $1', [
        'back@test.example.com',
      ]);
      await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [email.id]);
      const sent: string[] = [];
      await retryFailedEmails({
        pool: ctx.pool,
        transport: {
          async send(e) {
            sent.push(e.id);
          },
        },
      });

      expect(sent).toContain(email.id);
    });

    it('still delivers the one message that proves an address good again', async () => {
      // `email_verification` is exempt at enqueue for a reason that applies
      // exactly as much here: suppressed, a wrongly-listed address could never
      // be cleared from the user's own side.
      const email = await enqueueEmail(ctx.pool, {
        toEmail: 'exempt@test.example.com',
        templateKey: 'email_verification',
        subject: 'Verify your email',
        body: 'Body',
      });
      await failAndMakeDue(ctx, email.id, 'smtp connect refused');
      await suppress('exempt@test.example.com');
      const sent: string[] = [];

      await retryFailedEmails({
        pool: ctx.pool,
        transport: {
          async send(e) {
            sent.push(e.id);
          },
        },
      });

      expect(sent).toContain(email.id);
    });
  });

  it('skips sms-channel rows when no smsTransport is configured', async () => {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: '+15551234567',
      channel: 'sms',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await failAndMakeDue(ctx, email.id, 'boom');

    const deliveredIds: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          deliveredIds.push(e.id);
        },
      },
    });
    expect(deliveredIds).not.toContain(email.id);

    const row = await outboxRow(ctx, email.id);
    expect(row.status).toBe('failed');
    // Nothing tried to deliver it, so nothing may have spent one of its tries.
    expect(row.attempts).toBe(1);
  });

  // ── Rows a crash stranded on 'queued' ──────────────────────────────────
  //
  // Every send path writes the outbox row and *then* hands it to the transport,
  // so a process killed in that window (deploy SIGTERM, OOM, eviction) leaves a
  // row on 'queued' that no code path revisits. The row exists precisely so the
  // mail is not lost there, so the sweep has to be what comes back for it.

  it('resends a row a crash stranded on queued past the lease', async () => {
    const email = await seedStrandedQueuedEmail(ctx, 'stranded@test.example.com');

    const deliveredIds: string[] = [];
    const result = await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          deliveredIds.push(e.id);
        },
      },
    });

    expect(deliveredIds).toContain(email.id);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect((await outboxRow(ctx, email.id)).status).toBe('sent');
  });

  it('leaves a freshly queued row alone so an in-flight send is not duplicated', async () => {
    // Not backdated: this is the row whose original send is still running.
    const email = await enqueueEmail(ctx.pool, {
      toEmail: 'inflight@test.example.com',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });

    const deliveredIds: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          deliveredIds.push(e.id);
        },
      },
    });

    expect(deliveredIds).not.toContain(email.id);
    const row = await outboxRow(ctx, email.id);
    expect(row.status).toBe('queued');
    // Untouched means untouched: claiming it would have burned an attempt.
    expect(row.attempts).toBe(0);
  });

  it('marks a stranded queued row failed when the resend fails, so the next sweep retries it', async () => {
    const email = await seedStrandedQueuedEmail(ctx, 'stranded-fail@test.example.com');

    await retryFailedEmails({ pool: ctx.pool, transport: failingTransport });

    const after = await outboxRow(ctx, email.id);
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(1);
    // The lease is released on settlement, so this is retryable immediately —
    // a stranded row must not land in a state that waits a lease out.
    expect(after.claimed_at).toBeNull();
  });

  it('honours the attempts cap for stranded queued rows too', async () => {
    const email = await seedStrandedQueuedEmail(ctx, 'stranded-exhausted@test.example.com');
    await ctx.pool.query(`UPDATE email_outbox SET attempts = 3 WHERE id = $1`, [email.id]);

    const deliveredIds: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      maxAttempts: 3,
      transport: {
        async send(e) {
          deliveredIds.push(e.id);
        },
      },
    });

    expect(deliveredIds).not.toContain(email.id);
    expect((await outboxRow(ctx, email.id)).attempts).toBe(3);
  });

  /**
   * The ceiling has to *end* a row, not abandon it (round 272, methodology M3).
   *
   * A 'failed' row past `maxAttempts` is finished, and every reader agrees it is
   * — that is what "a genuinely undeliverable address exhausts the ladder and
   * settles" means in domain/emailRetry.ts. A 'queued' row reaching the same
   * ceiling was left wearing the status of work about to be done: the claim
   * refuses it on `attempts < maxAttempts`, `purgeExpiredOutbox` refuses it on
   * `status <> 'queued'` — on the stated ground that a stranded queued row is
   * what the retry sweep picks up — and `oldestActiveJobs` counts it, at
   * `due_at = created_at`, getting older every minute. An open alert is keyed
   * `(source, kind)` and announced once, so one such row holds `email/stalled`
   * open for ever and the next real outage announces nothing: R228's finding
   * about withheld rows, through the one door R228 did not close.
   */
  it('settles a stranded queued row whose attempts are spent, rather than leaving it queued for ever', async () => {
    const email = await seedStrandedQueuedEmail(ctx, 'stranded-terminal@test.example.com');
    await ctx.pool.query(`UPDATE email_outbox SET attempts = 3 WHERE id = $1`, [email.id]);

    const emailQueue = async () =>
      (await oldestActiveJobs(ctx.pool)).find((r) => r.source === 'email')?.active ?? 0;
    // It is counted as a queue running late, and nothing will ever take it.
    expect(await emailQueue()).toBeGreaterThan(0);

    const deliveredIds: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      maxAttempts: 3,
      transport: {
        async send(e) {
          deliveredIds.push(e.id);
        },
      },
    });

    // Settled, not sent: the ladder is spent, so the ending is a failure with a
    // reason on it — visible on the queue page, retryable by hand.
    expect(deliveredIds).not.toContain(email.id);
    const row = await outboxRow(ctx, email.id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(row.next_attempt_at).toBeNull();
    expect(row.error).toMatch(/out of attempts/);
    expect(await emailQueue()).toBe(0);
  });
});

describe.skipIf(!dbUp)('POST /api/v1/admin/outbox/retry', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('denies non-ops principals', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/outbox/retry',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('retries failed rows through the log transport (EMAIL_MODE=log by default)', async () => {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: 'admin-route@test.example.com',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await failAndMakeDue(ctx, email.id, 'boom');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/outbox/retry',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBeGreaterThanOrEqual(1);

    const row = (await listOutbox(ctx.pool, { status: 'sent', limit: 500 })).find((e) => e.id === email.id);
    expect(row).toBeDefined();
  });
});
