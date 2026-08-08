import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { newWebhookSecret, setWebhookTargetPolicy } from '../../src/domain/partnerWebhooks.js';
import { deliverToWebhook } from '../../src/hooks/partnerWebhooks.js';
import { createWebhook, listDeliveries } from '../../src/repos/partnerWebhooks.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The webhook target is a URL a partner types in and this service then POSTs
 * to, from inside the network — a textbook SSRF primitive. The delivery log
 * hands the response status back to the partner, so an unguarded target turns
 * the log into an internal port scanner.
 *
 * The default app here does NOT set WEBHOOK_ALLOW_PRIVATE_TARGETS, which is
 * what production looks like. (partnerWebhooks.test.ts sets it, because its
 * receiver genuinely is on 127.0.0.1 — that is the local-development case.)
 */
describe.skipIf(!dbUp)('partner webhook SSRF guard', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let apiKey: string;
  let ownerId: string;
  let redirector: FastifyInstance;
  let redirectPort = 0;

  const keyHeader = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    ctx = await setupTestApp({}, { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) });
    app = ctx.app;
    // buildApp sets the process policy from config; assert we are testing the
    // production shape rather than inheriting another file's setting.
    setWebhookTargetPolicy(false);

    partnerId = await seedPartner(ctx, 'SSRF Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    ownerId = admin.id;
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { name: 'ssrf' },
    });
    apiKey = minted.json().secret as string;

    redirector = Fastify({ logger: false });
    redirector.post('/hop', async (_req, reply) => reply.redirect('http://169.254.169.254/', 302));
    await redirector.listen({ port: 0, host: '127.0.0.1' });
    const address = redirector.server.address();
    redirectPort = typeof address === 'object' && address ? address.port : 0;
  }, 60_000);

  afterAll(async () => {
    await redirector?.close();
    await ctx?.teardown();
  });

  it('refuses to register a webhook aimed inside the network', async () => {
    for (const url of [
      'http://127.0.0.1:3001/api/v1/admin/webhooks/retry',
      'http://localhost:3000/',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://10.0.0.1/hook',
      'http://[::1]:3001/hook',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/partner/v1/webhooks',
        headers: keyHeader(apiKey),
        payload: { url },
      });
      expect(res.statusCode, url).toBe(422);
      expect(res.json().detail, url).toContain('public');
    }

    // A public URL still registers — the guard is not a blanket refusal.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/partner/v1/webhooks',
      headers: keyHeader(apiKey),
      payload: { url: 'https://hooks.example.com/n409' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('refuses at delivery when the stored URL resolves to a private address', async () => {
    // Registration cannot catch this on its own: a name is public until DNS
    // says otherwise, and DNS is answered at delivery. Writing the row through
    // the repo, with a resolver that answers the way a rebinding host does, is
    // exactly the state such a webhook reaches on its first event.
    const webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'http://hooks.example.com/n409',
      secret: newWebhookSecret(),
      events: [],
      createdBy: ownerId,
    });

    const outcome = await deliverToWebhook(
      { pool: ctx.pool, lookupFn: async () => [{ address: '127.0.0.1' }] },
      webhook,
      'webhook.test',
      { event: 'webhook.test' },
    );
    expect(outcome).toBe('failed');

    // Permanent, not pending: four more attempts would resolve the same way,
    // and the partner needs the reason rather than four identical timeouts.
    const deliveries = await listDeliveries(ctx.pool, webhook.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('failed');
    expect(deliveries[0]!.last_error).toContain('non-public address 127.0.0.1');
  });

  it('refuses a name carrying one public and one private address', async () => {
    // `all: true` and not just the first answer: otherwise this passes or
    // fails on resolver ordering, which is not a security boundary.
    const webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'http://split.example.com/n409',
      secret: newWebhookSecret(),
      events: [],
      createdBy: ownerId,
    });
    const outcome = await deliverToWebhook(
      {
        pool: ctx.pool,
        lookupFn: async () => [{ address: '93.184.216.34' }, { address: '169.254.169.254' }],
      },
      webhook,
      'webhook.test',
      { event: 'webhook.test' },
    );
    expect(outcome).toBe('failed');
    const deliveries = await listDeliveries(ctx.pool, webhook.id);
    expect(deliveries[0]!.last_error).toContain('169.254.169.254');
  });

  it('does not follow a redirect from a public receiver to an internal one', async () => {
    // The one hole a resolve-time check alone leaves: a genuinely public
    // receiver answering 302 to the metadata endpoint. fetch follows redirects
    // by default, and would re-resolve the Location with none of the checks
    // above — so the redirect itself has to be refused.
    const webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: `http://127.0.0.1:${redirectPort}/hop`,
      secret: newWebhookSecret(),
      events: [],
      createdBy: ownerId,
    });

    const outcome = await deliverToWebhook(
      // Private target allowed so the request actually reaches the redirector:
      // what is under test here is the hop, not the address.
      { pool: ctx.pool, allowPrivateTargets: true },
      webhook,
      'webhook.test',
      { event: 'webhook.test' },
    );
    expect(outcome).toBe('failed');

    const deliveries = await listDeliveries(ctx.pool, webhook.id);
    expect(deliveries[0]!.last_error).toContain('redirected');
  });

  it('lets a public target past the guard and into the request', async () => {
    // The guard must not be so broad that the feature stops working. `.invalid`
    // never resolves, so the attempt cannot reach anything — but it fails as a
    // *transport* error, retryable, rather than as a policy refusal, which is
    // the distinction being pinned: the target got past the guard.
    const webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'https://receiver.invalid/n409',
      secret: newWebhookSecret(),
      events: [],
      createdBy: ownerId,
    });
    const outcome = await deliverToWebhook(
      { pool: ctx.pool, lookupFn: async () => [{ address: '93.184.216.34' }] },
      webhook,
      'webhook.test',
      { event: 'webhook.test' },
    );
    expect(outcome).toBe('retrying');
    const deliveries = await listDeliveries(ctx.pool, webhook.id);
    expect(deliveries[0]!.last_error).not.toMatch(/non-public/);
  });
});
