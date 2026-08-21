import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { PROMETHEUS_CONTENT_TYPE } from '@n409/shared';

/**
 * The scrape endpoint on the web service — the one that matters most, because
 * this is the origin the public actually reaches. Caddy proxies every path on
 * port 3000 straight through to this process, so an ungated `/metrics` here
 * would publish a route inventory of the whole platform, plus how often each
 * route is hit and how often each one fails, to anyone who asked.
 *
 * The gate is therefore the subject of most of this file, and the production
 * case is the one worth pinning: with no secret set the route is not registered
 * at all, and answers 404 rather than 401, so an unconfigured deployment does
 * not advertise that there is something here worth getting a credential for.
 */
describe('the web service metrics endpoint', () => {
  const apps: FastifyInstance[] = [];
  const saved = { ...process.env };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    process.env = { ...saved };
  });

  const build = () => {
    const app = buildApp();
    apps.push(app);
    return app;
  };

  it('serves the exposition format outside production with no secret set', async () => {
    delete process.env.METRICS_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('n409_build_info{service="web"');
    expect(res.body).toContain('# TYPE http_requests_in_flight gauge');
  });

  it('requires the secret once one is configured', async () => {
    process.env.METRICS_TOKEN = 'scraper-secret';
    const app = build();
    expect((await app.inject({ method: 'GET', url: '/metrics' })).body).not.toContain('http_requests_total');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer scraper-secret' },
        })
      ).statusCode,
    ).toBe(200);
  });

  /**
   * The public-origin case. Nothing is configured and NODE_ENV is production,
   * so the route is never registered — and on this service that means the SPA
   * fallback answers it, exactly as it answers any other path the app does not
   * have. A 200 carrying `index.html` is the right outcome here: the response
   * is indistinguishable from `/anything-else`, so nothing tells a scanner
   * there is a metrics endpoint on this platform to go looking for.
   */
  it('is not registered in production without a secret, and leaks nothing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const app = build();

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    const unrelated = await app.inject({ method: 'GET', url: '/not-a-route-at-all' });
    expect(res.body).not.toContain('http_requests_total');
    // Not registered at all, so the SPA fallback took it — byte-identical to
    // any other path this app does not have.
    expect(res.statusCode).toBe(unrelated.statusCode);
    expect(res.headers['content-type']).toBe(unrelated.headers['content-type']);
    expect(res.body).toBe(unrelated.body);
  });

  /**
   * A rejected scrape gets the service's own not-found handler, not a body
   * written by the metrics endpoint.
   *
   * Worth being exact about what that does and does not buy on *this* service:
   * the SPA fallback is an `/*` route, not the not-found handler, so an unknown
   * path here answers 200 with `index.html` while a rejected scrape answers
   * 404. The two are therefore distinguishable, and the token is what is doing
   * the work — `/metrics` is a guessable path on any instrumented service and
   * hiding it was never the defence.
   */
  it('hands a wrong secret to the not-found handler, serving no metrics', async () => {
    process.env.METRICS_TOKEN = 'scraper-secret';
    const app = build();

    const rejected = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.body).not.toContain('http_requests_total');
    expect(rejected.body).not.toContain('n409_build_info');
  });

  it('counts the requests it served, with id segments collapsed', async () => {
    delete process.env.METRICS_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const app = build();
    await app.inject({ method: 'GET', url: '/health' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('http_requests_total{method="GET",route="/health",status="2xx"} 1');
    expect(body).toContain('http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 1');
  });
});
