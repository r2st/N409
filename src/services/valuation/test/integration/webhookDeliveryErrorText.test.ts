import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWebhook } from '../../src/repos/partnerWebhooks.js';
import { deliverToWebhook } from '../../src/hooks/partnerWebhooks.js';
import { newWebhookSecret } from '../../src/domain/partnerWebhooks.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The one line a partner gets to debug their own endpoint with.
 *
 * A delivery row is written before the attempt and its `last_error` column is what
 * `GET /webhooks/{id}/deliveries` shows the partner. For every transport
 * failure — a refused connection, a DNS record that was deleted, an expired
 * certificate, a socket reset mid-exchange — Node's `fetch` rejects with the
 * same `TypeError: fetch failed`, and this recorded `err.message`. So a partner
 * whose certificate expired overnight read "fetch failed", which names no
 * condition, suggests nothing, and is identical to the row above it.
 *
 * The identifying fact was one property away the whole time: undici puts the
 * syscall error on `cause`, which `classifyFailure` has always walked in order
 * to decide whether to retry — and then discarded on the way out.
 *
 * These run against the real column rather than against the helper, because the
 * helper passing is not the claim: the claim is that what the partner reads has
 * changed, and between the two sits a `settle` that could just as easily be
 * writing something else.
 */
describe.skipIf(!dbUp)('what the partner delivery log says a failure was', () => {
  let ctx: TestApp;
  let webhookId: string;

  /** A `TypeError: fetch failed` with `cause` set, exactly as undici raises it. */
  const transportFailure = (code: string): Error => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
    return err;
  };

  const deliverAndReadError = async (): Promise<string> => {
    const webhook = (await ctx.pool.query('SELECT * FROM partner_webhooks WHERE id = $1', [webhookId]))
      .rows[0];
    await deliverToWebhook(
      { pool: ctx.pool, allowPrivateTargets: true },
      { ...webhook, secret: 'unused-here' },
      'valuation.report_ready',
      { event: 'valuation.report_ready' },
    );
    const { rows } = await ctx.pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM partner_webhook_deliveries
        WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [webhookId],
    );
    return rows[0]?.last_error ?? '';
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    const partnerId = await seedPartner(ctx, `Webhook Firm ${Date.now()}`);
    const admin = await seedUser(ctx, { roles: ['org_admin'], partnerId });
    const webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'https://receiver.example.com/n409',
      secret: newWebhookSecret(),
      events: ['valuation.report_ready'],
      createdBy: admin.id,
    });
    webhookId = webhook.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('names a refused connection instead of saying "fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportFailure('ECONNREFUSED')));
    const error = await deliverAndReadError();

    expect(error).not.toBe('fetch failed');
    expect(error).toContain('connection was refused');
  });

  it('names a deleted DNS record, and says where to look', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportFailure('ENOTFOUND')));
    const error = await deliverAndReadError();

    expect(error).toContain('does not resolve');
    expect(error).toMatch(/typo|DNS/);
  });

  it('names an expired certificate, which is the fix as well as the cause', async () => {
    // The case that makes this worth doing. Nobody looks at a webhook log
    // because everything is fine; they look because deliveries stopped, and
    // "the TLS certificate has expired" ends the investigation on the spot.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportFailure('CERT_HAS_EXPIRED')));
    const error = await deliverAndReadError();

    expect(error).toContain('certificate has expired');
    expect(error).toMatch(/renew/i);
  });

  it('still records a receiver that answered in the receiver’s own terms', async () => {
    // The guard against this becoming a flattener. A receiver that replied has
    // said something specific, and the status is the whole message.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 410, statusText: 'Gone' })),
    );
    expect(await deliverAndReadError()).toBe('receiver responded 410');
  });

  it('records a deadline as a deadline, not as a refusal', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

    expect(await deliverAndReadError()).toContain('did not respond in time');
  });
});
