import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function seedFailedEmail(ctx: TestApp, overrides: Partial<{ toEmail: string }> = {}): Promise<EmailOutboxRow> {
  const email = await enqueueEmail(ctx.pool, {
    toEmail: overrides.toEmail ?? 'client@test.example.com',
    templateKey: 'test_template',
    subject: 'Test',
    body: 'Body',
  });
  await markEmail(ctx.pool, email.id, 'failed', 'smtp connect refused');
  return { ...email, status: 'failed', attempts: email.attempts + 1, error: 'smtp connect refused' };
}

describe.skipIf(!dbUp)('retryFailedEmails', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

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

    const [row] = await listOutbox(ctx.pool, { status: 'sent', limit: 500 });
    expect(row?.id).toBe(email.id);
  });

  it('leaves the row failed and increments attempts when the retry itself fails', async () => {
    const email = await seedFailedEmail(ctx, { toEmail: 'retry-fail@test.example.com' });
    const before = (await listOutbox(ctx.pool, { status: 'failed', limit: 500 })).find((e) => e.id === email.id)!;

    await retryFailedEmails({ pool: ctx.pool, transport: failingTransport });

    const after = (await listOutbox(ctx.pool, { status: 'failed', limit: 500 })).find((e) => e.id === email.id)!;
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

    // Other tests in this file leave their own 'failed' rows behind, so
    // track *which* ids the transport was asked to deliver rather than a
    // bare boolean — this row's id must not be among them.
    const deliveredIds: string[] = [];
    const transport: EmailTransport = {
      async send(e) {
        deliveredIds.push(e.id);
      },
    };
    await retryFailedEmails({ pool: ctx.pool, transport, maxAttempts: 3 });
    expect(deliveredIds).not.toContain(email.id);

    const row = (await listOutbox(ctx.pool, { status: 'failed', limit: 500 })).find((e) => e.id === email.id)!;
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

    const row = (await listOutbox(ctx.pool, { status: 'failed', limit: 500 })).find((e) => e.id === email.id)!;
    expect(row.status).toBe('failed');
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
