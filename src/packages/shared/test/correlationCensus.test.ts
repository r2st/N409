/**
 * Every Fastify service feeds the correlation mixin.
 *
 * `createLogger` installs a mixin that reads the request id out of an
 * AsyncLocalStorage, so a line written through anything other than `req.log`
 * still carries it — `app.log` in a route, a module-level logger, a hook, and
 * above all work that outlives the response, which is what an incident is
 * reconstructed from. The mixin has been on all three services' loggers since
 * it was written and only the valuation service ever called `bindRequestId`.
 * In the other two `currentRequestId()` answered undefined, so the field was
 * absent from exactly the lines it exists for, and absent in the way that reads
 * as "not caused by a request".
 *
 * A guard phrased "account for every X" catches the additions its author never
 * imagined; one phrased "these known X are fine" only catches regressions. So
 * this is the first kind: it finds the services by their `createLogger` call
 * and requires each to bind, rather than checking a list of three.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICES = join(here, '../../../services');

/** Every .ts under the three Node services' src trees. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  for (const svc of readdirSync(SERVICES)) {
    const src = join(SERVICES, svc, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // A service with no src/ is the Python pair, which binds x-request-id to
      // a contextvar of its own (each service's app/observability.py).
    }
  }
  return out;
}

/** Comment-stripped, line structure preserved. */
function code(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(1)));
}

describe('the correlation id is bound wherever a Fastify app is built', () => {
  const files = sourceFiles().map((path) => ({ path, code: code(readFileSync(path, 'utf8')) }));
  const builders = files.filter((f) => /createLogger\(\s*\{\s*service:/.test(f.code));

  it('finds the app builders at all — the vacuity guard for everything below', () => {
    // Without this, a regex that stopped matching would make the check below
    // pass against an empty set, which is how a census quietly stops being one.
    expect(builders.length).toBeGreaterThanOrEqual(3);
    const names = builders.map((b) => relative(SERVICES, b.path));
    expect(names).toContain(join('valuation', 'src', 'app.ts'));
    expect(names).toContain(join('web', 'src', 'app.ts'));
    expect(names).toContain(join('report', 'src', 'app.ts'));
  });

  it('binds the request id in every one of them', () => {
    const unbound = builders
      .filter((f) => !/bindRequestId\(/.test(f.code))
      .map((f) => relative(SERVICES, f.path));
    // If this fails, a service builds a logger carrying the mixin and never
    // feeds it: `requestId` will be missing from every line that had no `req`
    // in scope, and missing means "no request caused this".
    expect(unbound).toEqual([]);
  });

  it('binds it from an onRequest hook, which is the only place early enough', () => {
    // Later than `onRequest` and the lines written by the hooks before it — the
    // rate-limit refusals, the auth failures — are written outside the context.
    for (const f of builders) {
      expect(f.code, relative(SERVICES, f.path)).toMatch(
        /addHook\(\s*'onRequest'[\s\S]{0,400}?bindRequestId\(/,
      );
    }
  });

  it('adopts an inbound x-request-id rather than minting a fresh one per hop', () => {
    // Binding the id is only worth anything if it is the *caller's* id. The web
    // BFF proxies to valuation and valuation calls the Python pair, so a
    // service that minted its own would break the chain at its own door.
    for (const f of builders) {
      expect(f.code, relative(SERVICES, f.path)).toMatch(/requestIdHeader:\s*'x-request-id'/);
    }
  });
});

/**
 * Every background tick is correlated, not just the ones somebody remembered.
 *
 * The request half of this file asks each Fastify app to bind an id. The
 * background half asks the same of the schedulers: a sweep registered with a
 * bare `nonOverlapping` gets the non-overlap guard and none of the correlation,
 * and the resulting lines look exactly like correlated ones minus a field —
 * which is the one defect no reader ever notices.
 *
 * Phrased as "account for every scheduler" rather than "these twelve are fine",
 * so the thirteenth sweep fails here instead of logging anonymously.
 */
describe('the background sweeps are correlated', () => {
  const files = sourceFiles().map((path) => ({ path, code: code(readFileSync(path, 'utf8')) }));
  const schedulers = files.filter((f) => /\bnonOverlapping\(/.test(f.code));

  it('finds no scheduler built outside the correlated helper', () => {
    // `trackedSweep` is the door: it binds `{ sweep, sweepRun }` for the tick
    // and hands the failure to `sweepFailed`. A direct `nonOverlapping` call in
    // a service skips the first half silently.
    expect(schedulers.map((f) => relative(SERVICES, f.path))).toEqual([]);
  });

  it('registers every tick through one helper, and that helper is the correlated one', () => {
    const registrars = files.filter((f) => /\btrackedSweep\(/.test(f.code));
    // Vacuity guard: if this found nothing, the check above would pass against
    // a service that had stopped scheduling anything at all.
    expect(registrars.map((f) => relative(SERVICES, f.path))).toContain(join('valuation', 'src', 'index.ts'));

    for (const f of registrars) {
      // One wrapper per service, so the binding cannot be half-applied across
      // a service's own sweeps.
      const calls = f.code.match(/\btrackedSweep\(/g) ?? [];
      expect(calls.length, relative(SERVICES, f.path)).toBe(1);
    }
  });

  it('sends every scheduled tick in the valuation service through that wrapper', () => {
    // Twelve `setInterval(() => x.run())` lines; each `x` has to come from
    // `scheduleSweep`. A tick wired straight off a `nonOverlapping` — or off
    // nothing at all — would log with no sweep name.
    const index = files.find((f) => f.path.endsWith(join('valuation', 'src', 'index.ts')))!;
    const scheduled = [...index.code.matchAll(/setInterval\(\s*\(\)\s*=>\s*(\w+)\.run\(\)/g)].map(
      (m) => m[1]!,
    );
    expect(scheduled.length).toBeGreaterThanOrEqual(10);
    for (const name of new Set(scheduled)) {
      expect(index.code, name).toMatch(new RegExp(`\\b${name}\\s*=\\s*scheduleSweep\\(`));
    }
  });
});
