import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, listOutbox, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

/**
 * The retry sweep runs from two places — the interval in index.ts and the
 * ops-facing POST /admin/outbox/retry — and a deployment can run more than one
 * instance of the service. Selecting the candidate rows and sending them were
 * separate steps with nothing in between marking a row as taken, so any two
 * sweepers that overlapped delivered the same backlog twice.
 */
describe.skipIf(!dbUp)('retry sweep claiming', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  // Every case here reasons about *which* rows a sweep picks up, so it must
  // start from an outbox with nothing retryable left over from the last one.
  beforeEach(async () => {
    await ctx.pool.query(`UPDATE email_outbox SET status = 'sent', claimed_at = NULL`);
  });

  /**
   * Fails a row and brings its retry schedule forward.
   *
   * A failed row carries `next_attempt_at` since migration 0159, so it is not
   * claimable until its backoff elapses (emailRetryBackoff.test.ts pins that).
   * The cases here are about two sweepers racing for a row both may take, so
   * they clear the stamp rather than sleep through the ladder.
   */
  async function failAndMakeDue(id: string, error: string): Promise<void> {
    await markEmail(ctx.pool, id, 'failed', error);
    await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [id]);
  }

  let seq = 0;
  async function seedFailed(prefix: string): Promise<EmailOutboxRow> {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: `${prefix}-${seq++}@test.example.com`,
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await failAndMakeDue(email.id, 'smtp connect refused');
    return email;
  }

  /** Records every delivery and holds each send open until `release` is called. */
  function gatedTransport(): { transport: EmailTransport; delivered: string[]; release: () => void } {
    const delivered: string[] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      delivered,
      release: () => open(),
      transport: {
        async send(e) {
          delivered.push(e.id);
          await gate;
        },
      },
    };
  }

  it('delivers each failed row once when two sweeps overlap', async () => {
    const email = await seedFailed('overlap');
    const a = gatedTransport();
    const b = gatedTransport();

    const sweeps = Promise.all([
      retryFailedEmails({ pool: ctx.pool, transport: a.transport }),
      retryFailedEmails({ pool: ctx.pool, transport: b.transport }),
    ]);
    // Let both sweeps get as far as their candidate query before either send
    // finishes — the window the old code left open.
    await new Promise((r) => setTimeout(r, 50));
    a.release();
    b.release();
    const [first, second] = await sweeps;

    const attempts = [...a.delivered, ...b.delivered].filter((id) => id === email.id);
    expect(attempts).toHaveLength(1);
    expect(first.sent + second.sent).toBe(1);

    const row = (await listOutbox(ctx.pool, { limit: 500 })).find((e) => e.id === email.id)!;
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2); // the original failure, plus this delivery
  });

  it('splits a backlog between concurrent sweeps rather than duplicating it', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) ids.add((await seedFailed('backlog')).id);

    const a = gatedTransport();
    const b = gatedTransport();
    const sweeps = Promise.all([
      retryFailedEmails({ pool: ctx.pool, transport: a.transport }),
      retryFailedEmails({ pool: ctx.pool, transport: b.transport }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    a.release();
    b.release();
    await sweeps;

    const all = [...a.delivered, ...b.delivered].filter((id) => ids.has(id));
    expect(new Set(all).size).toBe(all.length); // no id delivered twice
  });

  it('retries oldest-first so a long backlog cannot starve the earliest rows', async () => {
    const oldest = await seedFailed('starve');
    await ctx.pool.query(`UPDATE email_outbox SET created_at = now() - interval '3 days' WHERE id = $1`, [
      oldest.id,
    ]);
    for (let i = 0; i < 4; i++) await seedFailed('starve-newer');

    const delivered: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          delivered.push(e.id);
        },
      },
      limit: 2,
    });
    expect(delivered).toContain(oldest.id);
  });

  it('holds a claim for the lease, then releases it if the sweeper never settled it', async () => {
    const email = await seedFailed('lease');
    // A sweeper that claims the row and dies mid-send: claim it, then throw
    // away the result without settling.
    const crashed = gatedTransport();
    void retryFailedEmails({ pool: ctx.pool, transport: crashed.transport }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(crashed.delivered).toContain(email.id);

    // While the lease is live nobody else picks it up.
    const during: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          during.push(e.id);
        },
      },
    });
    expect(during).not.toContain(email.id);

    // Once the lease expires the row is retryable again.
    await ctx.pool.query(`UPDATE email_outbox SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [
      email.id,
    ]);
    const after: string[] = [];
    await retryFailedEmails({
      pool: ctx.pool,
      transport: {
        async send(e) {
          after.push(e.id);
        },
      },
    });
    expect(after).toContain(email.id);
    crashed.release();
  });

  it('does not burn an attempt on a channel it has no transport for', async () => {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: '+15550001111',
      channel: 'sms',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await failAndMakeDue(email.id, 'boom');
    const before = (await listOutbox(ctx.pool, { limit: 500 })).find((e) => e.id === email.id)!;

    await retryFailedEmails({ pool: ctx.pool, transport: { async send() {} } });

    const after = (await listOutbox(ctx.pool, { limit: 500 })).find((e) => e.id === email.id)!;
    expect(after.attempts).toBe(before.attempts);
    expect(after.status).toBe('failed');
  });

  it('reports only what it actually attempted', async () => {
    const email = await seedFailed('accounting');
    const result = await retryFailedEmails({
      pool: ctx.pool,
      transport: { async send() {} },
      limit: 50,
    });
    expect(result.sent).toBeLessThanOrEqual(result.attempted);
    const row = (await listOutbox(ctx.pool, { limit: 500 })).find((e) => e.id === email.id)!;
    expect(row.status).toBe('sent');
  });
});

describe.skipIf(!dbUp)('POST /api/v1/admin/outbox/retry racing itself', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  it('counts a doubly-clicked retry once', async () => {
    const email = await enqueueEmail(ctx.pool, {
      toEmail: 'double-click@test.example.com',
      templateKey: 'test_template',
      subject: 'Test',
      body: 'Body',
    });
    await markEmail(ctx.pool, email.id, 'failed', 'boom');
    // Past its backoff (0159) — this case is about two requests racing for one
    // claimable row, not about when the row becomes claimable.
    await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [email.id]);

    const fire = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/outbox/retry',
        headers: authHeader(ops.token),
      });
    const [a, b] = await Promise.all([fire(), fire()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().sent + b.json().sent).toBe(1);

    const row = (await listOutbox(ctx.pool, { limit: 500 })).find((e) => e.id === email.id)!;
    expect(row.attempts).toBe(2);
  });
});
