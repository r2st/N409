import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, listOutbox, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

/** A transport whose send() always throws, to seed 'failed' outbox rows. */
const failingTransport: EmailTransport = {
  async send() {
    throw new Error('smtp connect refused');
  },
};

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
  await markEmail(ctx.pool, email.id, 'failed', 'smtp connect refused');
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

  it('skips sms-channel rows when no smsTransport is configured', async () => {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: '+15551234567',
      channel: 'sms',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await markEmail(ctx.pool, email.id, 'failed', 'boom');

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
    await markEmail(ctx.pool, email.id, 'failed', 'boom');

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
