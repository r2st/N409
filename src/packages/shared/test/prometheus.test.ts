import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DURATION_BUCKETS,
  MAX_SERIES_PER_METRIC,
  METRICS_TOKEN_ENV,
  MetricsRegistry,
  OVERFLOW_LABEL,
  PROMETHEUS_CONTENT_TYPE,
  escapeHelp,
  escapeLabelValue,
  formatValue,
  metricsToken,
  registerHttpMetrics,
  registerMetricsEndpoint,
  registerProcessMetrics,
} from '../src/prometheus.js';

/** The series lines of one metric family, headers stripped. */
function seriesOf(text: string, name: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${name}{`) || l === name || l.startsWith(`${name} `))
    .sort();
}

function headerOf(text: string, name: string): string[] {
  return text.split('\n').filter((l) => l.startsWith(`# HELP ${name} `) || l.startsWith(`# TYPE ${name} `));
}

describe('exposition-format escaping', () => {
  it('escapes backslash, quote and newline in a label value', () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it('leaves a quote alone in HELP text, which does not escape it', () => {
    expect(escapeHelp('a "quoted" \\ thing\nnext')).toBe('a "quoted" \\\\ thing\\nnext');
  });

  it('spells the non-finite values the way Prometheus reads them', () => {
    expect(formatValue(Infinity)).toBe('+Inf');
    expect(formatValue(-Infinity)).toBe('-Inf');
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(1.5)).toBe('1.5');
    expect(formatValue(0)).toBe('0');
  });
});

describe('MetricsRegistry names', () => {
  it('refuses a metric name the format does not allow', () => {
    const r = new MetricsRegistry();
    expect(() => r.counter('http-requests', 'no dashes')).toThrow(/Invalid Prometheus metric name/);
    expect(() => r.counter('1_requests', 'no leading digit')).toThrow(/Invalid Prometheus metric name/);
    // Colons are legal in a metric name (they are the recording-rule convention).
    expect(() => r.counter('job:requests:rate5m', 'fine')).not.toThrow();
  });

  it('refuses a label name the format does not allow', () => {
    const r = new MetricsRegistry();
    expect(() => r.counter('requests_total', 'x', ['status-code'])).toThrow(/Invalid Prometheus label name/);
    // `le` belongs to histogram buckets and would collide with them.
    expect(() => r.histogram('d_seconds', 'x', ['le'])).toThrow(/reserved for histogram buckets/);
  });

  it('returns the same instrument when a name is registered twice', () => {
    const r = new MetricsRegistry();
    const a = r.counter('requests_total', 'first');
    const b = r.counter('requests_total', 'second');
    expect(b).toBe(a);
    const h1 = r.histogram('d_seconds', 'first');
    expect(r.histogram('d_seconds', 'second')).toBe(h1);
    // Two registrations of one gauge must not produce two series.
    r.gauge('depth', 'first', () => 1);
    r.gauge('depth', 'second', () => 2);
    expect(seriesOf(r.render(), 'depth')).toEqual(['depth 1']);
  });

  it('renders nothing at all for an empty registry', () => {
    expect(new MetricsRegistry().render()).toBe('');
  });
});

describe('Counter', () => {
  it('counts per label set and renders one line each', () => {
    const r = new MetricsRegistry();
    const c = r.counter('http_requests_total', 'requests', ['method', 'route']);
    c.inc({ method: 'GET', route: '/a' });
    c.inc({ method: 'GET', route: '/a' });
    c.inc({ method: 'POST', route: '/b' }, 3);

    expect(c.get({ method: 'GET', route: '/a' })).toBe(2);
    expect(c.get({ method: 'POST', route: '/b' })).toBe(3);
    expect(c.get({ method: 'PUT', route: '/z' })).toBe(0);

    const text = r.render();
    expect(headerOf(text, 'http_requests_total')).toEqual([
      '# HELP http_requests_total requests',
      '# TYPE http_requests_total counter',
    ]);
    expect(seriesOf(text, 'http_requests_total')).toEqual([
      'http_requests_total{method="GET",route="/a"} 2',
      'http_requests_total{method="POST",route="/b"} 3',
    ]);
  });

  it('renders a bare name when the metric has no labels', () => {
    const r = new MetricsRegistry();
    r.counter('boots_total', 'boots').inc();
    expect(seriesOf(r.render(), 'boots_total')).toEqual(['boots_total 1']);
  });

  it('treats a missing label as empty rather than throwing on the request path', () => {
    const r = new MetricsRegistry();
    const c = r.counter('requests_total', 'x', ['method', 'route']);
    c.inc({ method: 'GET' });
    expect(seriesOf(r.render(), 'requests_total')).toEqual(['requests_total{method="GET",route=""} 1']);
  });

  // A counter that goes backwards makes every `rate()` over it wrong for the
  // life of the process, and the caller is a hook with nothing to check.
  it('ignores a negative or non-finite increment', () => {
    const r = new MetricsRegistry();
    const c = r.counter('requests_total', 'x');
    c.inc(undefined, 5);
    c.inc(undefined, -3);
    c.inc(undefined, Number.NaN);
    c.inc(undefined, Infinity);
    expect(c.get()).toBe(5);
  });

  /**
   * The failure this cap exists for: a scanner walking `/wp-admin`, `/.env`
   * and a thousand friends against a public origin would otherwise mint a
   * series each, none of which is ever freed.
   */
  it('folds everything past the cap into one reserved series, keeping the total exact', () => {
    const r = new MetricsRegistry(3);
    const c = r.counter('requests_total', 'x', ['route']);
    c.inc({ route: '/a' });
    c.inc({ route: '/b' });
    c.inc({ route: '/c' });
    for (let i = 0; i < 50; i += 1) c.inc({ route: `/scan-${i}` });

    // Three real series plus the one overflow series, and nothing more.
    expect(c.cardinality).toBe(4);
    expect(c.truncated).toBe(true);
    expect(c.get({ route: OVERFLOW_LABEL })).toBe(50);

    const lines = seriesOf(r.render(), 'requests_total');
    expect(lines).toHaveLength(4);
    expect(lines).toContain(`requests_total{route="${OVERFLOW_LABEL}"} 50`);
    // The totals are what stay exact; attribution is what degrades.
    const total = lines.reduce((n, l) => n + Number(l.split(' ').pop()), 0);
    expect(total).toBe(53);
  });

  it('reports itself untruncated while it is under the cap', () => {
    const c = new MetricsRegistry(3).counter('requests_total', 'x', ['route']);
    c.inc({ route: '/a' });
    expect(c.truncated).toBe(false);
    expect(c.cardinality).toBe(1);
  });

  // The default a service gets when it does not choose one. Asserted so the
  // number the module documents and the number it enforces cannot drift.
  it('caps at MAX_SERIES_PER_METRIC by default', () => {
    const c = new MetricsRegistry().counter('requests_total', 'x', ['route']);
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 25; i += 1) c.inc({ route: `/r-${i}` });
    expect(c.cardinality).toBe(MAX_SERIES_PER_METRIC + 1);
    expect(c.get({ route: OVERFLOW_LABEL })).toBe(25);
  });

  /**
   * Two label sets must never collide into one series. With a space or a comma
   * as the key separator, `{a: "x y", b: ""}` and `{a: "x", b: "y"}` are the
   * same key — and label values here come from route paths.
   */
  it('keeps label sets distinct when a value contains the separator', () => {
    const r = new MetricsRegistry();
    const c = r.counter('requests_total', 'x', ['a', 'b']);
    c.inc({ a: 'x y', b: '' });
    c.inc({ a: 'x', b: 'y' });
    c.inc({ a: 'x,y', b: '' });
    expect(c.cardinality).toBe(3);
    expect(c.get({ a: 'x y', b: '' })).toBe(1);
    expect(c.get({ a: 'x', b: 'y' })).toBe(1);
  });
});

describe('Histogram', () => {
  it('renders cumulative buckets, a sum and a count', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('d_seconds', 'duration', [], [0.1, 0.5, 1]);
    h.observe(0.05);
    h.observe(0.3);
    h.observe(0.75);

    expect(h.get()).toEqual({ count: 3, sum: 0.05 + 0.3 + 0.75 });
    const text = r.render();
    expect(headerOf(text, 'd_seconds')).toEqual(['# HELP d_seconds duration', '# TYPE d_seconds histogram']);
    const lines = text.split('\n').filter((l) => l.startsWith('d_seconds'));
    expect(lines).toEqual([
      'd_seconds_bucket{le="0.1"} 1',
      'd_seconds_bucket{le="0.5"} 2',
      'd_seconds_bucket{le="1"} 3',
      'd_seconds_bucket{le="+Inf"} 3',
      `d_seconds_sum ${0.05 + 0.3 + 0.75}`,
      'd_seconds_count 3',
    ]);
  });

  /** An observation past the largest bound lands in no bucket, so `+Inf` has
   *  to come from the count rather than from the running total. */
  it('counts an observation past the largest bound only in +Inf', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('d_seconds', 'duration', [], [0.1, 0.5]);
    h.observe(0.05);
    h.observe(99);
    const lines = r
      .render()
      .split('\n')
      .filter((l) => l.startsWith('d_seconds_bucket'));
    expect(lines).toEqual([
      'd_seconds_bucket{le="0.1"} 1',
      'd_seconds_bucket{le="0.5"} 1',
      'd_seconds_bucket{le="+Inf"} 2',
    ]);
  });

  it('sorts and de-duplicates the bounds it was given', () => {
    const h = new MetricsRegistry().histogram('d_seconds', 'x', [], [1, 0.1, 0.5, 1, 0.1]);
    expect(h.bounds).toEqual([0.1, 0.5, 1]);
  });

  it('drops a non-finite observation rather than poisoning the sum forever', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('d_seconds', 'x', [], [1]);
    h.observe(0.5);
    h.observe(Infinity);
    h.observe(Number.NaN);
    expect(h.get()).toEqual({ count: 1, sum: 0.5 });
  });

  it('carries labels onto every bucket, sum and count line', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('d_seconds', 'x', ['route'], [1]);
    h.observe(0.5, { route: '/a' });
    const lines = r
      .render()
      .split('\n')
      .filter((l) => l.startsWith('d_seconds'));
    expect(lines).toEqual([
      'd_seconds_bucket{route="/a",le="1"} 1',
      'd_seconds_bucket{route="/a",le="+Inf"} 1',
      'd_seconds_sum{route="/a"} 0.5',
      'd_seconds_count{route="/a"} 1',
    ]);
  });

  it('reports zero for a label set it has never seen', () => {
    const h = new MetricsRegistry().histogram('d_seconds', 'x', ['route'], [1]);
    expect(h.get({ route: '/nope' })).toEqual({ count: 0, sum: 0 });
  });

  it('folds past the cap like a counter does', () => {
    const r = new MetricsRegistry(2);
    const h = r.histogram('d_seconds', 'x', ['route'], [1]);
    h.observe(0.1, { route: '/a' });
    h.observe(0.1, { route: '/b' });
    h.observe(0.1, { route: '/c' });
    h.observe(0.1, { route: '/d' });
    expect(h.cardinality).toBe(3);
    expect(h.get({ route: OVERFLOW_LABEL })).toEqual({ count: 2, sum: 0.2 });
  });

  it('defaults to the shared duration buckets', () => {
    const h = new MetricsRegistry().histogram('d_seconds', 'x');
    expect(h.bounds).toEqual([...DEFAULT_DURATION_BUCKETS]);
  });
});

describe('observable gauges', () => {
  it('renders a plain number as a single unlabelled series', () => {
    const r = new MetricsRegistry();
    let depth = 4;
    r.gauge('queue_depth', 'jobs waiting', () => depth);
    expect(seriesOf(r.render(), 'queue_depth')).toEqual(['queue_depth 4']);
    // Sampled at scrape time, not at registration.
    depth = 9;
    expect(seriesOf(r.render(), 'queue_depth')).toEqual(['queue_depth 9']);
  });

  it('renders one series per reading when the gauge is labelled', () => {
    const r = new MetricsRegistry();
    r.gauge(
      'queue_depth',
      'jobs waiting',
      () => [
        { value: 1, labels: { queue: 'email' } },
        { value: 7, labels: { queue: 'webhook' } },
      ],
      ['queue'],
    );
    expect(seriesOf(r.render(), 'queue_depth')).toEqual([
      'queue_depth{queue="email"} 1',
      'queue_depth{queue="webhook"} 7',
    ]);
  });

  /** Losing one series is recoverable; losing the endpoint during an incident
   *  is the thing this module exists to prevent. */
  it('drops a gauge whose collector throws, and keeps the rest of the scrape', () => {
    const r = new MetricsRegistry();
    r.counter('boots_total', 'boots').inc();
    r.gauge('broken', 'x', () => {
      throw new Error('pool is gone');
    });
    const text = r.render();
    expect(text).toContain('boots_total 1');
    expect(seriesOf(text, 'broken')).toEqual([]);
  });

  it('counts the drop, in the same scrape it happened in', () => {
    /*
     * R341, M11. Dropping the gauge is right and stays; being silent about it
     * was not. An absent series is the one reading a Prometheus rule cannot
     * tell apart from a healthy one, and most of the page-severity rules in
     * `infra/monitoring/alerts.yml` are gauge-backed — `SweepStopped`,
     * `UpstreamCircuitOpen`, `PoolSaturated`, `JobQueueAlertOpen`,
     * `MemoryCeilingMissing`. A `collect` that throws on every scrape takes its
     * rule with it for as long as the process lives.
     *
     * "In the same scrape" is the half worth pinning. The counter renders after
     * the gauges are collected precisely so this scrape reports this scrape's
     * failure; collected in map order, the increment would land after the
     * counter had already been written and would not surface until the next
     * body — which for a gauge that throws once, on the scrape somebody is
     * reading, is never.
     */
    const r = new MetricsRegistry();
    r.gauge('broken', 'x', () => {
      throw new Error('pool is gone');
    });
    r.gauge('fine', 'y', () => 3);

    const text = r.render();
    expect(text).toContain('n409_metric_collect_failures_total{metric="broken"} 1');
    expect(text).toContain('fine 3');
    // Two scrapes, two failures: this is a per-scrape condition, not a latch.
    expect(r.render()).toContain('n409_metric_collect_failures_total{metric="broken"} 2');
  });

  it('registers the failure counter only once something has failed', () => {
    // A permanent zero is a series an operator learns to ignore, and it would
    // also put an instrument nothing uses into `seriesCensus`.
    const r = new MetricsRegistry();
    r.gauge('fine', 'y', () => 3);
    expect(r.render()).not.toContain('n409_metric_collect_failures_total');
    expect(r.seriesCensus()).toEqual([]);
  });

  it('refuses an invalid gauge name', () => {
    expect(() => new MetricsRegistry().gauge('queue-depth', 'x', () => 1)).toThrow(
      /Invalid Prometheus metric name/,
    );
  });
});

describe('registerProcessMetrics', () => {
  it('exposes uptime, memory and the build as an info gauge', () => {
    const r = new MetricsRegistry();
    registerProcessMetrics(r, 'valuation', {
      uptime: () => 42,
      memoryUsage: () =>
        ({ rss: 100, heapUsed: 20, heapTotal: 30, external: 0, arrayBuffers: 0 }) as NodeJS.MemoryUsage,
    } as Pick<NodeJS.Process, 'uptime' | 'memoryUsage'>);

    const text = r.render();
    expect(text).toContain('process_uptime_seconds 42');
    expect(text).toContain('process_resident_memory_bytes 100');
    expect(text).toContain('nodejs_heap_used_bytes 20');
    expect(text).toContain('nodejs_heap_total_bytes 30');
    expect(text).toMatch(/n409_build_info\{service="valuation",sha="[^"]*",source="[^"]*"\} 1/);
  });

  it('exposes event loop lag as a gauge', () => {
    const r = new MetricsRegistry();
    registerProcessMetrics(r, 'valuation');
    const text = r.render();
    expect(headerOf(text, 'nodejs_eventloop_lag_seconds')).toEqual([
      expect.stringContaining('# HELP nodejs_eventloop_lag_seconds'),
      '# TYPE nodejs_eventloop_lag_seconds gauge',
    ]);
    const series = seriesOf(text, 'nodejs_eventloop_lag_seconds');
    expect(series).toHaveLength(1);
    const value = parseFloat(series[0]!.split(' ')[1]!);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('reports what each instrument is holding, and which have begun folding', () => {
    /*
     * R341, M11. `cardinality` and `truncated` have been computed since the cap
     * was written and read by nothing but this file. So the one event the
     * module header names as the cost of the cap — "attribution is what
     * degrades" — reached no channel at all: a dashboard grouped by `route`
     * simply starts showing `__other__` beside the real routes, as if it were
     * one of them.
     *
     * It is not a cosmetic loss. Totals stay exact, so every `sum by (job)`
     * rule keeps answering; a rule that *selects* a label value
     * (`outcome="unsettled"`, `sweep="job-alerts"`) stops matching the folded
     * readings entirely, because they are filed under `__other__`. That is a
     * rule going from watching a condition to matching nothing, which is
     * exactly what a healthy system looks like from Prometheus's side.
     */
    const r = new MetricsRegistry(2);
    registerProcessMetrics(r, 'valuation');
    const roomy = r.counter('roomy_total', 'two label sets fit', ['k']);
    roomy.inc({ k: 'a' });
    const folded = r.counter('folded_total', 'a third does not', ['k']);
    for (const k of ['a', 'b', 'c', 'd']) folded.inc({ k });

    const text = r.render();
    expect(seriesOf(text, 'n409_metric_series_folded')).toEqual([
      'n409_metric_series_folded{metric="folded_total"} 1',
      // `registerProcessMetrics` registers this one (R376) and it carries no
      // labels at all, so it holds exactly one series and can never fold.
      'n409_metric_series_folded{metric="log_alert_lines_total"} 0',
      'n409_metric_series_folded{metric="roomy_total"} 0',
    ]);
    // The count, as context for the rule: two real label sets plus the one
    // reserved series everything past the cap was folded into.
    expect(text).toContain('n409_metric_series{metric="folded_total"} 3');
    expect(text).toContain('n409_metric_series{metric="roomy_total"} 1');
    // And the fold itself, which is the reading the two gauges above describe:
    // `c` and `d` are not series of their own and their counts are not lost.
    expect(seriesOf(text, 'folded_total')).toEqual([
      'folded_total{k="__other__"} 2',
      'folded_total{k="a"} 1',
      'folded_total{k="b"} 1',
    ]);
  });

  it('counts a histogram beside the counters and leaves the gauges out', () => {
    // Gauges hold no series map — `ObservableGauge` re-derives its readings on
    // every scrape — so there is nothing there to overflow and a reading for
    // one would be a number that could never move.
    const r = new MetricsRegistry();
    registerProcessMetrics(r, 'valuation');
    r.histogram('h_seconds', 'a histogram', ['k']).observe(1, { k: 'a' });

    const census = r.seriesCensus().map((e) => e.metric);
    expect(census).toContain('h_seconds');
    expect(census).not.toContain('process_uptime_seconds');
    expect(census).not.toContain('n409_metric_series');
  });
});

describe('metricsToken', () => {
  it('prefers METRICS_TOKEN and falls back to the internal service token', () => {
    expect(metricsToken({ [METRICS_TOKEN_ENV]: 'scrape', INTERNAL_SERVICE_TOKEN: 'internal' })).toBe(
      'scrape',
    );
    expect(metricsToken({ INTERNAL_SERVICE_TOKEN: 'internal' })).toBe('internal');
    expect(metricsToken({})).toBeNull();
    // An empty value is not a secret.
    expect(metricsToken({ [METRICS_TOKEN_ENV]: '', INTERNAL_SERVICE_TOKEN: '' })).toBeNull();
  });
});

describe('the /metrics endpoint', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function build(env: NodeJS.ProcessEnv, registry = new MetricsRegistry()) {
    const app = Fastify() as unknown as FastifyInstance;
    apps.push(app);
    registerHttpMetrics(app, registry);
    app.get('/things/:id', async () => ({ ok: true }));
    app.get('/boom', async () => {
      throw new Error('kaboom');
    });
    registerMetricsEndpoint(app, { registry, service: 'test', env });
    await app.ready();
    return { app, registry };
  }

  it('serves the exposition format with a no-store header', async () => {
    const { app } = await build({});
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('counts requests by method, route template and status class', async () => {
    const { app } = await build({});
    await app.inject({ method: 'GET', url: '/things/01J0000000000000000000000A' });
    await app.inject({ method: 'GET', url: '/things/01J0000000000000000000000B' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    // Two different ids collapse to one series via the route template.
    expect(body).toContain('http_requests_total{method="GET",route="/things/:id",status="2xx"} 2');
    expect(body).toContain('http_request_duration_seconds_count{method="GET",route="/things/:id"} 2');
  });

  it('counts a 5xx in both the request total and the error total', async () => {
    const { app } = await build({});
    await app.inject({ method: 'GET', url: '/boom' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('http_requests_total{method="GET",route="/boom",status="5xx"} 1');
    expect(body).toContain('http_request_errors_total{method="GET",route="/boom"} 1');
  });

  /** An unmatched path is where the cardinality risk lives: `routeOptions.url`
   *  is undefined precisely when nothing matched. */
  it('labels an unmatched path with its own url and nothing else', async () => {
    const { app } = await build({});
    await app.inject({ method: 'GET', url: '/wp-admin/setup-config.php' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain(
      'http_requests_total{method="GET",route="/wp-admin/setup-config.php",status="4xx"} 1',
    );
  });

  it('publishes http_requests_in_flight at zero when idle', async () => {
    const { app } = await build({});
    await app.inject({ method: 'GET', url: '/things/01J0000000000000000000000A' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('http_requests_in_flight 0');
  });

  it('is open with no secret configured outside production', async () => {
    const { app } = await build({ NODE_ENV: 'test' });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('accepts the internal-token header and the bearer form', async () => {
    const { app } = await build({ INTERNAL_SERVICE_TOKEN: 'sekrit' });
    expect(
      (await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-internal-token': 'sekrit' } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer sekrit' } }))
        .statusCode,
    ).toBe(200);
    // Prometheus writes the scheme however it likes.
    expect(
      (await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'bearer sekrit' } }))
        .statusCode,
    ).toBe(200);
  });

  /**
   * A rejected scrape gets whatever this app answers for a path it does not
   * have, rather than a 401 or a body the endpoint writes itself — so there is
   * one 404 shape per service instead of a second one invented here.
   */
  it('hands a caller with the wrong secret, or none, to the not-found handler', async () => {
    const { app } = await build({ [METRICS_TOKEN_ENV]: 'sekrit' });
    const unknownPath = await app.inject({ method: 'GET', url: '/no-such-path' });
    // Same handler, so the same shape — the body names the path, so compare
    // with that substituted out rather than byte-for-byte.
    const shapeOf = (body: string, url: string) => body.replace(url, '<path>');
    for (const headers of [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: 'Basic sekrit' },
      { 'x-internal-token': 'wrong' },
      // A prefix of the secret must not pass: the comparison is length-first
      // and constant-time, not a `startsWith`.
      { 'x-internal-token': 'sekrit-but-longer' },
    ]) {
      const res = await app.inject({ method: 'GET', url: '/metrics', headers });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('http_requests_total');
      expect(shapeOf(res.body, '/metrics')).toBe(shapeOf(unknownPath.body, '/no-such-path'));
    }
  });

  it('does not register the route at all in production with no secret', async () => {
    const warn = vi.fn();
    const app = Fastify() as unknown as FastifyInstance;
    apps.push(app);
    registerMetricsEndpoint(app, {
      registry: new MetricsRegistry(),
      service: 'web',
      env: { NODE_ENV: 'production' },
      log: { warn },
    });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'web', path: '/metrics' }),
      expect.stringContaining('the metrics endpoint is disabled'),
    );
  });

  /** The secret is re-read per request so it can rotate without a restart —
   *  including a rotation to nothing, which must close the endpoint. */
  it('closes in production when the secret is rotated away under it', async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', [METRICS_TOKEN_ENV]: 'sekrit' };
    const { app } = await build(env);
    expect(
      (await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer sekrit' } }))
        .statusCode,
    ).toBe(200);

    delete env[METRICS_TOKEN_ENV];
    expect(
      (await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer sekrit' } }))
        .statusCode,
    ).toBe(404);
  });

  it('serves on a custom path when one is given', async () => {
    const app = Fastify() as unknown as FastifyInstance;
    apps.push(app);
    registerMetricsEndpoint(app, {
      registry: new MetricsRegistry(),
      service: 'test',
      env: {},
      path: '/internal/metrics',
    });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode).toBe(200);
  });
});
