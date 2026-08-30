import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import { upsertPreference } from '../../src/repos/notificationPreferences.js';

const dbUp = await isDbAvailable();

/**
 * The retry ladder, against a preference set after the row was queued.
 *
 * Both enqueue paths consult the notification matrix: `onStateChanged` gates a
 * workflow email on the recipient's switch for that template key, and the drip
 * scan gates a promotional one on the `marketing` row. The claim consulted
 * neither, so a message whose first attempt failed was delivered hours later by
 * a sweep that had never asked — the one door into the mailbox a preference did
 * not cover.
 *
 * The marketing half is the one that is a promise rather than a courtesy.
 * `List-Unsubscribe` (RFC 8058) says the sender stops, and the one-click
 * endpoint honours it by writing this row — not by suppressing the address,
 * which is what bounces do. So the sequence is ordinary: a campaign's message
 * arrives, the recipient unsubscribes from it, and the *previous* message —
 * the one whose send had failed — is delivered afterwards by the ladder.
 */
describe.skipIf(!dbUp)('retry sweep — notification preferences', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let user: Awaited<ReturnType<typeof seedUser>>;

  let sent: string[] = [];
  const transport = {
    send: async (email: EmailOutboxRow) => {
      sent.push(email.id);
    },
  };

  /** A row the sweep will treat as due: failed once, ladder clear. */
  const queueFailed = async (input: {
    templateKey: string;
    promotional?: boolean;
    toUserId?: string | null;
  }): Promise<string> => {
    const row = await enqueueEmail(pool, {
      toUserId: input.toUserId === undefined ? user.id : input.toUserId,
      toEmail: user.email,
      templateKey: input.templateKey,
      subject: 'Subject',
      body: 'Body',
      promotional: input.promotional ?? false,
    });
    await pool.query(
      `UPDATE email_outbox SET status = 'failed', attempts = 1, next_attempt_at = NULL WHERE id = $1`,
      [row.id],
    );
    return row.id;
  };

  const sweep = async (): Promise<string[]> => {
    sent = [];
    await retryFailedEmails({ pool, transport });
    return sent;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('does not deliver a promotional message after the recipient unsubscribed', async () => {
    const id = await queueFailed({ templateKey: 'renewal_offer', promotional: true });
    // Exactly what POST /api/v1/unsubscribe writes: the marketing row, email
    // off, in-app untouched.
    await upsertPreference(pool, user.id, 'marketing', { in_app: true, email: false });

    expect(await sweep()).not.toContain(id);
    const { rows } = await pool.query<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = $1', [id]);
    // Skipped, not settled: switching marketing back on must be able to make
    // this claimable again, which a 'failed' stamp could not undo.
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.attempts).toBe(1);
  });

  it('delivers it again once marketing is switched back on', async () => {
    const id = await queueFailed({ templateKey: 'renewal_offer', promotional: true });
    await upsertPreference(pool, user.id, 'marketing', { in_app: true, email: true });
    expect(await sweep()).toContain(id);
  });

  it('does not deliver a workflow email the recipient turned off', async () => {
    const id = await queueFailed({ templateKey: 'valuation_started' });
    await upsertPreference(pool, user.id, 'valuation_started', { in_app: true, email: false });
    expect(await sweep()).not.toContain(id);
  });

  it('still delivers a transactional must-send', async () => {
    // A password reset has no row in the matrix and never can: the settings
    // screen writes only the declared event types. The clause must not become
    // a way to switch off the mail that gets an account back.
    const id = await queueFailed({ templateKey: 'password_reset' });
    await upsertPreference(pool, user.id, 'marketing', { in_app: true, email: false });
    await upsertPreference(pool, user.id, 'valuation_started', { in_app: true, email: false });
    expect(await sweep()).toContain(id);
  });

  it('still delivers to an address with no account behind it', async () => {
    // An invitation is addressed to someone who has no user row yet, so there
    // are no preferences to read — and a NULL `to_user_id` must not make the
    // NOT EXISTS accidentally true or accidentally false.
    const id = await queueFailed({ templateKey: 'user_invitation', toUserId: null });
    expect(await sweep()).toContain(id);
  });
});
