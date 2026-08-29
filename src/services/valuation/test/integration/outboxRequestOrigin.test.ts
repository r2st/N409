/**
 * The one place work crosses from a request into a sweep.
 *
 * A receipt is queued inside the Stripe webhook and, if SMTP is down at that
 * moment, delivered minutes later by the email retry sweep. Those were two log
 * lines with nothing in common: the enqueue side carries `requestId` and never
 * names the row, the retry side carries `emailId` and could not know what asked
 * for it. So the chain an incident is reconstructed along — Stripe event,
 * payment update, notification — stopped at the outbox and could not be picked
 * up on the far side.
 *
 * `email_outbox.request_id` (migration 0185) is the handoff, read off the
 * AsyncLocalStorage at the insert rather than threaded through the dozen
 * callers, several of which are three frames from a route.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithRequestId, runWithSweep } from '@n409/shared';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { enqueueEmail, markEmail } from '../../src/repos/emailOutbox.js';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';
import type { EmailTransport } from '../../src/hooks/stateChange.js';

const dbUp = await isDbAvailable();

const failingTransport: EmailTransport = {
  async send() {
    throw new Error('smtp connect refused');
  },
};

describe.skipIf(!dbUp)('what queued an outbox row', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const queue = (toEmail: string) =>
    enqueueEmail(ctx.pool, {
      toEmail,
      templateKey: 'payment_receipt',
      subject: 'Receipt',
      body: 'Body',
    });

  it('records the request that queued it', async () => {
    const row = await runWithRequestId('REQ-OUTBOX-1', () => queue('one@test.example.com'));
    expect(row.request_id).toBe('REQ-OUTBOX-1');
  });

  it('records nothing for a row a sweep queued, because nobody asked for it', async () => {
    // The drip scan's rows. A minted id here would appear in no other service's
    // logs and would make "no request_id" stop meaning "not caused by one".
    const row = await runWithSweep({ name: 'auto-email', runId: 'RUN-1' }, () =>
      queue('two@test.example.com'),
    );
    expect(row.request_id).toBeNull();
  });

  it('carries the origin onto the sweep line that reports a failed retry', async () => {
    // The join the whole column exists for: this line is written under a sweep
    // and so has no `requestId` of its own — correctly, nothing asked for it —
    // and `originRequestId` reaches back across the handoff.
    const row = await runWithRequestId('REQ-OUTBOX-3', () => queue('three@test.example.com'));
    await markEmail(ctx.pool, row.id, 'failed', 'smtp connect refused');
    await ctx.pool.query('UPDATE email_outbox SET next_attempt_at = NULL WHERE id = $1', [row.id]);

    const warnings: Array<Record<string, unknown>> = [];
    const log = {
      warn: (obj: Record<string, unknown>) => warnings.push(obj),
      error: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as Parameters<typeof retryFailedEmails>[0]['log'];

    const result = await retryFailedEmails({ pool: ctx.pool, transport: failingTransport, log });
    expect(result.attempted).toBeGreaterThanOrEqual(1);

    const line = warnings.find((w) => w.emailId === row.id);
    expect(line, 'the retry failure was not logged').toBeDefined();
    expect(line!.originRequestId).toBe('REQ-OUTBOX-3');
  });
});
