import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every metric this service declares is registered by the service.
 *
 * The instruments in `src/observability` and `src/clients` all hold the same
 * shape: a module-level `let counter: Counter | null = null`, a
 * `register…Metrics(registry)` that fills it in from `app.ts`, and recorders
 * that write through `counter?.inc(…)`. The optional call is deliberate — a
 * recorder must not throw in a code path it only observes — and it is also the
 * whole failure mode: a module nobody registers records nothing, forever,
 * silently. Nothing is thrown, nothing is logged, and `/metrics` is missing a
 * series that was never there to be missed. The first symptom is an operator
 * writing an alert rule against a name that returns no data.
 *
 * Eight such modules sit in `src/observability` and four of them were held to
 * being wired —
 * `partnerApiGuardMetrics`, `signInOutcomeMetrics`, `integrationCallbackMetrics`
 * and `realtimeStreamMetrics` each assert `app.ts` contains their own call, one
 * line, added by hand by the round that wrote the module. The other four —
 * `apiTokenAuth`, `inboundWebhooks`, `scimRequests`, `ssoOutcomes` — assert
 * nothing about it: their suites call `register…Metrics` on a local registry
 * themselves, so they pass identically whether or not the service ever does.
 * All eight are wired today; four of them are wired by nothing that would
 * notice if they stopped being (R381, methodology M4).
 *
 * So the rule is derived rather than listed. The population is every
 * `register…Metrics` this service exports — twelve today, the eight above plus
 * the four in `src/clients` — so the thirteenth is in it the day it is written,
 * and its own test file does not have to remember this.
 *
 * The gauge-only registrars need no exemption. `registerCircuitMetrics` assigns
 * no instrument: its series are pull-based callbacks over the breaker roster,
 * so there is nothing left behind for the next suite to read. It shares
 * `clients/internal.ts` with `registerUpstreamMetrics`, which does assign one,
 * which is why the reset rule below asks its question of the registrar rather
 * than of the file it lives in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/** Every `.ts` under `src`, app.ts excluded — it is the file being asked about. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && full !== path.join(SRC, 'app.ts')) out.push(full);
  }
  return out;
}

interface MetricModule {
  file: string;
  /** The `X` in `registerXMetrics`. */
  name: string;
  source: string;
  /** True when this registrar assigns a module-level instrument, rather than only minting pull gauges. */
  holds: boolean;
}

/** The body of a function whose signature starts at `from`, by matching braces. */
function bodyAt(source: string, from: number): string {
  const open = source.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

const modules: MetricModule[] = sources(SRC).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/export function register(\w+)Metrics\s*\(/g)].map((m) => ({
    file: path.relative(SRC, file),
    name: m[1]!,
    source,
    // `x = registry.counter(…)`, not a bare `registry.gauge(…)`: only the first
    // leaves state behind for the next suite to read.
    holds: /\b\w+\s*=\s*registry\.(counter|gauge|histogram)\b/.test(bodyAt(source, m.index!)),
  }));
});

/**
 * `app.ts` with its comments removed.
 *
 * Every one of these calls is introduced by a paragraph naming it, so a search
 * over the raw file finds the registration whether or not the line survives —
 * commenting one out during a debugging session would leave the census green.
 */
const app = readFileSync(path.join(SRC, 'app.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('metrics wiring census', () => {
  it('has a population to ask about', () => {
    expect(modules.length).toBeGreaterThanOrEqual(8);
  });

  it('registers every instrument the service declares', () => {
    const unwired = modules
      .filter((m) => !new RegExp(`\\bregister${m.name}Metrics\\s*\\(`).test(app))
      .map((m) => `register${m.name}Metrics (${m.file})`);
    expect(unwired).toEqual([]);
  });

  /**
   * A module holding an instrument has to be able to drop it between suites.
   *
   * The instrument outlives the registry it was minted on — it is module state,
   * and a test file importing the recorder gets whatever the last suite left
   * there. Without the seam one suite's counts are read by the next one's
   * assertions, which is a green test measuring the wrong run.
   */
  it('gives every module that holds an instrument a reset seam', () => {
    const missing = modules
      .filter((m) => m.holds)
      .filter((m) => !new RegExp(`export function reset${m.name}Metrics\\s*\\(`).test(m.source))
      .map((m) => `reset${m.name}Metrics (${m.file})`);
    expect(missing).toEqual([]);
  });
});
