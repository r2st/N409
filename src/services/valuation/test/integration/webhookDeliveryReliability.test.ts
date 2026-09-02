import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_BACKOFF_MINUTES } from '../../src/domain/partnerWebhooks.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

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
      payload: { current_password: SEEDED_PASSWORD, name: 'reliability' },
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

  /**
   * The state 0103 argued could not exist.
   *
   * Its reasoning is that `claimed_at` is a lease rather than a status, so a
   * sweeper lost mid-POST leaves a stamp that expires and the row goes back in
   * the queue — "no wedged state needing its own reaper". That holds for every
   * attempt except the last. The claim counts the attempt before the POST, so a
   * process lost between claiming the *final* attempt and settling it leaves
   * `attempts = max_attempts` on a row still reading 'pending', which the
   * claim's own `attempts < max_attempts` then excludes forever.
   *
   * Nothing was lost by it — that attempt was the last one either way. What was
   * wrong is that nothing ever said so: the row stayed 'pending' and due in the
   * backlog gauge for the life of the table, and the partner's delivery log went
   * on promising a retry that could not happen.
   *
   * `wedge` reproduces it by hand rather than by killing a process, and the
   * first assertion below is the reproduction: the claim genuinely cannot see
   * the row. Without that, a reaper test only proves the reaper runs.
   */
  const wedge = async (
    webhookId: string,
    opts: { claimedSecondsAgo?: number | null; lastError?: string | null } = {},
  ): Promise<string> => {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `UPDATE partner_webhook_deliveries
          SET status = 'pending',
              attempts = max_attempts,
              last_error = $2,
              claimed_at = CASE WHEN $3::int IS NULL THEN NULL
                                ELSE now() - ($3 || ' seconds')::interval END
        WHERE webhook_id = $1
        RETURNING id`,
      [
        webhookId,
        opts.lastError ?? null,
        opts.claimedSecondsAgo === null ? null : (opts.claimedSecondsAgo ?? 3600),
      ],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  };

  const deliveryRow = async (id: string) => {
    const { rows } = await ctx.pool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      claimed_at: Date | null;
    }>('SELECT status, attempts, last_error, claimed_at FROM partner_webhook_deliveries WHERE id = $1', [id]);
    return rows[0]!;
  };

  it('settles a delivery whose final attempt was lost with the process making it', async () => {
    const { claimRetryableDeliveries, failExhaustedDeliveries, DELIVERY_ABANDONED_ERROR } =
      await import('../../src/repos/partnerWebhooks.js');
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    await ping(webhookId);
    receiverStatus = 200;
    const id = await wedge(webhookId);

    // The reproduction: the retry sweep cannot reach this row. Every attempt is
    // spent, so the claim excludes it, and nothing else ever writes it.
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const claimed = await claimRetryableDeliveries(ctx.pool, { leaseMs: 1000 });
    expect(claimed.map((c) => c.id)).not.toContain(id);
    expect((await deliveryRow(id)).status).toBe('pending');

    const reaped = await failExhaustedDeliveries(ctx.pool, { leaseMs: 60_000 });
    expect(reaped.map((r) => r.id)).toContain(id);

    const row = await deliveryRow(id);
    expect(row.status).toBe('failed');
    expect(row.claimed_at).toBeNull();
    expect(row.last_error).toBe(DELIVERY_ABANDONED_ERROR);
  });

  it('leaves the final attempt alone while its lease is still running', async () => {
    const { failExhaustedDeliveries } = await import('../../src/repos/partnerWebhooks.js');
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    await ping(webhookId);
    receiverStatus = 200;
    // Claimed a second ago against a five-minute lease: this row is in flight
    // on its last attempt, not wedged. Reaping it would mark a delivery failed
    // while its POST was still running — possibly while it was succeeding.
    const id = await wedge(webhookId, { claimedSecondsAgo: 1 });

    const reaped = await failExhaustedDeliveries(ctx.pool, { leaseMs: 5 * 60_000 });
    expect(reaped.map((r) => r.id)).not.toContain(id);
    expect((await deliveryRow(id)).status).toBe('pending');
  });

  it('keeps the error from the attempt before the one that was lost', async () => {
    const { failExhaustedDeliveries, DELIVERY_ABANDONED_ERROR } =
      await import('../../src/repos/partnerWebhooks.js');
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    await ping(webhookId);
    receiverStatus = 200;
    const id = await wedge(webhookId, { lastError: 'receiver responded 503' });

    await failExhaustedDeliveries(ctx.pool, { leaseMs: 60_000 });
    // What the receiver actually said is more use to the partner reading the
    // delivery log than a note about our own process, so the reaper only fills
    // a blank.
    const row = await deliveryRow(id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('receiver responded 503');
    expect(row.last_error).not.toBe(DELIVERY_ABANDONED_ERROR);
  });

  it('runs the reap on the retry sweep, and counts it separately from deliveries', async () => {
    const { retryDueDeliveries } = await import('../../src/hooks/partnerWebhooks.js');
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    await ping(webhookId);
    receiverStatus = 200;
    const id = await wedge(webhookId, { claimedSecondsAgo: null });

    const result = await retryDueDeliveries({ pool: ctx.pool, leaseMs: 60_000 });
    expect(result.reaped).toBeGreaterThanOrEqual(1);
    // A reap is not a delivery attempt. Folding it into `failed` would report
    // the sweep as having tried something it never sent.
    expect((await deliveryRow(id)).status).toBe('failed');

    // And it is idempotent: the row is no longer 'pending', so a second pass
    // finds nothing to settle and does not re-report it.
    const again = await retryDueDeliveries({ pool: ctx.pool, leaseMs: 60_000 });
    expect(again.reaped).toBe(0);
  });

  /**
   * A settle the database refuses, in the middle of a claimed batch.
   *
   * `postDelivery` never throws, so this sweep's only raise is a database
   * failure inside `settle` — and this loop was the one of the three delivery
   * loops that let it out. `dispatchToWebhook` contains the fan-out per hook and
   * says why in as many words; `hooks/emailRetry.ts` contains its own settle for
   * the same reason. Here the claim takes up to a hundred rows in one statement,
   * stamping a lease and spending an attempt on every one of them, so a single
   * refused UPDATE ended the tick with the whole tail still claimed: an attempt
   * poorer for a POST nobody made, and invisible until the lease lapses.
   *
   * Staged on the pool rather than with a trigger, because the point is a blip
   * on one statement with a healthy database either side of it — a statement
   * timeout, a dropped backend, a failover that costs one connection.
   */
  it('finishes the rest of a claimed batch when one settle is refused', async () => {
    const { retryDueDeliveries } = await import('../../src/hooks/partnerWebhooks.js');
    // The partner is one webhook off its ten-hook ceiling by now, and this case
    // wants a table holding only its own two deliveries. Deliveries cascade.
    await ctx.pool.query('DELETE FROM partner_webhooks');
    const webhookId = await registerWebhook();
    receiverStatus = 500;
    await ping(webhookId);
    await ping(webhookId);
    receiverStatus = 200;
    // Both attempts are pending with a backoff; bring them forward so one sweep
    // claims the pair.
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 minute'
        WHERE webhook_id = $1 AND status = 'pending'`,
      [webhookId],
    );

    // Only the settle, not the reap or the claim above it — all three are an
    // UPDATE on the same table.
    let left = 1;
    const restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
      if (phase === 'before' && sql.includes("SET status = 'delivered'") && left > 0) {
        left -= 1;
        throw new Error('connection terminated unexpectedly');
      }
      return undefined;
    });
    let result;
    try {
      result = await retryDueDeliveries({ pool: ctx.pool, leaseMs: 600_000 });
    } finally {
      restore();
    }

    expect(result.attempted).toBe(2);
    // One settle refused, and the pass says so rather than throwing: `failed`
    // is a statement about a receiver and this is a statement about us.
    expect(result.unsettled).toBe(1);
    // The other row is nothing to do with it and must still have been settled.
    expect(result.delivered).toBe(1);

    const { rows } = await ctx.pool.query<{ status: string; claimed_at: Date | null }>(
      `SELECT status, claimed_at FROM partner_webhook_deliveries
        WHERE webhook_id = $1 ORDER BY status`,
      [webhookId],
    );
    expect(rows.map((r) => r.status).sort()).toEqual(['delivered', 'pending']);
    // The unsettled row keeps its claim: nothing else has to notice, and it is
    // delivered again once the lease lapses.
    expect(rows.find((r) => r.status === 'pending')!.claimed_at).not.toBeNull();
  });
});
