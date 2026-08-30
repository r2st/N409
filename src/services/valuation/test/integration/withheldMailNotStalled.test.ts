import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { oldestActiveJobs } from '../../src/repos/jobs.js';
import { enqueueEmail } from '../../src/repos/emailOutbox.js';
import { upsertPreference } from '../../src/repos/notificationPreferences.js';
import { suppressAddress } from '../../src/repos/emailDelivery.js';

const dbUp = await isDbAvailable();

/**
 * What the queue monitor makes of a message the sweep will never take.
 *
 * `oldestActiveJobs` measures how far behind each queue is "from `due_at` — the
 * row's own claim predicate", in its own words. It carried the ladder half of
 * that predicate and none of the other half: the four facts that hold a row
 * back without scheduling it — withdrawn work, a closed account, a suppressed
 * address, a preference switched off.
 *
 * A withheld row is not a queue running late. It sits at `due_at = created_at`
 * and grows older every minute, so one message for a closed account made the
 * outbound queue read as an ever-worsening stall — on the alert whose whole
 * purpose is that one email queued since Thursday means a dead SMTP host. And
 * an alert is keyed `(source, kind)` and announced once, so that row would hold
 * `email/stalled` open for good and the real outage after it would announce
 * nothing at all.
 */
describe.skipIf(!dbUp)('queue monitor — withheld outbox rows', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let user: Awaited<ReturnType<typeof seedUser>>;

  /** A queued row old enough that any age threshold would have fired. */
  const queueOld = async (templateKey: string, promotional = false): Promise<string> => {
    const row = await enqueueEmail(pool, {
      toUserId: user.id,
      toEmail: user.email,
      templateKey,
      subject: 'Subject',
      body: 'Body',
      promotional,
    });
    await pool.query(`UPDATE email_outbox SET created_at = now() - interval '3 days' WHERE id = $1`, [
      row.id,
    ]);
    return row.id;
  };

  const emailQueueAge = async (): Promise<{ oldest: Date; active: number } | null> => {
    const rows = await oldestActiveJobs(pool);
    const email = rows.find((r) => r.source === 'email');
    return email ? { oldest: email.oldest_due_at, active: email.active } : null;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM email_outbox');
    await pool.query('DELETE FROM email_suppressions');
    await pool.query('DELETE FROM notification_preferences');
    await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [user.id]);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('counts a genuinely due message', async () => {
    // The control. Every case below asserts an absence, and an absence is also
    // what a monitor that has stopped seeing this queue at all would report.
    await queueOld('valuation_started');
    expect(await emailQueueAge()).not.toBeNull();
    expect((await emailQueueAge())!.active).toBe(1);
  });

  it('does not count a message for a closed account', async () => {
    await queueOld('valuation_started');
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);
    expect(await emailQueueAge()).toBeNull();
  });

  it('does not count a message to a suppressed address', async () => {
    await queueOld('valuation_started');
    await suppressAddress(pool, { address: user.email, reason: 'hard', detail: 'no such mailbox' });
    expect(await emailQueueAge()).toBeNull();
  });

  it('does not count a promotional message the recipient unsubscribed from', async () => {
    await queueOld('renewal_offer', true);
    await upsertPreference(pool, user.id, 'marketing', { in_app: true, email: false });
    expect(await emailQueueAge()).toBeNull();
  });

  it('counts the queue again once the reason is lifted', async () => {
    // Withheld is reversible — that is why these rows are skipped rather than
    // settled — so the queue has to come back into view with them.
    await queueOld('valuation_started');
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);
    expect(await emailQueueAge()).toBeNull();
    await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [user.id]);
    expect((await emailQueueAge())!.active).toBe(1);
  });

  it('still counts a due message beside a withheld one', async () => {
    // The monitor must subtract the withheld row, not the queue: a real stall
    // arriving while one withheld row sits there has to be visible.
    const second = await seedUser(ctx, { roles: ['valuation_user'] });
    await queueOld('valuation_started');
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);
    await enqueueEmail(pool, {
      toUserId: second.id,
      toEmail: second.email,
      templateKey: 'valuation_started',
      subject: 'Subject',
      body: 'Body',
    });
    const seen = await emailQueueAge();
    expect(seen).not.toBeNull();
    expect(seen!.active).toBe(1);
  });
});
