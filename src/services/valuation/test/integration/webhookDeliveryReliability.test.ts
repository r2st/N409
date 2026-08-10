import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_BACKOFF_MINUTES } from '../../src/domain/partnerWebhooks.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Delivery reliability end-to-end: what the scheduler does with a receiver that
 * is rate-limiting us, and what it does with a backlog.
 *
 * The unit tests pin the arithmetic. These exist because the interesting part
 * is the plumbing — whether the header actually reaches the scheduler through
 * fetch, the attempt result and the settle path, and whether the row in the
 * database ends up with the time the receiver asked for.
 */
describe.skipIf(!dbUp)('webhook delivery reliability', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let apiKey: string;
  let receiver: FastifyInstance;
  let receiverUrl: string;
  /** What the receiver answers, and what (if anything) it asks us to wait. */
  let receiverStatus = 200;
  let retryAfter: string | null = null;

  const keyHeader = () => ({ authorization: `Bearer ${apiKey}` });

  const registerWebhook = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(),
      payload: { url: receiverUrl },
    });
    expect(res.statusCode).toBe(201);
    return res.json().webhook.id as string;
  };

  const ping = async (webhookId: string): Promise<void> => {
    await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(),
    });
  };

  beforeAll(async () => {
    ctx = await setupTestApp(
      { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    app = ctx.app;
    const partnerId = await seedPartner(ctx, 'Reliability Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'reliability' },
    });
    apiKey = minted.json().secret as string;

    receiver = Fastify({ logger: false });
    receiver.post('/hook', async (_req, reply) => {
      if (retryAfter !== null) void reply.header('retry-after', retryAfter);
      return reply.status(receiverStatus).send({ ok: receiverStatus < 400 });
    });
    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = receiver.server.address();
    if (typeof address === 'object' && address) receiverUrl = `http://127.0.0.1:${address.port}/hook`;
  }, 60_000);

  afterAll(async () => {
    await receiver?.close();
    await ctx?.teardown();
  });

  /** The scheduled wait, in ms, for the one delivery of a freshly-made webhook. */
  const scheduledDelayMs = async (webhookId: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ created_at: Date; next_attempt_at: Date; status: string }>(
      `SELECT d.created_at, d.next_attempt_at, d.status
         FROM partner_webhook_deliveries d
        WHERE d.webhook_id = $1
        ORDER BY d.created_at DESC
        LIMIT 1`,
      [webhookId],
    );
    expect(rows[0]?.status).toBe('pending');
    return rows[0]!.next_attempt_at.getTime() - rows[0]!.created_at.getTime();
  };

  it('waits as long as a 429 asked, not the ladder', async () => {
    const webhookId = await registerWebhook();
    receiverStatus = 429;
    retryAfter = '900';
    await ping(webhookId);
    receiverStatus = 200;
    retryAfter = null;

    // The ladder's first step is one minute. Coming back then would be
    // rate-limited again and would burn an attempt on a request the receiver
    // already told us would fail.
    const delay = await scheduledDelayMs(webhookId);
    expect(delay).toBeGreaterThan(14 * 60_000);
    expect(delay).toBeLessThan(16 * 60_000);
  });

  it('honours Retry-After on a 503 too, and its HTTP-date form', async () => {
    const webhookId = await registerWebhook();
    receiverStatus = 503;
    retryAfter = new Date(Date.now() + 20 * 60_000).toUTCString();
    await ping(webhookId);
    receiverStatus = 200;
    retryAfter = null;

    const delay = await scheduledDelayMs(webhookId);
    expect(delay).toBeGreaterThan(18 * 60_000);
    expect(delay).toBeLessThan(22 * 60_000);
  });

  it('clamps a Retry-After that would park the event for a month', async () => {
    const webhookId = await registerWebhook();
    receiverStatus = 503;
    retryAfter = String(30 * 24 * 3600);
    await ping(webhookId);
    receiverStatus = 200;
    retryAfter = null;

    // A remote header does not get to choose how long our row occupies the
    // queue; six hours is the ceiling.
    const delay = await scheduledDelayMs(webhookId);
    expect(delay).toBeLessThanOrEqual(6 * 60 * 60_000 + 5_000);
    expect(delay).toBeGreaterThan(5 * 60 * 60_000);
  });

  it('falls back to the ladder when a 503 carries no usable header', async () => {
    const webhookId = await registerWebhook();
    receiverStatus = 503;
    retryAfter = 'whenever';
    await ping(webhookId);
    receiverStatus = 200;
    retryAfter = null;

    // Unparseable is not zero and not NaN — it is "the receiver said nothing",
    // which is the jittered first step.
    const delay = await scheduledDelayMs(webhookId);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(WEBHOOK_RETRY_BACKOFF_MINUTES[0]! * 60_000 + 5_000);
  });

  it('spreads a backlog rather than making it all due at the same instant', async () => {
    // The thundering-herd case: an outage fails everything in flight at once.
    // With a fixed ladder every row got the identical next_attempt_at, so the
    // sweep served the receiver its entire outage the moment it came back —
    // knocking over the receiver that had just restarted.
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    for (let i = 0; i < 12; i += 1) await ping(webhookId);
    receiverStatus = 200;

    const { rows } = await ctx.pool.query<{ next_attempt_at: Date }>(
      `SELECT next_attempt_at FROM partner_webhook_deliveries
        WHERE webhook_id = $1 AND status = 'pending'`,
      [webhookId],
    );
    expect(rows).toHaveLength(12);
    const distinct = new Set(rows.map((r) => r.next_attempt_at.getTime()));
    expect(distinct.size).toBeGreaterThan(6);
  });

  it('keeps retrying long enough to outlast an ordinary incident', async () => {
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    await ping(webhookId);

    // Sweep the full ladder, bringing each backoff forward rather than waiting
    // it out. The reach is what matters: before the ladder grew, the event was
    // dropped 36 minutes into an outage.
    for (let i = 0; i < WEBHOOK_RETRY_BACKOFF_MINUTES.length; i += 1) {
      await ctx.pool.query(
        `UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 second'
          WHERE webhook_id = $1 AND status = 'pending'`,
        [webhookId],
      );
      const { retryDueDeliveries } = await import('../../src/hooks/partnerWebhooks.js');
      // The receiver comes back on the last step, which is the whole point of
      // still being here.
      if (i === WEBHOOK_RETRY_BACKOFF_MINUTES.length - 1) receiverStatus = 200;
      await retryDueDeliveries({ pool: ctx.pool });
    }

    const { rows } = await ctx.pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM partner_webhook_deliveries WHERE webhook_id = $1`,
      [webhookId],
    );
    expect(rows[0]!.status).toBe('delivered');
    expect(rows[0]!.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
  });
});
