import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * `valuation.retired` — the only terminal event on the partner API.
 *
 * A partner integration finds out about an engagement three ways: the list it
 * disappears from, the `state` it polls, and the webhooks it subscribed to so
 * it would not have to poll. A retirement was invisible to all three. It leaves
 * `GET /valuations` (`buildValuationWhere`), it emits no further
 * `valuation.state_changed` because there are no further states, and it simply
 * goes quiet — which is indistinguishable, from outside, from work still in
 * progress. The integration waits for a report that is never coming.
 *
 * R90 gave the poller `retired_at` on the valuation projection. This is the
 * push half, and it matters more: the whole point of registering a webhook is
 * not to have to ask.
 *
 * Two things produce it, and both are tested here rather than one being taken
 * on trust — they reach the dispatcher by different routes. The manual
 * withdrawal passes a single id from the admin route; the retention sweep
 * passes the whole batch its UPDATE returned, which is what keeps a
 * five-hundred-row sweep at one extra query rather than five hundred.
 */
describe.skipIf(!dbUp)('the retirement webhook', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let adminToken: string;
  let receiver: FastifyInstance;
  let receiverUrl: string;
  const received: Array<{ event: string; body: Record<string, any> }> = [];

  beforeAll(async () => {
    // A real server on 127.0.0.1, which the SSRF guard refuses by default —
    // this is the flag a local development environment sets for the same
    // reason. Production leaves it off.
    ctx = await setupTestApp(
      { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true', AUTO_PIPELINE: 'off' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Retirement Hooks LLP');

    const partnerAdmin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(partnerAdmin.token),
      payload: { name: 'hooks' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;
    adminToken = (await seedUser(ctx, { roles: ['admin'] })).token;

    receiver = Fastify({ logger: false });
    receiver.post('/hook', async (req, reply) => {
      const body = req.body as Record<string, any>;
      received.push({ event: String(req.headers['x-n409-event']), body });
      return reply.status(200).send({ ok: true });
    });
    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = receiver.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    receiverUrl = `http://127.0.0.1:${port}/hook`;

    const hook = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { url: receiverUrl },
    });
    expect(hook.statusCode).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await receiver?.close();
    await ctx?.teardown();
  });

  const createPartnerValuation = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { kind: '409a', company_name: name, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const retire = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/retire`,
      headers: authHeader(adminToken),
      payload: { reason: 'test' },
    });

  const retirements = (id: string) =>
    received.filter((r) => r.event === 'valuation.retired' && r.body.valuation?.id === id);

  it('is sent when an admin withdraws a partner engagement', async () => {
    received.length = 0;
    const id = await createPartnerValuation('Told About It Co');
    expect((await retire(id)).statusCode).toBe(200);

    const sent = retirements(id);
    expect(sent).toHaveLength(1);
    // The row as it now is, suffix and all: the event describes what happened,
    // and a partner reconciling on `id` or their own `external_id` is
    // unaffected either way.
    expect(sent[0]!.body.valuation.company_name).toBe('Told About It Co [retired]');
    expect(sent[0]!.body.event).toBe('valuation.retired');
  });

  it('is sent by the retention sweep, for the whole batch it archived', async () => {
    received.length = 0;
    const ids = [await createPartnerValuation('Aged Out One'), await createPartnerValuation('Aged Out Two')];
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

    const result = await runRetentionSweep(ctx.pool);
    expect(result.archived).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(retirements(id)).toHaveLength(1);

    // Turn the policy off again: the sweep is platform-wide and the tests below
    // create engagements that must not be swept out from under them.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(adminToken),
      payload: { archive_after_days: null, retention_days: null, enabled: false },
    });
  });

  it('reads the partner’s webhooks once for the batch, not once per engagement (R290)', async () => {
    /*
     * The batch fan-out's own N+1. `firePartnerWebhooks` reads the partner's
     * enabled webhooks itself, which is right for its three single-row callers
     * and wrong for the one that fans out over a batch: a batch of retirements
     * is the one thing guaranteed to repeat its partner, because a firm's book
     * ages out together. The sweep takes up to 500 engagements a pass, so 500
     * rows asked `partner_webhooks` the same question 500 times — and
     * `enabledWebhooks` decrypts every secret it returns, so the repeated work
     * was an AES open per hook per row and not merely a round trip.
     *
     * Counted rather than timed, and counted on the statement rather than on
     * the wire: the claim is "once per distinct partner", which is a number.
     */
    received.length = 0;
    const ids = [
      await createPartnerValuation('Batched One'),
      await createPartnerValuation('Batched Two'),
      await createPartnerValuation('Batched Three'),
      await createPartnerValuation('Batched Four'),
    ];
    await ctx.pool.query(
      `UPDATE valuations SET created_at = now() - interval '400 days' WHERE id = ANY($1::ulid[])`,
      [ids],
    );
    for (const id of ids) invalidateValuation(id);
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(adminToken),
      payload: { archive_after_days: 30, retention_days: null, enabled: true },
    });

    let hookReads = 0;
    const original = ctx.pool.query.bind(ctx.pool);
    (ctx.pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      if (/FROM partner_webhooks\b/.test(text) && /enabled/.test(text)) hookReads += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await runRetentionSweep(ctx.pool);
    } finally {
      (ctx.pool as unknown as { query: unknown }).query = original;
    }

    // Every one of them still got its event — the point is the reads, not the
    // sends, and a fan-out that reads once and delivers nothing is worse.
    for (const id of ids) expect(retirements(id)).toHaveLength(1);
    expect(ids.length).toBeGreaterThan(1);
    expect(hookReads, `read partner_webhooks ${hookReads} times for one partner`).toBe(1);

    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/valuation',
      headers: authHeader(adminToken),
      payload: { archive_after_days: null, retention_days: null, enabled: false },
    });
  });

  it('is not sent for an engagement no partner owns', async () => {
    received.length = 0;
    const direct = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(adminToken),
      payload: { kind: '409a', company_name: 'Nobody Watching Co' },
    });
    expect(direct.statusCode).toBe(201);
    const id = direct.json().valuation.id as string;

    expect((await retire(id)).statusCode).toBe(200);
    // The dispatcher filters on `partner_id IS NOT NULL`, so this is the check
    // that a direct engagement does not leak into some partner's feed.
    expect(received).toHaveLength(0);
  });

  it('is not sent twice — a refused second retirement dispatches nothing', async () => {
    received.length = 0;
    const id = await createPartnerValuation('Only Once Told Co');
    expect((await retire(id)).statusCode).toBe(200);
    expect(retirements(id)).toHaveLength(1);

    const again = await retire(id);
    expect(again.statusCode).toBe(409);
    expect(retirements(id)).toHaveLength(1);
  });

  /**
   * The event reaches a subscriber who asked for it by name.
   *
   * The webhook registered above subscribes to everything (an empty `events`
   * list means all). A partner who enumerated the events they wanted has to be
   * able to name this one — and a partner who named only the others must not
   * receive it, which is the half that would fail if the event fell back to
   * "always send".
   */
  it('is filtered like every other event', async () => {
    const narrow = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { url: `${receiverUrl}?only=report`, events: ['valuation.report_ready'] },
    });
    expect(narrow.statusCode).toBe(201);
    const narrowId = narrow.json().webhook.id as string;

    received.length = 0;
    const id = await createPartnerValuation('Filtered Co');
    expect((await retire(id)).statusCode).toBe(200);

    // One delivery, from the subscribe-to-everything hook — not two.
    expect(retirements(id)).toHaveLength(1);

    await app.inject({
      method: 'DELETE',
      url: `/api/partner/v1/webhooks/${narrowId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
  });
});
