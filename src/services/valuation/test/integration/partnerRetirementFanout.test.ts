import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The retirement announcement's shape under a receiver that does not answer
 * (round 300, methodology M5).
 *
 * `firePartnerWebhooksForRetirement` is the platform's one batch fan-out: the
 * retention sweep hands it up to five hundred archived engagements at once, and
 * it was `for (row) for (hook) await POST` — a single serial queue over the
 * whole batch. Every POST is bounded by `DELIVERY_TIMEOUT_MS` plus a DNS lookup
 * the SSRF guard deliberately does not cache, so one partner whose receiver has
 * gone dark set the pace for every partner behind it: `rows × hooks × 10s`,
 * which on a full batch is hours inside a single sweep tick.
 *
 * The cost is not the waiting. A delivery row is written before each attempt
 * and the retry ladder owns it from there, so a POST that *fails* loses
 * nothing — but an engagement whose turn has not come has no row at all, and
 * nothing revisits a retirement announcement that was never queued. A deploy
 * anywhere inside those hours drops the tail of the batch silently, and the
 * longer the pass runs the larger the tail.
 *
 * Each receiver now gets its own serial chain — so nothing starts POSTing
 * concurrently at an endpoint that is already struggling, and each partner's
 * engagements still arrive in the order they were archived — and the chains run
 * side by side.
 *
 * Asserted with a barrier rather than a stopwatch: both receivers hold their
 * first request until the other has also received one. Under the serial
 * dispatch the second request cannot arrive until the first has answered, so
 * the barrier never completes and the sweep waits out the timeout below.
 */
describe.skipIf(!dbUp)('the retirement fan-out', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let adminToken: string;
  const receivers: FastifyInstance[] = [];

  /** How many distinct receivers have a request in flight right now. */
  let arrived = 0;
  let releaseAll: (() => void) | null = null;
  /** Resolves once two receivers are simultaneously mid-request. */
  let bothArrived: Promise<void>;

  const BARRIER_TIMEOUT_MS = 3_000;

  beforeAll(async () => {
    ctx = await setupTestApp(
      { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true', AUTO_PIPELINE: 'off' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Fanout Hooks LLP');

    const partnerAdmin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(partnerAdmin.token),
      payload: { name: 'fanout' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;
    adminToken = (await seedUser(ctx, { roles: ['admin'] })).token;

    bothArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    // Two receivers, each registered as its own webhook on the one partner.
    for (let i = 0; i < 2; i++) {
      const receiver = Fastify({ logger: false });
      receiver.post('/hook', async (_req, reply) => {
        arrived += 1;
        if (arrived >= 2) releaseAll?.();
        // Held until the other receiver has also been reached, or the barrier
        // times out — which is what a serial dispatch produces.
        await Promise.race([
          bothArrived,
          new Promise<void>((resolve) => setTimeout(resolve, BARRIER_TIMEOUT_MS).unref?.()),
        ]);
        arrived -= 1;
        return reply.status(200).send({ ok: true });
      });
      await receiver.listen({ port: 0, host: '127.0.0.1' });
      const address = receiver.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      receivers.push(receiver);

      const hook = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/webhooks',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { url: `http://127.0.0.1:${port}/hook` },
      });
      expect(hook.statusCode).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    for (const r of receivers) await r?.close();
    await ctx?.teardown();
  });

  it('announces to two receivers at the same time, not one after the other', async () => {
    const ids: string[] = [];
    for (const name of ['Fanout One', 'Fanout Two']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { kind: '409a', company_name: name, currency: 'USD' },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().valuation.id as string);
    }
    await ctx.pool.query(
      `UPDATE valuations SET created_at = now() - interval '400 days' WHERE id = ANY($1::ulid[])`,
      [ids],
    );
    for (const id of ids) invalidateValuation(id);

    const policy = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(adminToken),
      payload: { archive_after_days: 30, retention_days: null, enabled: true },
    });
    expect(policy.statusCode).toBe(200);

    const started = Date.now();
    const result = await runRetentionSweep(ctx.pool);
    const elapsed = Date.now() - started;

    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(adminToken),
      payload: { archive_after_days: null, retention_days: null, enabled: false },
    });

    expect(result.archived).toBeGreaterThanOrEqual(2);
    // The barrier was met, so no request ever waited it out. Serially, the
    // first POST holds for the full timeout before the second is even sent —
    // twice over, once per engagement.
    expect(elapsed).toBeLessThan(BARRIER_TIMEOUT_MS);

    // Both receivers were reached, for both engagements: bounding the fan-out
    // must not drop anything.
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM partner_webhook_deliveries d
         JOIN partner_webhooks w ON w.id = d.webhook_id
        WHERE w.partner_id = $1 AND d.event_type = 'valuation.retired'
          AND d.valuation_id = ANY($2::ulid[]) AND d.status = 'delivered'`,
      [partnerId, ids],
    );
    expect(Number(rows[0]!.count)).toBe(4);
  }, 60_000);
});
