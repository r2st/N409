import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The one request an operator makes before they know what is wrong.
 *
 * Every figure here except the error rates was already reachable, spread over
 * six endpoints — the job backlog, the webhook queue, the pool, the slow
 * statements, the dashboard, the email stats. Each answers a question you have
 * to already know to ask, and the first minute of an incident is spent asking
 * all of them in turn.
 *
 * The error rates are the genuinely new part. `createHttpMetrics` records RED
 * into the OpenTelemetry API, which without a collector wired is a no-op
 * provider, so nothing could be asked over HTTP about this process's own 5xx
 * rate — the number every other signal on the page is context for.
 */
describe.skipIf(!dbUp)('the system metrics endpoint', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let opsToken: string;
  let clientToken: string;

  const metrics = (token: string, query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/admin/system/metrics${query}`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    // One optional subsystem deliberately on and one deliberately off, so the
    // capability roster below is asserted against a config that says both
    // things. With everything off, "reports it as off" would pass against a
    // roster that had stopped reading the config at all.
    ctx = await setupTestApp({ DOCUMENTS_ENCRYPTION_KEY: 'a'.repeat(64) });
    app = ctx.app;
    opsToken = (await seedUser(ctx, { roles: ['reviewer'] })).token;
    clientToken = (await seedUser(ctx, { roles: ['client'] })).token;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  it('answers the whole question in one round trip', async () => {
    const res = await metrics(opsToken);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Named individually rather than by snapshot: a key silently disappearing
    // is exactly the failure an operator meets at the worst moment.
    expect(body).toHaveProperty('build_sha');
    expect(body).toHaveProperty('uptime_s');
    expect(body).toHaveProperty('error_rates');
    expect(body).toHaveProperty('valuations');
    expect(body).toHaveProperty('throughput');
    expect(body).toHaveProperty('webhooks');
    expect(body).toHaveProperty('circuits');
    expect(body).toHaveProperty('capabilities');
    expect(body.service).toBe('valuation');
  });

  it('names the subsystems that are deliberately off', async () => {
    // `circuits` above answers "is what we depend on failing". This answers the
    // question nothing on this platform could be asked: is there something we
    // are simply not doing. In the test environment that is virus scanning —
    // no CLAMAV_HOST — and the point of the row is the sentence beside it,
    // because "virus_scanning: false" does not tell an operator that the file
    // was nonetheless stored and will be served back.
    const caps = (await metrics(opsToken)).json().capabilities as Array<{
      key: string;
      configured: boolean;
      severity: string;
      fallback: string;
      env: string[];
    }>;
    expect(Array.isArray(caps)).toBe(true);

    const scanning = caps.find((c) => c.key === 'virus_scanning')!;
    expect(scanning.configured).toBe(false);
    expect(scanning.severity).toBe('silent');
    expect(scanning.env).toEqual(['CLAMAV_HOST']);
    expect(scanning.fallback).toMatch(/without being scanned/i);

    // The vacuity guard: the roster must not be a list of everything-off. The
    // test app configures document encryption, so that row proves `configured`
    // can come out true through the real config rather than only in the unit
    // test's hand-built object.
    const encryption = caps.find((c) => c.key === 'document_encryption')!;
    expect(encryption.configured).toBe(true);
  });

  it('counts the requests it has served, including its own', async () => {
    // The hook is on every response, so the metrics call before this one is
    // itself in the window. That is the property: it measures this process,
    // not a table.
    const res = await metrics(opsToken);
    expect(res.json().error_rates.requests).toBeGreaterThan(0);
    expect(res.json().error_rates.error_rate).toBeGreaterThanOrEqual(0);
  });

  it('separates a refused request from a broken one', async () => {
    // A 403 is the caller's problem and must not move the server-error rate —
    // otherwise a permissions probe reads as an outage.
    const before = (await metrics(opsToken)).json().error_rates;
    await metrics(clientToken);
    const after = (await metrics(opsToken)).json().error_rates;

    expect(after.client_errors).toBeGreaterThan(before.client_errors);
    expect(after.server_errors).toBe(before.server_errors);
  });

  it('attributes a route by its template, not by the ids in it', async () => {
    await metrics(opsToken);
    const routes = (await metrics(opsToken)).json().error_rates.worst_routes as Array<{
      route: string;
    }>;
    expect(routes.some((r) => r.route === '/api/v1/admin/system/metrics')).toBe(true);
  });

  it('narrows the window when asked', async () => {
    const res = await metrics(opsToken, '?window_minutes=5');
    expect(res.statusCode).toBe(200);
    expect(res.json().error_rates.window_minutes).toBe(5);
  });

  it('refuses a window it cannot serve rather than silently clamping', async () => {
    // A dashboard asking for a day and being handed an hour labelled as a day
    // would draw the wrong picture with no way to tell.
    expect((await metrics(opsToken, '?window_minutes=1440')).statusCode).toBe(400);
    expect((await metrics(opsToken, '?window_minutes=nonsense')).statusCode).toBe(400);
  });

  it('is ops-only — it names upstreams, routes and the pool', async () => {
    expect((await metrics(clientToken)).statusCode).toBe(403);
  });

  it('requires authentication at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/system/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('agrees with the endpoint each figure came from', async () => {
    // The composition property. Two definitions of "active" that drift is the
    // failure mode of an aggregate view, so the numbers are asserted equal to
    // the dedicated endpoints rather than merely present.
    const [system, webhookStats] = await Promise.all([
      metrics(opsToken),
      app.inject({
        method: 'GET',
        url: '/api/v1/admin/webhooks/deliveries/stats',
        headers: authHeader(opsToken),
      }),
    ]);

    expect(system.json().webhooks).toEqual(webhookStats.json());

    const counts = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations/counts',
      headers: authHeader(opsToken),
    });
    expect(system.json().valuations).toEqual(counts.json().counts);
  });
});
