import { metrics, type Meter } from '@opentelemetry/api';

/**
 * RED metrics (Rate, Errors, Duration) + resource gauges (audit B-3 §metrics).
 *
 * Traces alone can't drive RED/USE dashboards or alerting. These helpers use the
 * global MeterProvider that `startTelemetry` installs; with no collector wired
 * they record into the API's no-op provider, so calling them is always safe.
 */

const HTTP_ID_SEGMENT = /^(?:[0-9]+|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;

/** Collapses id-like path segments to `:id` to keep metric label cardinality low. */
export function routeLabel(routeOrUrl: string | undefined | null, fallback = 'unknown'): string {
  if (!routeOrUrl) return fallback;
  const path = routeOrUrl.split('?')[0]!.split('#')[0]!;
  if (path === '' || path === '/') return '/';
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (HTTP_ID_SEGMENT.test(s) ? ':id' : s));
  return '/' + segments.join('/');
}

/** RED bucket for a status code: 2xx / 3xx / 4xx / 5xx. */
export function statusClass(code: number): string {
  const bucket = Math.floor(code / 100);
  return bucket >= 1 && bucket <= 5 ? `${bucket}xx` : 'unknown';
}

export interface HttpMetrics {
  /** Record one finished request: increments rate (+ errors on 5xx) and latency. */
  record(args: { method: string; route?: string | null; statusCode: number; durationMs: number }): void;
}

/**
 * Builds the HTTP RED instruments for a service. Reuses one Meter; safe to call
 * once per process and share. A Fastify `onResponse` hook is the natural caller.
 */
export function createHttpMetrics(service: string, meter: Meter = metrics.getMeter(service)): HttpMetrics {
  const requests = meter.createCounter('http.server.request.count', {
    description: 'Total HTTP server requests handled',
  });
  const errors = meter.createCounter('http.server.error.count', {
    description: 'HTTP server requests that returned a 5xx',
  });
  const duration = meter.createHistogram('http.server.duration', {
    description: 'HTTP server request duration',
    unit: 'ms',
  });

  return {
    record({ method, route, statusCode, durationMs }) {
      const attrs = {
        'http.request.method': method.toUpperCase(),
        'http.route': routeLabel(route),
        'http.response.status_code': statusCode,
        'http.status_class': statusClass(statusCode),
      };
      requests.add(1, attrs);
      duration.record(Math.max(0, durationMs), attrs);
      if (statusCode >= 500) errors.add(1, attrs);
    },
  };
}

/**
 * Registers an observable gauge sampled on each metric export — for pool
 * saturation, queue depth, in-flight orchestrations, etc. `observe` may return a
 * plain number or per-attribute readings.
 */
export function registerGauge(
  service: string,
  name: string,
  description: string,
  observe: () => number | Array<{ value: number; attributes?: Record<string, string | number> }>,
  meter: Meter = metrics.getMeter(service),
): void {
  const gauge = meter.createObservableGauge(name, { description });
  gauge.addCallback((result) => {
    const reading = observe();
    if (typeof reading === 'number') {
      result.observe(reading);
    } else {
      for (const r of reading) result.observe(r.value, r.attributes);
    }
  });
}
