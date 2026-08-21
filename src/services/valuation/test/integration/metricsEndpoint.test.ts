import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROMETHEUS_CONTENT_TYPE } from '@n409/shared';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** The value of a single unlabelled series, or undefined if it is absent. */
function series(body: string, name: string): string | undefined {
  const line = body.split('\n').find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  return line?.split(' ').pop();
}

/**
 * `GET /metrics` on the valuation service.
 *
 * The endpoint is registered inside `buildApp`, like the request drain and for
 * the same reason: it is a property of the app rather than of the composition
 * root, so this suite exercises the deployed wiring instead of a second copy of
 * it. The gauges that only `index.ts` can supply — the pg pool's own counters —
 * are therefore absent here, which is itself worth pinning: their absence must
 * not break the scrape.
 */
describe.skipIf(!dbUp)('the valuation metrics endpoint', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  it('serves the exposition format with the process and build gauges', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatch(/n409_build_info\{service="valuation",sha="[^"]*",source="[^"]*"\} 1/);
    expect(res.body).toContain('# TYPE process_uptime_seconds gauge');
    expect(res.body).toContain('# TYPE process_resident_memory_bytes gauge');
  });

  it('exposes the in-process queue depths as gauges', async () => {
    const body = (await ctx.app.inject({ method: 'GET', url: '/metrics' })).body;
    // Quiet app: nothing orchestrating, no streams, and the scrape itself is
    // the only request in flight while it renders.
    expect(series(body, 'auto_pipeline_runs_active')).toBe('0');
    expect(series(body, 'auto_pipeline_runs_pending')).toBe('0');
    expect(series(body, 'realtime_streams_open')).toBe('0');
    expect(series(body, 'http_requests_in_flight')).toBe('1');
  });

  it('counts requests by route template rather than by url', async () => {
    // Two different ids, one series: `routeLabel` collapses the ULID segment.
    await ctx.app.inject({ method: 'GET', url: '/api/v1/valuations/01J0000000000000000000000A' });
    await ctx.app.inject({ method: 'GET', url: '/api/v1/valuations/01J0000000000000000000000B' });
    const body = (await ctx.app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toContain('route="/api/v1/valuations/:id"');
    // Unauthenticated, so 4xx — the point here is the label, not the status.
    const line = body
      .split('\n')
      .find((l) => l.startsWith('http_requests_total{method="GET",route="/api/v1/valuations/:id"'));
    expect(line?.split(' ').pop()).toBe('2');
  });

  it('records a duration histogram alongside the counter', async () => {
    const body = (await ctx.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(body).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="\+Inf"\} \d+/);
    expect(body).toMatch(/http_request_duration_seconds_sum\{[^}]*\} [\d.e-]+/);
  });

  /**
   * `assertRoutesGuarded` fails the boot on any route that has neither
   * `app.authenticate` nor an entry in PUBLIC_ROUTES. `/metrics` is in that
   * list — it cannot use the session guard, because a scraper has no session —
   * so this is the assertion that the exemption was actually declared rather
   * than the audit being satisfied some other way.
   */
  it('boots with the route audit satisfied', async () => {
    await ctx.app.ready();
    expect((await ctx.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });
});
