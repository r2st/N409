import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../support/routeSource.js';

/**
 * A path parameter that names a *vocabulary* must be checked against it.
 *
 * Two kinds of thing travel in a URL path here, and only one of them is safe to
 * pass through unread. A resource id — `:id`, `:grantId`, `:pid` — goes into a
 * parameterised query against a ULID column, so a string that is not one simply
 * matches no row and the route 404s on its own. A parameter that names a
 * *member of a set* does not have that property: `:kind`, `:provider`,
 * `:dataType`, `:source`, `:pipeline` and `:key` are read as keys, compared
 * against enums, or used to build a cache entry, and a value outside the set is
 * not a missing row but an unasked question.
 *
 * Every one of them was checked but `/api/v1/help/articles/:slug`, which handed
 * the router's match straight to the repo and cached the miss under the
 * caller's own string — so any signed-in caller could spend a query and a cache
 * slot per made-up path. It read exactly like the two routes beside it
 * (`/blog/posts/:slug`, `/public/branding/:key`), both of which carry the guard
 * and say in prose why; nothing held the third to the same rule.
 *
 * So the rule is stated over the whole route table: a vocabulary parameter is
 * checked before it is used, or it is named below with why it is not.
 *
 * Deliberately not extended to id-shaped parameters. Several of those are not
 * `isUlid`-checked either, and that is a different question with a different
 * answer — see `resourceScopeAuthorization` and `valuationScopeAuthorization`
 * for the one that matters about them — so folding the two into one census
 * would bury this rule under a list of sites it is not about.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/** A path parameter naming a resource, not a vocabulary. */
const ID_SHAPED = /^(id|.*_?[Ii]d|pid)$/;

/**
 * Sites where the parameter is genuinely not read as a vocabulary member.
 *
 * Each names what the parameter is instead, and what stands in for the check.
 */
const NOT_A_VOCABULARY: Record<string, string> = {
  'GET /api/v1/admin/blog/posts/:slug':
    'The ops preview of one post, by the slug the ops list just handed the caller. It is a single parameterised `WHERE slug = $1` with no cache behind it and no lookup keyed on the string, so an unknown slug is one indexed miss and a 404 — the same answer a shape check would give, one query earlier. The public reader beside it caches its misses, which is what makes the guard worth having there.',
};

const routes = scanRoutes(ROUTES);

/**
 * Every identifier this parameter is reachable through in the handler.
 *
 * Two hops, because both are written here. A handler may rename the parameter
 * as it destructures it (`{ provider: rawProvider } = req.params`), and it may
 * check a value *derived* from it rather than the string itself — `:version` is
 * `Number(versionParam)` and then bounded, which is the check, on the only
 * value the bound could sensibly be about.
 */
function localsFor(body: string, param: string): string[] {
  const names = new Set<string>([param]);
  // `const { id, provider: rawProvider } = req.params as { … }`
  for (const match of body.matchAll(/\{([^}]*)\}\s*=\s*req\.params\b/g)) {
    for (const part of match[1]!.split(',')) {
      const [from, to] = part.split(':').map((s) => s.trim());
      if (from === param && to) names.add(to);
    }
  }
  for (const name of [...names]) {
    const id = escapeId(name);
    for (const match of body.matchAll(
      new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\w+\\(\\s*${id}\\s*\\)`, 'g'),
    )) {
      names.add(match[1]!);
    }
  }
  return [...names];
}

function escapeId(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the handler asks anything about this parameter before using it.
 *
 * The idioms are the ones the estate actually writes — membership of a frozen
 * list or a `Set`, a regex, a zod schema over the value or over `req.params`
 * whole, and the `parseX` helpers that raise on a value outside their
 * vocabulary. Loose on purpose in the same direction the SQL sweep is: a false
 * positive here is a route that checks its parameter twice, a false negative is
 * the whole guarantee.
 */
function isChecked(body: string, param: string): boolean {
  if (/\.safeParse\(\s*req\.params\b/.test(body)) return true;
  return localsFor(body, param).some((name) => {
    const id = escapeId(name);
    return (
      new RegExp(`\\.(?:includes|has|test|get|safeParse|parse)\\(\\s*${id}\\s*[,)]`).test(body) ||
      new RegExp(`\\b(?:isUlid|fitsInt4|parse[A-Z]\\w*|assert[A-Z]\\w*)\\(\\s*${id}\\s*[,)]`).test(body) ||
      // `if (role !== 'main' && role !== 'second') throw problems.notFound()` —
      // a two-member vocabulary spelled out rather than declared as a list.
      new RegExp(`\\b${id}\\s*[!=]==\\s*['"\`]`).test(body)
    );
  });
}

describe('path parameter validation census', () => {
  const vocabulary = routes.flatMap((route) =>
    [...route.url.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1]!)
      .filter((param) => !ID_SHAPED.test(param))
      .map((param) => ({ route, param })),
  );

  it('finds the vocabulary parameters (the census is not vacuously empty)', () => {
    expect(new Set(vocabulary.map((v) => v.param)).size).toBeGreaterThanOrEqual(7);
  });

  it('checks every vocabulary path parameter, or says why not', () => {
    const unchecked = vocabulary
      .filter(({ route, param }) => !isChecked(route.body, param))
      .map(({ route, param }) => `${route.method} ${route.url} (:${param}) — ${route.file}`)
      .filter((line) => !Object.keys(NOT_A_VOCABULARY).some((key) => line.startsWith(key)));
    expect(unchecked).toEqual([]);
  });

  it('keeps the exemption list honest — every entry names a live route', () => {
    const declared = Object.keys(NOT_A_VOCABULARY);
    const live = new Set(vocabulary.map(({ route }) => `${route.method} ${route.url}`));
    expect(declared.filter((key) => !live.has(key))).toEqual([]);
  });
});
