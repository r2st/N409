import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, markEmail } from '../../src/repos/emailOutbox.js';
import { restoreUser, softDeleteUser } from '../../src/repos/adminUsers.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

/**
 * Mail is not sent to an account that has been closed.
 *
 * `DELETE /api/v1/me` revokes the tokens, bumps the session epoch and soft-
 * deletes the `users` row — and did nothing about mail already sitting in the
 * outbox addressed to that person. A notification queued the hour before, whose
 * first transport attempt failed, was delivered by the retry ladder afterwards:
 * a message sent to somebody after we agreed to stop holding their account,
 * which is not a delay but a send.
 *
 * The engagement side of this rule was closed in R89 — a reminder about a
 * withdrawn piece of work is skipped by the same claim — and the auto-email
 * scanner has always filtered `u.deleted_at IS NULL` on the way in. Between
 * them they made the gap invisible: nothing is *enqueued* for a closed account,
 * so the only way to reach it is a row that was enqueued before the closing.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('mail addressed to a closed account', () => {
  let ctx: TestApp;
  const sent: string[] = [];

  /** Records what it is handed; the retry sweep settles the row as 'sent'. */
  const recordingTransport: EmailTransport = {
    async send(email) {
      sent.push(email.to_email);
    },
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    sent.length = 0;
    await ctx.pool.query('DELETE FROM email_outbox');
  });

  /** A failed row addressed to `userId`, with its backoff cleared so it is due. */
  async function failedMailFor(userId: string | null, toEmail: string) {
    const row = await enqueueEmail(ctx.pool, {
      toEmail,
      toUserId: userId,
      templateKey: 'test_template',
      subject: 'Your valuation is ready',
      body: 'Body',
    });
    await markEmail(ctx.pool, row.id, 'failed', 'smtp connect refused');
    await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [row.id]);
    return row;
  }

  const statusOf = async (id: string) =>
    (await ctx.pool.query<{ status: string }>('SELECT status FROM email_outbox WHERE id = $1', [id])).rows[0]!
      .status;

  it('is not delivered by the retry sweep after the account is closed', async () => {
    const user = await seedUser(ctx, { roles: [] });
    const mail = await failedMailFor(user.id, user.email);

    expect(await softDeleteUser(ctx.pool, user.id)).toBe(true);
    const result = await retryFailedEmails({ pool: ctx.pool, transport: recordingTransport });

    expect(sent).not.toContain(user.email);
    expect(result.sent).toBe(0);
    expect(await statusOf(mail.id)).toBe('failed');
  });

  it('is skipped rather than settled, so restoring the account restores the mail', async () => {
    // The same reasoning the archival clause carries: `restoreUser` puts the
    // account back, and a row marked failed by this guard could not be
    // un-failed by that. The row simply stops being claimable.
    const user = await seedUser(ctx, { roles: [] });
    const mail = await failedMailFor(user.id, user.email);
    await softDeleteUser(ctx.pool, user.id);
    await retryFailedEmails({ pool: ctx.pool, transport: recordingTransport });
    expect(sent).toHaveLength(0);

    expect(await restoreUser(ctx.pool, user.id)).toBe(true);
    await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [mail.id]);
    await retryFailedEmails({ pool: ctx.pool, transport: recordingTransport });

    expect(sent).toContain(user.email);
    expect(await statusOf(mail.id)).toBe('sent');
  });

  it('still delivers to a live account', async () => {
    // The guard must not be the reason ordinary mail stops. Without this the
    // clause above could be inverted, or match every row, and the first test
    // would still pass.
    const user = await seedUser(ctx, { roles: [] });
    const mail = await failedMailFor(user.id, user.email);

    await retryFailedEmails({ pool: ctx.pool, transport: recordingTransport });

    expect(sent).toContain(user.email);
    expect(await statusOf(mail.id)).toBe('sent');
  });

  it('still delivers to an address with no account behind it', async () => {
    // An invitation, or a client contact mailed an intake link: there is no
    // `to_user_id`, so there is no account to have closed. A NOT EXISTS that
    // caught NULL would have silently stopped every one of those.
    const mail = await failedMailFor(null, 'prospect@test.example.com');

    await retryFailedEmails({ pool: ctx.pool, transport: recordingTransport });

    expect(sent).toContain('prospect@test.example.com');
    expect(await statusOf(mail.id)).toBe('sent');
  });

  it('is not delivered after the account closes itself', async () => {
    // End to end through the route a person actually uses, rather than through
    // the repo the previous cases call: the guard has to hold for the door the
    // product offers.
    const user = await seedUser(ctx, { roles: [] });
    const mail = await failedMailFor(user.id, user.email);

    const closed = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: authHeader(user.token),
      payload: { current_password: 'test-password-123' },
    });
    expect(closed.statusCode).toBe(204);

    await retryFailedEmails({ pool: ctx.pool, transport: recordingTransport });
    expect(sent).not.toContain(user.email);
    expect(await statusOf(mail.id)).toBe('failed');
  });
});
