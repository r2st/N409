import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The authorization half of the route audit.
 *
 * `plugins/routeAudit.ts` already fails boot if a route escapes
 * `app.authenticate` — but authentication only establishes *who* is calling.
 * Authorization in this service lives inside the handler: a file-local guard
 * (`requireOps`, `requireAdmin`, `requireUserAdmin`, …) that consults an rbac
 * predicate and throws `problems.forbidden`. Nothing enforced that a handler
 * on a privileged surface actually calls one.
 *
 * The failure that costs something is not a missing `preHandler` — that is a
 * 401 and it is loud. It is a new `/api/v1/admin/…` route that authenticates
 * correctly and then answers a client's `valuation_user` session with the
 * platform's user list, because the author copied a route that reads its own
 * data and never noticed the guard was missing. This test is a source scan for
 * exactly that, over the surfaces where "any signed-in user" is never the
 * right answer.
 *
 * A source scan rather than a request-level one because authorization is a
 * property of every handler, and exercising 100 endpoints against a real
 * database to assert 403 is a suite nobody would run. What this cannot see is
 * whether the guard is the *right* one — `rbac.test.ts` covers the predicates
 * themselves, and the integration suites cover the surfaces that matter most.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/**
 * URL prefixes on which an authenticated-but-unprivileged caller must never
 * get an answer. Everything else in the API is scoped per valuation, per
 * partner or per user, and is covered by `valuationScope` instead.
 */
const PRIVILEGED_PREFIXES = [
  '/api/v1/admin/', // every ops/admin console surface
  '/api/v1/users', // the platform user directory and role mutations
  '/api/v1/partners', // firm records — creating, renaming, archiving
  '/api/v1/operations', // the ops working queues
  '/api/v1/report-templates', // the document behind every report issued
  '/api/v1/prompts', // the AI prompts the narratives are generated from
  '/scim/v2', // enterprise provisioning
];

/**
 * Routes on a privileged prefix that are deliberately guarded some other way.
 * Same contract as `PUBLIC_ROUTES`: an exemption has to say what guards it
 * instead, so a reviewer can check the claim rather than trust the list.
 */
const GUARDED_OTHERWISE: ReadonlyArray<{ url: string; reason: string }> = [
  {
    url: '/api/v1/partners/mine',
    reason:
      "a partner user's own organisation, resolved from principal.partnerId and 404 when they have " +
      'none — it reads no record the caller is not already scoped to',
  },
  {
    url: '/scim/v2/ServiceProviderConfig',
    reason: 'SCIM discovery document, public by specification and behind the per-IP limiter',
  },
  {
    url: '/scim/v2/Users',
    reason: 'guarded by requireToken (the SCIM bearer secret), which answers 401 rather than 403',
  },
  {
    url: '/scim/v2/Users/:id',
    reason: 'guarded by requireToken (the SCIM bearer secret), which answers 401 rather than 403',
  },
];

const EXEMPT_URLS = new Set(GUARDED_OTHERWISE.map((r) => r.url));

interface Route {
  file: string;
  line: number;
  method: string;
  url: string;
  /** Source text of the handler, from the registration to its closing `});`. */
  body: string;
  /** Names of file-local functions that throw `problems.forbidden`. */
  guards: ReadonlySet<string>;
}

/**
 * The two spellings of "this line can answer 403".
 *
 * It was one — `problems.forbidden` — until R180 replaced twenty-eight bare
 * `problems.forbidden()` calls, whose entire message was the words "Not
 * allowed", with `forbidden(action, kind)` from `domain/accessProblem.ts`.
 * That refactor took thirty-one privileged routes out of this census's sight
 * in a single commit, including eight on the admin console: the guards were
 * still there and still threw 403, and the scan looking for them reported them
 * as unguarded. Which is the *safe* direction to fail, and it is still a
 * census that has stopped measuring what it claims to.
 *
 * The optional `problems.` prefix rather than two alternatives, because the
 * helper is deliberately named the same thing — a guard reading `throw
 * forbidden('Creating a valuation', 'ops')` should be recognisable as one on
 * sight, and the pattern that recognises it should not have to be a list that
 * grows every time somebody wraps it again.
 */
const RAISES_403 = /\b(?:problems\.)?forbidden\(/;

/**
 * Every function in a file whose body throws `problems.forbidden` — the
 * authorization guards, whatever they happen to be named. Resolving them per
 * file rather than matching a fixed list of names is what makes this survive a
 * rename: a guard called `requireFundManager` counts the day it is written.
 */
function guardsIn(source: string): Set<string> {
  const guards = new Set<string>();
  const declaration = /(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\()/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    // Read forward to the next top-level declaration — enough to see the body
    // without parsing TypeScript.
    const rest = source.slice(match.index, match.index + 1600);
    const end = rest.search(/\n(?:export )?(?:function|const)\s+\w/);
    if (RAISES_403.test(end > 0 ? rest.slice(0, end) : rest)) guards.add(name);
  }
  return guards;
}

function routes(): Route[] {
  const found: Route[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(ROUTES, file), 'utf8');
    const lines = source.split('\n');
    const guards = guardsIn(source);

    lines.forEach((line, i) => {
      const verb = /app\.(get|post|put|patch|delete)[<(]/.exec(line);
      if (!verb) return;
      // The URL may wrap onto the next line when the options object is long.
      const url = /["'`](\/[^"'`]*)["'`]/.exec(lines.slice(i, i + 3).join(' '));
      if (!url?.[1]) return;

      let body = '';
      for (let j = i; j < Math.min(lines.length, i + 200); j++) {
        body += `${lines[j]}\n`;
        if (/^ {2}\}\);\s*$/.test(lines[j] ?? '')) break;
      }
      found.push({ file, line: i + 1, method: verb[1]!.toUpperCase(), url: url[1], body, guards });
    });
  }
  return found;
}

const ALL = routes();
const PRIVILEGED = ALL.filter((r) => PRIVILEGED_PREFIXES.some((p) => r.url.startsWith(p)));

/** Does this handler run something that can throw 403 before it answers? */
function authorizes(route: Route): boolean {
  if (RAISES_403.test(route.body)) return true;
  const called = [...route.body.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]);
  return called.some((name) => name !== undefined && route.guards.has(name));
}

describe('privileged routes authorize, not merely authenticate', () => {
  it('finds the route table it is auditing', () => {
    // A scan that silently matches nothing passes every assertion below. If a
    // refactor changes how routes are registered, this is the case that says so.
    expect(ALL.length).toBeGreaterThan(300);
    expect(PRIVILEGED.length).toBeGreaterThan(80);
  });

  it('every route on a privileged surface calls a guard that can throw 403', () => {
    const unguarded = PRIVILEGED.filter((r) => !EXEMPT_URLS.has(r.url) && !authorizes(r)).map(
      (r) => `${r.method} ${r.url} (${r.file}:${r.line})`,
    );
    expect(unguarded).toEqual([]);
  });

  it('every admin console route in particular is guarded', () => {
    // Stated separately from the sweep above because this is the surface where
    // a miss hands the platform's own records to a client session.
    const admin = PRIVILEGED.filter((r) => r.url.startsWith('/api/v1/admin/'));
    expect(admin.length).toBeGreaterThan(50);
    expect(admin.filter((r) => !authorizes(r)).map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });

  it('every exemption names what guards the route instead', () => {
    for (const entry of GUARDED_OTHERWISE) {
      expect(entry.reason.length, entry.url).toBeGreaterThan(20);
    }
  });

  it('no exemption outlives the route it was written for', () => {
    // A stale exemption is worse than none: the next route to take that URL
    // inherits a waiver nobody granted it.
    const live = new Set(PRIVILEGED.map((r) => r.url));
    expect(GUARDED_OTHERWISE.filter((e) => !live.has(e.url)).map((e) => e.url)).toEqual([]);
  });

  it('no exemption covers a route that is in fact guarded', () => {
    // If a route grows a real guard, it should leave the list — otherwise the
    // list stops describing anything.
    const redundant = PRIVILEGED.filter((r) => EXEMPT_URLS.has(r.url) && authorizes(r)).map(
      (r) => `${r.method} ${r.url}`,
    );
    expect(redundant).toEqual([]);
  });

  it('recognises a guard by what it throws, not by what it is called', () => {
    // The mechanism the sweep depends on: a differently-named guard counts,
    // and a helper that only reads the principal does not.
    const source = `
      function requireFundManager(req) {
        const principal = requirePrincipal(req);
        if (!canManageFunds(principal)) throw problems.forbidden('funds are ops-only');
        return principal;
      }
      const currentUser = (req) => requirePrincipal(req);
    `;
    const guards = guardsIn(source);
    expect(guards.has('requireFundManager')).toBe(true);
    expect(guards.has('currentUser')).toBe(false);
  });
});
