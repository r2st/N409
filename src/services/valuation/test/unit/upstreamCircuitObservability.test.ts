import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  circuits,
  postJson,
  registerCircuitMetrics,
  registerUpstreamMetrics,
  resetUpstreamMetrics,
  setCircuitObserver,
  UPSTREAM_CIRCUITS,
} from '../../src/clients/internal.js';

/**
 * A breaker opening is this service deciding to stop calling a dependency
 * altogether. Until R313 that decision was published nowhere a machine could
 * see: the registry's `onStateChange` hook had no subscriber, and
 * `snapshots()` reached only the ops incident endpoint — a page a human visits
 * *after* suspecting a problem, which cannot say a breaker opened at 03:12 and
 * closed two minutes later.
 *
 * These pin the two channels that now carry it, and the roster that keeps the
 * gauge from publishing nothing at all for a dependency nobody has called yet.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Five consecutive transient failures — the configured threshold. */
async function tripBreaker(service: string): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => jsonResponse(503, { detail: 'down' })),
  );
  for (let i = 0; i < 5; i++) {
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);
  }
}

let service: string;
let counter = 0;

beforeEach(() => {
  service = `circobs-${counter++}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCircuitObserver(null);
  resetUpstreamMetrics();
  circuits.get(service).reset();
});

describe('circuit state observer', () => {
  it('reports the transition to open, with the classified reason', async () => {
    const seen: Array<{ name: string; from: string; to: string; reason: string }> = [];
    setCircuitObserver((c) => void seen.push(c));

    await tripBreaker(service);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: service, from: 'closed', to: 'open' });
    // The reason carries the classified failure slug, not the upstream's own
    // sentence — the thing an operator groups by.
    expect(seen[0]!.reason).toContain('failure threshold reached');
  });

  it('reports the recovery as well as the outage', async () => {
    await tripBreaker(service);
    const seen: string[] = [];
    setCircuitObserver((c) => void seen.push(`${c.from}->${c.to}`));

    // Cooldown elapses, one trial call succeeds.
    circuits.get(service).reset();
    expect(seen).toEqual(['open->closed']);
  });

  it('cannot fail the call it is describing', async () => {
    setCircuitObserver(() => {
      throw new Error('sink is broken');
    });
    // The fifth failure is the one that trips; it must still surface as the
    // upstream error rather than as the observer's.
    await expect(tripBreaker(service)).resolves.toBeUndefined();
    expect(circuits.get(service).snapshot().state).toBe('open');
  });
});

describe('circuit gauges', () => {
  it('publishes a series for every rostered dependency before any call is made', () => {
    const registry = new MetricsRegistry();
    registerCircuitMetrics(registry);
    const text = registry.render();

    for (const name of UPSTREAM_CIRCUITS) {
      // Closed and present, rather than absent: an alert cannot tell a missing
      // series from a healthy one.
      expect(text).toContain(`upstream_circuit_state{service="${name}",state="closed"} 1`);
      expect(text).toContain(`upstream_circuit_state{service="${name}",state="open"} 0`);
      expect(text).toContain(`upstream_circuit_consecutive_failures{service="${name}"} 0`);
    }
  });

  it('flips the open series and counts the calls it refused', async () => {
    const registry = new MetricsRegistry();
    registerCircuitMetrics(registry);

    await tripBreaker(service);
    // One more call, which the open breaker refuses without dialling.
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);

    const text = registry.render();
    expect(text).toContain(`upstream_circuit_state{service="${service}",state="open"} 1`);
    expect(text).toContain(`upstream_circuit_state{service="${service}",state="closed"} 0`);
    expect(text).toContain(`upstream_circuit_rejected_total{service="${service}"} 1`);
  });
});

describe('UPSTREAM_CIRCUITS roster', () => {
  /**
   * The roster exists so the gauge has series from boot, which only works while
   * it names every breaker production actually mints. `postJson`'s first
   * argument is the breaker name; `reportRender` holds its own literal.
   */
  it('names every service the call sites put behind a breaker', () => {
    const root = new URL('../../src/', import.meta.url).pathname;
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          for (const m of src.matchAll(/postJson<[^>]*>\(\s*'([a-z-]+)'/g)) found.add(m[1]!);
          for (const m of src.matchAll(/\bpostJson\(\s*'([a-z-]+)'/g)) found.add(m[1]!);
          for (const m of src.matchAll(/circuits\.get\(([A-Z_]+)\)/g)) {
            const constName = m[1]!;
            const decl = src.match(new RegExp(`const ${constName} = '([a-z-]+)'`));
            if (decl) found.add(decl[1]!);
          }
        }
      }
    };
    walk(root);

    expect(found.size).toBeGreaterThan(0);
    expect([...found].sort()).toEqual([...UPSTREAM_CIRCUITS].sort());
  });
});

describe('upstream RED', () => {
  it('separates a 4xx from a 5xx, because they are different people\'s problems', async () => {
    const registry = new MetricsRegistry();
    registerUpstreamMetrics(registry);

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
        .mockResolvedValueOnce(jsonResponse(422, { detail: 'volatility is required' }))
        .mockResolvedValueOnce(jsonResponse(503, { detail: 'down' })),
    );
    await postJson(service, 'http://x/y', {}, { retries: 0 });
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);

    const text = registry.render();
    expect(text).toContain(`upstream_requests_total{service="${service}",outcome="ok"} 1`);
    expect(text).toContain(`upstream_requests_total{service="${service}",outcome="rejected"} 1`);
    expect(text).toContain(`upstream_requests_total{service="${service}",outcome="failed"} 1`);
    // Three attempts observed, whatever they answered: a latency histogram that
    // only holds the successes cannot see a dependency that got slow and fell over.
    expect(text).toContain(`upstream_request_duration_seconds_count{service="${service}"} 3`);
  });

  it('counts one attempt per attempt, so a retry is visible', async () => {
    const registry = new MetricsRegistry();
    registerUpstreamMetrics(registry);

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { detail: 'down' }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true })),
    );
    await postJson(service, 'http://x/y', {}, { retries: 1, backoffMs: 1 });

    const text = registry.render();
    expect(text).toContain(`upstream_requests_total{service="${service}",outcome="failed"} 1`);
    expect(text).toContain(`upstream_requests_total{service="${service}",outcome="ok"} 1`);
    expect(text).toContain(`upstream_request_duration_seconds_count{service="${service}"} 2`);
  });

  it('records a refusal by the breaker without putting a zero in the latency histogram', async () => {
    const registry = new MetricsRegistry();
    registerUpstreamMetrics(registry);
    await tripBreaker(service);

    // Five failed attempts are in the histogram; the sixth call never dials.
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);

    const text = registry.render();
    expect(text).toContain(`upstream_requests_total{service="${service}",outcome="circuit_open"} 1`);
    expect(text).toContain(`upstream_request_duration_seconds_count{service="${service}"} 5`);
  });

  it('records an unreachable host, which has no status to be classified by', async () => {
    const registry = new MetricsRegistry();
    registerUpstreamMetrics(registry);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.1.4:3003')),
    );
    await postJson(service, 'http://x/y', {}, { retries: 0 }).catch(() => undefined);

    expect(registry.render()).toContain(
      `upstream_requests_total{service="${service}",outcome="unreachable"} 1`,
    );
  });
});
