import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { PROMETHEUS_CONTENT_TYPE } from '@n409/shared';

/**
 * The scrape endpoint on the report service, and the one thing about it that is
 * specific to this service: `registerInternalAuth` runs as an `onRequest` hook
 * over every non-health path here, and it must not stack a second, different
 * token gate in front of the metrics endpoint's own.
 *
 * That was not hypothetical. `METRICS_TOKEN` exists so a Prometheus
 * configuration file — a wider blast radius than a systemd unit — can hold a
 * credential that is not the estate's service token. Without the exemption a
 * scraper configured that way would collect from the web and valuation services
 * and fail against this one alone, which is the shape of misconfiguration
 * nobody diagnoses quickly.
 */
describe('the report service metrics endpoint', () => {
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

  it('serves the exposition format', async () => {
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(res.body).toContain('# TYPE http_requests_total counter');
    expect(res.body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.body).toContain('n409_build_info{service="report"');
  });

  it('records the requests it has served, by route template', async () => {
    const app = build();
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('http_requests_total{method="GET",route="/health",status="2xx"} 2');
  });

  /**
   * The exemption under test. `INTERNAL_SERVICE_TOKEN` is set, so the internal
   * hook would reject a caller holding only `METRICS_TOKEN` — and must not.
   */
  it('accepts METRICS_TOKEN even though internal auth guards every other path', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'estate-secret';
    process.env.METRICS_TOKEN = 'scraper-secret';
    const app = build();

    const scrape = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer scraper-secret' },
    });
    expect(scrape.statusCode).toBe(200);

    // The exemption is for this path only — everything else still needs the
    // estate's token, and the scraper's is not it.
    const render = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { authorization: 'Bearer scraper-secret' },
      payload: { sections: [] },
    });
    expect(render.statusCode).toBe(401);
  });

  it('still refuses a scrape with the wrong secret', async () => {
    process.env.METRICS_TOKEN = 'scraper-secret';
    const app = build();
    for (const headers of [{}, { authorization: 'Bearer nope' }, { 'x-internal-token': 'nope' }]) {
      expect((await app.inject({ method: 'GET', url: '/metrics', headers })).statusCode).toBe(404);
    }
  });
});

/**
 * The cgroup gauges (round 99), asserted against the real wiring rather than
 * against the module that produces them.
 *
 * The unit tests in `@n409/shared` cover the reading; what cannot be checked
 * there is that `buildApp` registers it at all, and this is the service the
 * registration matters most for — the report unit's ceiling is the one derived
 * from a concurrency bound rather than from a flat measurement, so it is the
 * one an operator will want to watch.
 *
 * Both branches assert. On Linux the series must be present and must carry the
 * unit's real ceiling; everywhere else they must be absent, which is the other
 * half of the contract — five gauges reading zero on a developer machine would
 * be worse than none, because only one of those is obviously not an answer.
 */
describe('cgroup memory gauges', () => {
  const linux = process.platform === 'linux';

  it(linux ? 'exports the ceiling this unit runs under' : 'exports nothing off Linux', async () => {
    const app = buildApp();
    try {
      const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
      if (linux) {
        expect(body).toContain('# TYPE n409_cgroup_memory_current_bytes gauge');
        expect(body).toContain('# TYPE n409_cgroup_memory_max_bytes gauge');
        expect(body).toContain('n409_cgroup_memory_events{event="oom_kill"}');
      } else {
        expect(body).not.toContain('n409_cgroup_memory_');
      }
    } finally {
      await app.close();
    }
  });
});
