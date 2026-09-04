import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  recordThrottleRefusal,
  registerRequestThrottleMetrics,
  resetRequestThrottleMetrics,
  type ThrottledDoor,
} from '../../src/observability/requestThrottle.js';

/**
 * Every 429 this service answers is counted by something (R420, methodology M11).
 *
 * The estate has taken this one door at a time — R329 the webhooks and SSO,
 * R337 the directory connector, R345/R346 the partner API, R369 the realtime
 * hub, R376 the sign-in door — and each round wrote down the same reason:
 * `scimRequests.ts` says "there is no 4xx rule on this box at all", and
 * `alerts.yml` repeats it beside the realtime rules. A throttle that refuses
 * everything is therefore invisible: the process is healthy, it answers every
 * request it is given, `HighServerErrorRate` sees no 5xx, `SlowRequests` sees
 * nothing, and the refusals are one status class in `http_requests_total` that
 * nothing reads.
 *
 * The doors those rounds took each had a *machine* behind them. What was left
 * was every door with a person behind it, which is the larger half: the three
 * limiters over the whole authenticated API, the step-up password budget, the
 * unauthenticated identity surface, and the token-only links an auditor, a
 * director or a client is sent.
 *
 * This census is the standing rule rather than the list, so the next throttle
 * is in it the day it is written: a `problems.tooManyRequests(` in `src` must
 * have a recorder in the lines above it. Which recorder is deliberately open —
 * `recordSignInOutcome`, `refuseScimRequest`, the partner guard and the
 * realtime hub each own their own instrument, and a door already counted by one
 * of those must not be counted twice.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Any call that puts a refusal on an instrument. Broad on purpose: this census
 * asks whether *something* can see the refusal, not which subsystem owns it.
 * `dropped?.inc()` in `routes/clientErrors.ts` is a counter held by the route
 * itself and counts, as does `.inc({` anywhere.
 */
const RECORDER = /record[A-Z]\w*\(|refuse[A-Z]\w*\(|\?\.inc\(|\binc\(\{/;

/** How far above the throw a recorder may sit: the guard's own `if` block. */
const LOOKBACK = 12;

interface Door {
  file: string;
  line: number;
}

/**
 * The 429s this service *relays* rather than enforces, and why each is somebody
 * else's instrument.
 *
 * Kept as a list with a reason apiece, and held to still matching a door below,
 * so an exemption cannot outlive the code it was written for.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'clients/internal.ts',
    why: "toProblem translating an *upstream's* 429 into ours — the engine or the AI tier is at its allowance, which is `upstream_requests_total` and the breaker's business, not a throttle this service enforces",
  },
];

/**
 * The file with its comments removed.
 *
 * Half the modules here quote `problems.tooManyRequests(...)` in the paragraph
 * explaining why they count it, and a census that reads those is a census
 * grading prose.
 */
function code(file: string): string[] {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, keep: string) => keep + ' '.repeat(m.length - keep.length))
    .split('\n');
}

const doors: Door[] = sources(SRC).flatMap((file) => {
  const lines = code(file);
  const found: Door[] = [];
  lines.forEach((line, i) => {
    // Both spellings a 429 leaves this service by: the problem helper, and the
    // SCIM route's hand-built body, which cannot use it — a SCIM client is
    // promised a `urn:ietf:params:scim:api:messages:2.0:Error`, not a
    // `application/problem+json`.
    if (!/problems\.tooManyRequests\(/.test(line) && !/\.status\(429\)/.test(line)) return;
    found.push({ file: path.relative(SRC, file), line: i + 1 });
  });
  return found;
});

function counted(door: Door): boolean {
  if (EXEMPT.some((e) => e.file === door.file)) return true;
  const lines = code(path.join(SRC, door.file));
  const from = Math.max(0, door.line - 1 - LOOKBACK);
  return RECORDER.test(lines.slice(from, door.line).join('\n'));
}

describe('the throttle refusal census', () => {
  afterEach(() => resetRequestThrottleMetrics());

  it('has a population to ask about', () => {
    // The vacuity guard. A matcher that stopped matching reports every door
    // clean, which is the one failure a census cannot survive — and this file's
    // whole subject is an instrument that reads healthy by measuring nothing.
    expect(doors.length).toBeGreaterThan(15);
    expect(new Set(doors.map((d) => d.file)).size).toBeGreaterThan(8);
  });

  it('counts every 429 the service answers', () => {
    const silent = doors.filter((d) => !counted(d)).map((d) => `${d.file}:${d.line}`);
    expect(silent, 'a throttle nothing counts is a refusal nothing can see').toEqual([]);
  });

  it('keeps no exemption for a door that has gone', () => {
    const stale = EXEMPT.filter((e) => !doors.some((d) => d.file === e.file)).map((e) => e.file);
    expect(stale, 'an exemption outliving the code it excused').toEqual([]);
  });

  it('is a census that can fail', () => {
    // The other half of the vacuity guard: `counted` must be capable of saying
    // no. Asked of a door with the recorder deliberately out of reach rather
    // than of the real files, so it does not go stale when one is edited.
    const far = { file: doors.find((d) => !EXEMPT.some((e) => e.file === d.file))!.file, line: 1 };
    expect(counted(far)).toBe(false);
  });
});

describe('the throttle refusal counter', () => {
  afterEach(() => resetRequestThrottleMetrics());

  it('keeps one series per door', () => {
    const registry = new MetricsRegistry();
    registerRequestThrottleMetrics(registry);

    const doorNames: ThrottledDoor[] = ['session-user', 'session-org', 'session-cost', 'reauth'];
    for (const door of doorNames) recordThrottleRefusal(door);
    recordThrottleRefusal('session-org');

    const text = registry.render();
    expect(text).toContain('throttle_refusals_total{door="session-user"} 1');
    // The sharp one: a budget shared by everyone at a firm, so the people it
    // refuses are people who did nothing.
    expect(text).toContain('throttle_refusals_total{door="session-org"} 2');
    expect(text).toContain('throttle_refusals_total{door="session-cost"} 1');
    expect(text).toContain('throttle_refusals_total{door="reauth"} 1');
  });

  it('is inert before registration rather than throwing', () => {
    // The recorders sit on the hot path of every authenticated request. A
    // module nobody registered must record nothing, not break the request it
    // was only observing.
    expect(() => recordThrottleRefusal('session-user')).not.toThrow();
  });
});
