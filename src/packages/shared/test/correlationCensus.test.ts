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
