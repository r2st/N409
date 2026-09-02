import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import { ValuationHub } from '../../src/realtime/hub.js';
import {
  refuseRealtimeStream,
  registerRealtimeStreamMetrics,
  resetRealtimeStreamMetrics,
} from '../../src/observability/realtimeStreams.js';

/**
 * A saturation gauge reading 1% while people are being refused (R369, M11).
 *
 * The hub has three ceilings — `maxPerUser: 12`, `maxPerRoom: 64`,
 * `maxTotal: 1024` — and had one instrument, `realtime_streams_open`, which
 * measures the last of them. So the ordinary refusal, a person's twelfth
 * stream, happens with the only number anybody can see reading twelve out of a
 * thousand. `capacityFor` knew exactly which ceiling it was and `stream.ts`
 * discarded that, answering `problems.tooManyRequests` — a 429 in the same 4xx
 * class as every rate-limited request on the estate, and `scimRequests.ts`
 * states why that is invisible: there is no 4xx rule on this box at all.
 *
 * These pin the scope label values and the two semantics the rules depend on,
 * because `alerts.yml` selects `{scope="total"}` and `{scope="room"}` by hand
 * and divides by `realtime_stream_capacity`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.resolve(HERE, file), 'utf8');

const WHO = { userId: 'u1', valuationId: 'v1' };

describe('the realtime refusal counter', () => {
  afterEach(() => resetRealtimeStreamMetrics());

  const registered = () => {
    const registry = new MetricsRegistry();
    registerRealtimeStreamMetrics(registry, () => new ValuationHub().ceilings());
    return registry;
  };

  it('counts a refusal by the ceiling that caused it', () => {
    const registry = registered();
    refuseRealtimeStream({ warn: vi.fn() }, 'user', WHO);
    refuseRealtimeStream({ warn: vi.fn() }, 'room', WHO);
    refuseRealtimeStream({ warn: vi.fn() }, 'total', WHO);

    const text = registry.render();
    expect(text).toContain('realtime_stream_refusals_total{scope="user"} 1');
    expect(text).toContain('realtime_stream_refusals_total{scope="room"} 1');
    expect(text).toContain('realtime_stream_refusals_total{scope="total"} 1');
  });

  it('exports the ceiling in force rather than leaving a rule to hardcode it', () => {
    // `RealtimeStreamsNearCapacity` divides by this. A deployment that
    // constructs the hub with its own limits must move the denominator with it,
    // which is the whole reason the gauge exists instead of the number 1024
    // being written into alerts.yml.
    const registry = new MetricsRegistry();
    const hub = new ValuationHub({ maxTotal: 40, maxPerRoom: 8, maxPerUser: 2 });
    registerRealtimeStreamMetrics(registry, () => hub.ceilings());

    const text = registry.render();
    expect(text).toContain('realtime_stream_capacity{scope="total"} 40');
    expect(text).toContain('realtime_stream_capacity{scope="room"} 8');
    expect(text).toContain('realtime_stream_capacity{scope="user"} 2');
  });

  it('carries the same three scope values on the gauge and the counter', () => {
    // The two are divided by one another and grouped alongside each other, so a
    // scope that exists on one and not the other is a rule that quietly matches
    // nothing.
    const registry = registered();
    for (const scope of ['user', 'room', 'total'] as const) {
      refuseRealtimeStream({ warn: vi.fn() }, scope, WHO);
    }
    const text = registry.render();
    const scopes = (metric: string) =>
      [...text.matchAll(new RegExp(`^${metric}\\{scope="([a-z]+)"\\}`, 'gm'))]
        .map((m) => m[1]!)
        .sort();
    expect(scopes('realtime_stream_refusals_total')).toEqual(scopes('realtime_stream_capacity'));
  });

  it('reports the ceilings the hub is actually running under, per scrape', () => {
    // The hub's own defaults, read through `ceilings()` rather than restated
    // here: a changed default must move the gauge, and a gauge asserting a
    // literal would hide that.
    const hub = new ValuationHub();
    expect(hub.ceilings()).toEqual({ user: 12, room: 64, total: 1024 });
  });

  it('logs the shared ceilings and leaves the per-caller one to the counter', () => {
    // `apiTokenAuth.ts`'s argument for leaving `unknown` unlogged: a single
    // caller exceeding a per-caller ceiling is the ceiling working, the caller
    // is told, and a client in a reconnect loop must not choose how much this
    // box writes to the journal. `room` and `total` are one caller's behaviour
    // denying somebody else, so both are written.
    const warn = vi.fn();
    registered();

    refuseRealtimeStream({ warn }, 'user', WHO);
    expect(warn).not.toHaveBeenCalled();

    refuseRealtimeStream({ warn }, 'room', WHO);
    refuseRealtimeStream({ warn }, 'total', WHO);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('names the valuation and the actor under the spellings the rest of the estate uses', () => {
    // `logger.ts`'s own field names, not a second pair: a filter for one
    // valuation's trouble has to find this line, and `valuation_id` here would
    // have hidden the refusal from the exact query somebody runs to find it.
    const warn = vi.fn();
    registered();
    refuseRealtimeStream({ warn }, 'room', { userId: 'u9', valuationId: 'v9' });

    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({ source: 'realtime', scope: 'room', valuationId: 'v9', actorUserId: 'u9' });
    expect(message).toContain('turned away');
  });

  it('records nothing and throws nothing before the instrument is registered', () => {
    // Boot order: `registerStreamRoutes` decorates before app.ts reaches the
    // metrics block in some test harnesses, and a refusal in that window must
    // not take the request down.
    expect(() => refuseRealtimeStream({ warn: vi.fn() }, 'total', WHO)).not.toThrow();
  });

  it('is recorded on the path that answers the 429, not beside it', () => {
    // The route computes the scope for the refusal and used to discard it. The
    // recorder has to sit on that branch: a counter wired anywhere else would
    // be a second, differently-timed answer to the same question.
    const route = source('../../src/routes/stream.ts');
    const branch = route.slice(route.indexOf('capacityFor'), route.indexOf('reply.hijack()'));
    expect(branch).toContain('refuseRealtimeStream(');
    expect(branch).toContain('tooManyRequests');
  });

  it('is wired into the app beside the gauge it exists to correct', () => {
    const app = source('../../src/app.ts');
    expect(app).toContain('registerRealtimeStreamMetrics(metricsRegistry, () => hub.ceilings())');
    expect(app).toContain("'realtime_streams_open'");
  });
});
