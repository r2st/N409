import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The background job monitor — one feed over five queues that each have their
 * own status vocabulary.
 */
describe.skipIf(!dbUp)('job monitor API', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const jobs = async (token: string, query = '') => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/jobs${query}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      jobs: Array<{
        id: string;
        source: string;
        status: string;
        detail: string;
        name: string;
        valuation_id: string | null;
        company_name: string | null;
        duration_ms: number | null;
        error: string | null;
      }>;
      total: number;
    };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Queue Co' },
    });
    valuationId = created.json().valuation.id;

    // One row in each of the five queues, chosen so every branch of the union
    // is exercised and every status vocabulary appears at least once.
    await ctx.pool.query(
      `INSERT INTO pipeline_runs (id, valuation_id, trigger, status, created_at, updated_at)
       VALUES ($1, $2, 'upload', 'extracting', now() - interval '5 minutes', now())`,
      [newUlid(), valuationId],
    );
    await ctx.pool.query(
      `INSERT INTO ai_jobs (id, valuation_id, pipeline, status, model, error, created_at, completed_at)
       VALUES ($1, $2, 'extract', 'failed', 'claude-opus-5', 'upstream timeout',
               now() - interval '10 minutes', now() - interval '9 minutes')`,
      [newUlid(), valuationId],
    );
    await ctx.pool.query(
      `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, created_at)
       VALUES ($1, $2, '1.4.0', 'succeeded', '{}'::jsonb, now() - interval '20 minutes')`,
      [newUlid(), valuationId],
    );
    await ctx.pool.query(
      `INSERT INTO email_outbox (id, valuation_id, to_email, template_key, subject, body, status, created_at)
       VALUES ($1, $2, 'c@example.com', 'draft_ready', 'Draft ready', 'body', 'skipped',
               now() - interval '30 minutes')`,
      [newUlid(), valuationId],
    );

    const partnerId = await seedPartner(ctx, 'Hooked Firm');
    const webhookId = newUlid();
    await ctx.pool.query(
      `INSERT INTO partner_webhooks (id, partner_id, url, secret) VALUES ($1, $2, 'https://x.test/h', 's')`,
      [webhookId, partnerId],
    );
    await ctx.pool.query(
      // `next_attempt_at` is set alongside `created_at`, not left to its
      // `DEFAULT now()`: this fixture is a delivery that has been due for two
      // hours and not picked up, and the monitor now distinguishes that from a
      // delivery created two hours ago that is deliberately waiting out its
      // backoff. See jobAlertsBackoff.test.ts.
      `INSERT INTO partner_webhook_deliveries
         (id, webhook_id, event_type, valuation_id, payload, status, attempts, created_at, next_attempt_at)
       VALUES ($1, $2, 'valuation.published', $3, '{}'::jsonb, 'pending', 2,
               now() - interval '2 hours', now() - interval '2 hours')`,
      [newUlid(), webhookId, valuationId],
    );
  });
  afterAll(async () => ctx?.teardown());

  it('is operations-only', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('reads all five queues as one feed, newest first', async () => {
    const body = await jobs(admin.token);
    expect(body.total).toBe(5);
    expect(new Set(body.jobs.map((j) => j.source))).toEqual(
      new Set(['pipeline_run', 'ai_job', 'calculation', 'email', 'webhook_delivery']),
    );
    // The pipeline run is the most recent of the five.
    expect(body.jobs[0]!.source).toBe('pipeline_run');
  });

  it('normalises each queue’s vocabulary while keeping it visible', async () => {
    const body = await jobs(admin.token);
    const bySource = Object.fromEntries(body.jobs.map((j) => [j.source, j]));
    expect(bySource.pipeline_run).toMatchObject({ status: 'running', detail: 'extracting' });
    expect(bySource.webhook_delivery).toMatchObject({ status: 'queued', detail: 'pending', attempts: 2 });
    expect(bySource.email).toMatchObject({ status: 'skipped', detail: 'skipped' });
  });

  it('filters by the common status, across sources', async () => {
    // `pending` and `extracting` are two tables' words for two different
    // things; "outstanding" is the one an operator asks in.
    const active = await jobs(admin.token, '?status=queued');
    expect(active.jobs.map((j) => j.source)).toEqual(['webhook_delivery']);
    const running = await jobs(admin.token, '?status=running');
    expect(running.jobs.map((j) => j.source)).toEqual(['pipeline_run']);
  });

  it('filters by source and by engagement', async () => {
    expect((await jobs(admin.token, '?source=ai_job')).total).toBe(1);
    expect((await jobs(admin.token, `?valuation_id=${valuationId}`)).total).toBe(5);
    expect((await jobs(admin.token, `?valuation_id=${newUlid()}`)).total).toBe(0);
  });

  it('labels each row with the engagement it belongs to', async () => {
    const body = await jobs(admin.token, '?source=ai_job');
    expect(body.jobs[0]).toMatchObject({ company_name: 'Queue Co', name: 'extract' });
  });

  it('carries the error text through for a failed job', async () => {
    const body = await jobs(admin.token, '?status=failed');
    expect(body.jobs[0]).toMatchObject({ source: 'ai_job', error: 'upstream timeout' });
  });

  it('computes a duration only where both ends are known', async () => {
    const body = await jobs(admin.token);
    const ai = body.jobs.find((j) => j.source === 'ai_job')!;
    expect(ai.duration_ms).toBeGreaterThan(50_000); // one minute, give or take
    // Still running: no end, so no duration rather than a made-up one.
    expect(body.jobs.find((j) => j.source === 'pipeline_run')!.duration_ms).toBeNull();
    // A calculation is written when the engine returns, so its span is zero.
    expect(body.jobs.find((j) => j.source === 'calculation')!.duration_ms).toBe(0);
  });

  it('pages the union', async () => {
    const first = await jobs(admin.token, '?per_page=2&page=1');
    const second = await jobs(admin.token, '?per_page=2&page=2');
    expect(first.jobs).toHaveLength(2);
    expect(second.jobs).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.jobs.map((j) => j.id)).not.toEqual(second.jobs.map((j) => j.id));
  });

  describe('stats', () => {
    const stats = async (query = '') => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/jobs/stats${query}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      return res.json() as {
        totals: { active: number; failed: number; succeeded: number; skipped: number };
        by_source: Array<{ source: string; active: number; oldest_active_at: string | null }>;
      };
    };

    it('rolls the five queues into four totals', async () => {
      const body = await stats();
      expect(body.totals).toEqual({ active: 2, failed: 1, succeeded: 1, skipped: 1 });
    });

    it('reports every source, including the idle ones', async () => {
      const body = await stats();
      expect(body.by_source).toHaveLength(5);
      expect(body.by_source.find((s) => s.source === 'calculation')!.oldest_active_at).toBeNull();
    });

    it('surfaces the oldest outstanding item per queue', async () => {
      const body = await stats();
      const hook = body.by_source.find((s) => s.source === 'webhook_delivery')!;
      expect(hook.active).toBe(1);
      expect(new Date(hook.oldest_active_at!).getTime()).toBeLessThan(Date.now() - 3_600_000);
    });

    it('keeps outstanding work visible however old, past the window', async () => {
      // A run that queued days ago and never moved is the single most
      // important row on the page, and a trailing window is exactly what
      // would hide it.
      const body = await stats('?since_hours=1');
      expect(body.totals.active).toBe(2);
      // The finished rows inside the window still count; the two-hour-old
      // webhook is counted because it is still owed, not because it is recent.
      expect(body.totals.succeeded).toBe(1);
    });
  });
});
