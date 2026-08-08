import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { verifyWebhookSignature } from '../../src/domain/partnerWebhooks.js';
import { retryDueDeliveries } from '../../src/hooks/partnerWebhooks.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Partner API enhancements — webhooks for every report type + idempotency. */
describe.skipIf(!dbUp)('partner webhooks & idempotency', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let otherApiKey: string;
  let opsToken: string;
  let receiver: FastifyInstance;
  let receiverUrl: string;
  let receiverStatus = 200;
  const received: Array<{ headers: Record<string, unknown>; rawBody: string; body: any }> = [];

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Hook Partners');
    const otherPartnerId = await seedPartner(ctx, 'Other Partners');

    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'hooks' },
    });
    apiKey = minted.json().secret as string;

    const otherAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: otherPartnerId });
    const otherMinted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${otherPartnerId}/tokens`,
      headers: authHeader(otherAdmin.token),
      payload: { name: 'other' },
    });
    otherApiKey = otherMinted.json().secret as string;

    const ops = await seedUser(ctx, { roles: ['reviewer'] });
    opsToken = ops.token;

    // The webhook receiver: a real HTTP server so delivery exercises fetch,
    // signing and status handling end-to-end.
    receiver = Fastify({ logger: false });
    receiver.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, payload, done) => {
      done(null, payload);
    });
    receiver.post('/hook', async (req, reply) => {
      received.push({
        headers: req.headers as Record<string, unknown>,
        rawBody: req.body as string,
        body: JSON.parse(req.body as string),
      });
      return reply.status(receiverStatus).send({ ok: receiverStatus === 200 });
    });
    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = receiver.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    receiverUrl = `http://127.0.0.1:${port}/hook`;
  }, 60_000);

  afterAll(async () => {
    await receiver?.close();
    await ctx?.teardown();
  });

  let webhookId: string;
  let webhookSecret: string;
  let pendingDeliveryId: string;

  it('registers a webhook, returning the signing secret exactly once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(apiKey),
      payload: { url: receiverUrl },
    });
    expect(res.statusCode).toBe(201);
    const { webhook } = res.json();
    expect(webhook.secret).toMatch(/^n409_whsec_/);
    expect(webhook.events).toEqual([]);
    webhookId = webhook.id;
    webhookSecret = webhook.secret;

    const list = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(apiKey),
    });
    expect(list.json().webhooks).toHaveLength(1);
    expect(list.json().webhooks[0].secret).toBeUndefined();

    const bad = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(apiKey),
      payload: { url: 'ftp://example.com/hook' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('delivers a signed test ping the receiver can verify', async () => {
    received.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(true);
    expect(received).toHaveLength(1);
    const hit = received[0]!;
    expect(hit.body.event).toBe('webhook.test');
    expect(hit.headers['x-n409-event']).toBe('webhook.test');
    expect(verifyWebhookSignature(webhookSecret, hit.rawBody, String(hit.headers['x-n409-signature']))).toBe(
      true,
    );
    // A wrong secret must not verify.
    expect(
      verifyWebhookSignature('n409_whsec_wrong', hit.rawBody, String(hit.headers['x-n409-signature'])),
    ).toBe(false);
  });

  it('fires state_changed on transitions and report_ready when the draft is shared', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: 'qsbs', company_name: 'HookCo' },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id;

    received.length = 0;
    const started = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(opsToken),
      payload: { state: 'started' },
    });
    expect(started.statusCode).toBe(200);
    expect(received.map((r) => r.body.event)).toEqual(['valuation.state_changed']);
    expect(received[0]!.body.valuation).toMatchObject({
      id: valuationId,
      kind: 'qsbs',
      state: 'started',
      company_name: 'HookCo',
    });

    received.length = 0;
    const drafted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(opsToken),
      payload: { state: 'drafted' },
    });
    expect(drafted.statusCode).toBe(200);
    expect(received.map((r) => r.body.event).sort()).toEqual([
      'valuation.report_ready',
      'valuation.state_changed',
    ]);
  });

  it('keeps a 5xx delivery pending with a backoff instead of dropping it', async () => {
    receiverStatus = 500;
    const res = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(apiKey),
    });
    receiverStatus = 200;
    expect(res.json().delivered).toBe(false);

    const log = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(apiKey),
    });
    expect(log.statusCode).toBe(200);
    // A receiver that answered 500 gets tried again — the event is owed, not
    // lost, which is the whole point of 0103.
    const pending = log.json().deliveries.find((d: any) => d.status === 'pending');
    expect(pending).toBeTruthy();
    expect(pending.last_error).toContain('500');
    expect(pending.attempts).toBe(1);
    expect(pending.max_attempts).toBe(4);
    // One minute out — invisible to the sweep until then.
    const delayMs = new Date(pending.next_attempt_at).getTime() - Date.parse(pending.created_at);
    expect(delayMs).toBeGreaterThanOrEqual(55_000);
    expect(delayMs).toBeLessThanOrEqual(70_000);
    expect(log.json().deliveries.some((d: any) => d.status === 'delivered')).toBe(true);
    pendingDeliveryId = pending.id;
  });

  it('re-delivers a pending row once its backoff elapses', async () => {
    // Bring the backoff forward rather than waiting a minute; the sweep's
    // predicate is next_attempt_at <= now(), so this is exactly the state the
    // row reaches on its own.
    await ctx.pool.query(
      "UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [pendingDeliveryId],
    );
    const before = received.length;
    const swept = await retryDueDeliveries({ pool: ctx.pool });
    expect(swept.delivered).toBe(1);
    expect(received.length).toBe(before + 1);

    const log = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(apiKey),
    });
    const row = log.json().deliveries.find((d: any) => d.id === pendingDeliveryId);
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(2);
    // Settled rows report no next attempt — the stored timestamp is the one
    // that let this attempt happen, and echoing it reads as a promise.
    expect(row.next_attempt_at).toBeNull();
  });

  it('gives up after the last backoff step and lets the partner replay', async () => {
    receiverStatus = 503;
    await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(apiKey),
    });

    // Three sweeps = the three backoff steps. Each one is due immediately.
    for (let i = 0; i < 3; i += 1) {
      await ctx.pool.query(
        "UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'",
      );
      await retryDueDeliveries({ pool: ctx.pool });
    }
    receiverStatus = 200;

    const log = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(apiKey),
    });
    const dead = log.json().deliveries.find((d: any) => d.status === 'failed');
    expect(dead).toBeTruthy();
    expect(dead.attempts).toBe(4);
    expect(dead.last_error).toContain('503');

    // A fourth sweep must not touch it: terminal means terminal.
    await ctx.pool.query(
      "UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'failed'",
    );
    expect((await retryDueDeliveries({ pool: ctx.pool })).attempted).toBe(0);

    // ...until the partner replays it, which resets the ladder.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries/${dead.id}/retry`,
      headers: keyHeader(apiKey),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().delivery.status).toBe('pending');
    expect(replay.json().delivery.attempts).toBe(0);

    const swept = await retryDueDeliveries({ pool: ctx.pool });
    expect(swept.delivered).toBe(1);
  });

  it('does not retry a 4xx the receiver told us not to repeat', async () => {
    receiverStatus = 404;
    await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/test`,
      headers: keyHeader(apiKey),
    });
    receiverStatus = 200;

    const log = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(apiKey),
    });
    const gone = log.json().deliveries.find((d: any) => d.last_error?.includes('404'));
    expect(gone.status).toBe('failed');
    // One attempt, not four: three more identical POSTs to a 404 change
    // nothing and only delay the partner learning the URL is wrong.
    expect(gone.attempts).toBe(1);
  });

  it("refuses to replay another partner's delivery", async () => {
    const log = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(apiKey),
    });
    const any = log.json().deliveries[0];
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries/${any.id}/retry`,
      headers: keyHeader(otherApiKey),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("scopes webhooks to the key's partner", async () => {
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/partner/v1/webhooks/${webhookId}/deliveries`,
      headers: keyHeader(otherApiKey),
    });
    expect(foreign.statusCode).toBe(404);
    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: `/api/partner/v1/webhooks/${webhookId}`,
      headers: keyHeader(otherApiKey),
    });
    expect(foreignDelete.statusCode).toBe(404);
  });

  it('replays an idempotent create instead of creating twice, and refuses a reused key', async () => {
    const headers = { ...keyHeader(apiKey), 'idempotency-key': 'create-2026-08-07-001' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers,
      payload: { kind: '718', company_name: 'IdemCo' },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().valuation.id;

    const replay = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers,
      payload: { kind: '718', company_name: 'IdemCo' },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().valuation.id).toBe(firstId);
    expect(replay.headers['x-idempotent-replay']).toBe('true');

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers,
      payload: { kind: '718', company_name: 'DifferentCo' },
    });
    expect(conflict.statusCode).toBe(409);

    // Only two valuations for this partner carry that name.
    const list = await app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?per_page=100',
      headers: keyHeader(apiKey),
    });
    const idemRows = list.json().valuations.filter((v: any) => v.company_name === 'IdemCo');
    expect(idemRows).toHaveLength(1);
  });

  it('deletes a webhook and stops delivering', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/partner/v1/webhooks/${webhookId}`,
      headers: keyHeader(apiKey),
    });
    expect(del.statusCode).toBe(200);
    received.length = 0;
    const created = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(apiKey),
      payload: { kind: '409a', company_name: 'SilentCo' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${created.json().valuation.id}`,
      headers: authHeader(opsToken),
      payload: { state: 'started' },
    });
    expect(received).toHaveLength(0);
  });
});
