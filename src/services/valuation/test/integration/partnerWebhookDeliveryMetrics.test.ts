import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import { createWebhook } from '../../src/repos/partnerWebhooks.js';
import { deliverToWebhook, retryDueDeliveries } from '../../src/hooks/partnerWebhooks.js';
import { newWebhookSecret } from '../../src/domain/partnerWebhooks.js';
import {
  recordPartnerWebhookDelivery,
  registerPartnerWebhookDeliveryMetrics,
  resetPartnerWebhookDeliveryMetrics,
} from '../../src/observability/partnerWebhookDeliveries.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The outbound webhook wire, on `/metrics` (R450, methodology M11).
 *
 * `inbound_webhook_deliveries_total` has counted what arrives at the webhook
 * doors since R329. What *leaves* — the events this platform owes a partner
 * when an engagement moves — was counted only by the retry sweep, which sees
 * a delivery once it has already failed once. The first attempt, made in-line
 * from the request that moved the engagement, was on no series; a delivered
 * event was on no series at all. So a delivery rate had no denominator, and a
 * receiver taking nine of its ten seconds on every event was visible only as
 * that request getting slow.
 */

const dbUp = await isDbAvailable();

const answer = (status: number) =>
  vi.fn().mockImplementation(() => Promise.resolve(new Response(status === 204 ? null : '{}', { status })));

describe.skipIf(!dbUp)('the partner webhook delivery counter', () => {
  let ctx: TestApp;
  let webhook: Awaited<ReturnType<typeof createWebhook>>;
  let registry: MetricsRegistry;

  beforeAll(async () => {
    ctx = await setupTestApp();
    const partnerId = await seedPartner(ctx, `Webhook Metrics Firm ${Date.now()}`);
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'https://receiver.example.com/n409',
      secret: newWebhookSecret(),
      events: ['valuation.report_ready', 'valuation.retired'],
      createdBy: admin.id,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPartnerWebhookDeliveryMetrics();
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const deliver = (event: 'valuation.report_ready' | 'valuation.retired' = 'valuation.report_ready') =>
    deliverToWebhook({ pool: ctx.pool, allowPrivateTargets: true }, webhook, event, { event });

  const fresh = () => {
    registry = new MetricsRegistry();
    registerPartnerWebhookDeliveryMetrics(registry);
  };

  it('counts a delivered first attempt — the row the sweep never sees', async () => {
    fresh();
    vi.stubGlobal('fetch', answer(204));
    expect(await deliver()).toBe('delivered');
    const text = registry.render();
    expect(text).toContain('partner_webhook_deliveries_total{event="valuation.report_ready",outcome="delivered"} 1');
    expect(text).toContain('partner_webhook_delivery_duration_seconds_count{event="valuation.report_ready"} 1');
  });

  it('separates a receiver that will be retried from one that will not', async () => {
    // A 5xx goes back on the ladder; a 4xx (other than the three that mean
    // "later") settles the row for good. They are different people's
    // problems — a run of 4xx is the partner's endpoint, a run of 5xx is their
    // host — and one error rate cannot tell them apart.
    fresh();
    vi.stubGlobal('fetch', answer(503));
    expect(await deliver()).toBe('retrying');
    vi.stubGlobal('fetch', answer(410));
    expect(await deliver()).toBe('failed');
    const text = registry.render();
    expect(text).toContain('outcome="failed"} 1');
    expect(text).toContain('outcome="rejected"} 1');
  });

  it('gives a redirect and a refused connection their own words', async () => {
    fresh();
    vi.stubGlobal('fetch', answer(302));
    await deliver();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    );
    await deliver();
    const text = registry.render();
    expect(text).toContain('outcome="redirected"} 1');
    expect(text).toContain('outcome="unreachable"} 1');
  });

  it('counts a blocked target without observing a latency for it', async () => {
    // Nothing was dialled. A zero in the histogram would drag every quantile
    // toward the floor exactly while a partner's DNS points somewhere private.
    fresh();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const outcome = await deliverToWebhook(
      {
        pool: ctx.pool,
        allowPrivateTargets: false,
        lookupFn: async () => [{ address: '10.0.0.8', family: 4 }],
      },
      webhook,
      'valuation.retired',
      { event: 'valuation.retired' },
    );
    expect(outcome).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = registry.render();
    expect(text).toContain('partner_webhook_deliveries_total{event="valuation.retired",outcome="blocked"} 1');
    expect(text).not.toContain('partner_webhook_delivery_duration_seconds_count{event="valuation.retired"}');
  });

  it('lands the sweep’s retries on the same series as the first attempt', async () => {
    // One series for the whole ladder, so `delivered` over everything is the
    // delivery rate — not "first attempts" in one place and "retries" in
    // another with no way to add them.
    fresh();
    vi.stubGlobal('fetch', answer(503));
    expect(await deliver()).toBe('retrying');
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries SET next_attempt_at = now() - interval '1 minute'
        WHERE webhook_id = $1 AND status = 'pending'`,
      [webhook.id],
    );
    vi.stubGlobal('fetch', answer(200));
    const r = await retryDueDeliveries({ pool: ctx.pool, allowPrivateTargets: true });
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const text = registry.render();
    expect(text).toContain('outcome="failed"} 1');
    expect(text).toMatch(/outcome="delivered"\} [1-9]/);
  });

  it('is inert before registration rather than throwing', () => {
    expect(() => recordPartnerWebhookDelivery('valuation.report_ready', 'delivered', 12)).not.toThrow();
  });

  it('is registered on the app, and read by a rule', () => {
    const app = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    expect(app).toMatch(/registerPartnerWebhookDeliveryMetrics\(metricsRegistry\)/);
    const alerts = readFileSync(new URL('../../../../../infra/monitoring/alerts.yml', import.meta.url), 'utf8');
    expect(alerts).toContain('partner_webhook_deliveries_total');
    expect(alerts).toContain('partner_webhook_delivery_duration_seconds_bucket');
  });
});
