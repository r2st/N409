import { describe, expect, it, vi } from 'vitest';
import type { Meter } from '@opentelemetry/api';
import { createHttpMetrics, registerGauge, routeLabel, statusClass } from '../src/metrics.js';

describe('routeLabel', () => {
  it('collapses numeric and id-like segments to :id', () => {
    expect(routeLabel('/api/v1/valuations/12345/documents')).toBe('/api/v1/valuations/:id/documents');
    expect(routeLabel('/api/v1/valuations/01HZY8KQF3M2N4P5R6S7T8V9WX/pipeline')).toBe(
      '/api/v1/valuations/:id/pipeline',
    );
    expect(routeLabel('/users/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f')).toBe('/users/:id');
  });

  it('strips query strings and hashes', () => {
    expect(routeLabel('/search?q=acme&page=2')).toBe('/search');
    expect(routeLabel('/help#top')).toBe('/help');
  });

  it('handles root and empty inputs', () => {
    expect(routeLabel('/')).toBe('/');
    expect(routeLabel('')).toBe('unknown');
    expect(routeLabel(undefined)).toBe('unknown');
    expect(routeLabel(null)).toBe('unknown');
  });

  it('leaves non-id segments intact', () => {
    expect(routeLabel('/api/v1/auth/login')).toBe('/api/v1/auth/login');
  });
});

describe('statusClass', () => {
  it('buckets by hundreds', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
    expect(statusClass(0)).toBe('unknown');
    expect(statusClass(700)).toBe('unknown');
  });
});

/** A Meter test double capturing instrument calls. */
function fakeMeter() {
  const counters: Record<string, Array<[number, unknown]>> = {};
  const histos: Record<string, Array<[number, unknown]>> = {};
  const gauges: Record<string, (cb: (r: { observe: (v: number, a?: unknown) => void }) => void) => void> = {};
  const meter = {
    createCounter: (name: string) => {
      counters[name] = [];
      return { add: (v: number, a: unknown) => counters[name]!.push([v, a]) };
    },
    createHistogram: (name: string) => {
      histos[name] = [];
      return { record: (v: number, a: unknown) => histos[name]!.push([v, a]) };
    },
    createObservableGauge: (name: string) => ({
      addCallback: (cb: (r: { observe: (v: number, a?: unknown) => void }) => void) => {
        gauges[name] = cb;
      },
    }),
  } as unknown as Meter;
  return { meter, counters, histos, gauges };
}

describe('createHttpMetrics', () => {
  it('records rate + latency for every request and errors only on 5xx', () => {
    const { meter, counters, histos } = fakeMeter();
    const m = createHttpMetrics('svc', meter);

    m.record({ method: 'get', route: '/api/v1/valuations/42', statusCode: 200, durationMs: 12 });
    m.record({ method: 'POST', route: '/api/v1/x', statusCode: 500, durationMs: 30 });

    expect(counters['http.server.request.count']).toHaveLength(2);
    expect(counters['http.server.error.count']).toHaveLength(1);
    expect(histos['http.server.duration']).toHaveLength(2);

    const [, attrs] = counters['http.server.request.count']![0]!;
    expect(attrs).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/api/v1/valuations/:id',
      'http.status_class': '2xx',
    });
  });

  it('clamps negative durations to zero', () => {
    const { meter, histos } = fakeMeter();
    createHttpMetrics('svc', meter).record({ method: 'GET', statusCode: 200, durationMs: -5 });
    expect(histos['http.server.duration']![0]![0]).toBe(0);
  });
});

describe('registerGauge', () => {
  it('observes a scalar value on callback', () => {
    const { meter, gauges } = fakeMeter();
    const observe = vi.fn(() => 7);
    registerGauge('svc', 'g.scalar', 'desc', observe, meter);
    const observed: number[] = [];
    gauges['g.scalar']!({ observe: (v) => observed.push(v) });
    expect(observe).toHaveBeenCalled();
    expect(observed).toEqual([7]);
  });

  it('observes per-attribute readings', () => {
    const { meter, gauges } = fakeMeter();
    registerGauge(
      'svc',
      'g.multi',
      'desc',
      () => [{ value: 1, attributes: { k: 'a' } }, { value: 2 }],
      meter,
    );
    const observed: Array<[number, unknown]> = [];
    gauges['g.multi']!({ observe: (v, a) => observed.push([v, a]) });
    expect(observed).toEqual([
      [1, { k: 'a' }],
      [2, undefined],
    ]);
  });
});
