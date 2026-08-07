import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { verifyWebhookSignature } from '../../src/domain/partnerWebhooks.js';
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

  it('records failed deliveries with the receiver status in the delivery log', async () => {
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
    const failed = log.json().deliveries.find((d: any) => d.status === 'failed');
    expect(failed).toBeTruthy();
    expect(failed.last_error).toContain('500');
    expect(log.json().deliveries.some((d: any) => d.status === 'delivered')).toBe(true);
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
