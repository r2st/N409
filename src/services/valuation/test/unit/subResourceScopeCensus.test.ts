import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes, type SourceRoute } from '../support/routeSource.js';

/**
 * A sub-resource route must tie its child id to the parent in the URL.
 *
 * `DELETE /organizations/:id/entities/:valuationId` authorized both ids and
 * compared neither (R185). Every id in the request passed its own check, and
 * the handler then cleared `organization_id` unconditionally — so a stale tab
 * or a bulk script iterating the wrong roster detached an engagement from an
 * organization the request never named, and answered 204. It survived three
 * authorization sweeps because it is not an authorization bug: the defect is in
 * the *relationship* between two ids the caller may hold both of.
 *
 * `docs/route-authorization-audit.md` has named "routes with two path params"
 * as the place to look for the next one ever since, and nothing has been asking.
 * The five sweeps are partitioned by URL shape and every one of them asks "did
 * the handler consult the caller"; none asks "did it consult the URL".
 *
 * So the rule is stated here over the whole route table. A route whose second
 * path parameter names a resource row is tied when the handler either
 *
 *   - passes the parent through the child's own lookup, so the query cannot
 *     match a row under another parent — `findComparableItem(pool,
 *     valuation.id, itemId)`, `loadDocument(pool, valuation.id, documentId)`;
 *     or
 *   - loads the child by id and then compares its parent column against the
 *     parent it was reached through — `if (grant.valuation_id !== id) throw
 *     problems.notFound()`.
 *
 * Both are in use and neither is preferred; what is not allowed is neither.
 *
 * WHAT THIS DOES NOT ASK. Vocabulary parameters — `:provider`, `:role`,
 * `:slug`, `:field_key`, `:version`, `:pipeline` — are not rows and have no
 * parent column to compare; `pathParamValidationCensus` is the census that
 * holds those, and folding the two together would bury each rule under the
 * other's exemptions. And this says nothing about whether either id was
 * *authorized*: that is what the five scope sweeps are for. A handler can pass
 * this census and still serve a stranger's row, and pass all five and still
 * serve the wrong one of the caller's own.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/** A path parameter naming a resource row, not a vocabulary member. */
const ID_SHAPED = /^(id|.*_?[Ii]d|pid)$/;

/**
 * Routes whose second id is not a child of the first, with what it is instead.
 */
const NOT_A_SUB_RESOURCE: Record<string, string> = {
  'GET /api/v1/valuations/:id/bridge/:compareId':
    'Two peer engagements, not a parent and a child. The bridge explains the movement between one valuation and another, so `:compareId` names a sibling that is loaded through the same `load(principal, …)` the path id is — authorized in its own right, with nothing to tie it to. The one relationship that would be wrong is the two being the same row, and the handler refuses that ahead of both loads.',
};

/**
 * The handler's source with every string literal blanked.
 *
 * The registration's own URL is a string in the body, and it names both path
 * parameters — so `app.delete('/api/v1/organizations/:id/entities/:valuationId'`
 * reads as a call carrying the parent and the child together, and the route
 * whose bug this census exists for would have certified itself.
 */
function code(body: string): string {
  return body.replace(/\s+/g, ' ').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

/** `:id` and every local the handler resolves it into (`const valuation = await loadValuation(principal, id)`). */
function parentRefs(body: string, param: string): string[] {
  const refs = new Set<string>([param]);
  for (const match of code(body).matchAll(
    new RegExp(
      `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?[\\w.]+\\([^)]*\\b${param}\\b[^)]*\\)`,
      'g',
    ),
  )) {
    refs.add(`${match[1]!}.id`);
  }
  return [...refs];
}

/**
 * Every call site in `body` — nested ones included — with its argument text.
 *
 * Scanned by matching parentheses rather than by regex. A regex that allows two
 * levels of nesting matches the route *registration* first, whose arguments are
 * the entire handler, and `matchAll` does not look inside a match it has
 * already made: one greedy hit swallowed every real call in the file and
 * reported the route as tied because both ids appeared *somewhere* in it.
 */
function callArgs(body: string): string[] {
  const src = code(body);
  const found: string[] = [];
  for (const open of src.matchAll(/[A-Za-z_$][\w$.]*\(/g)) {
    const from = open.index! + open[0]!.length;
    let depth = 0;
    let i = from - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    found.push(src.slice(from, i));
  }
  return found;
}

/**
 * A call that could tie the child to the parent — a lookup, not a payload and
 * not a wrapper.
 *
 * Object literals are dropped: `recordFundEvent(client, live, …, { fund_id: id,
 * position_id: pid })` names both ids and asks the database nothing about
 * either, and so does the log line beside it. Counting one as a tie would let a
 * handler certify itself by *reporting* a relationship it never checked. A call
 * taking a callback is dropped for the same reason from the other side —
 * `withTransaction(pool, async (client) => …)` "contains" whatever its body
 * does; the calls inside it are scanned on their own.
 */
function lookupArgs(raw: string): string | null {
  if (raw.includes('=>')) return null;
  let args = raw;
  for (let before = ''; before !== args;) {
    before = args;
    args = args.replace(/\{[^{}]*\}/g, '');
  }
  return args;
}

function tied(route: SourceRoute, child: string, refs: string[]): boolean {
  // (a) the parent travels through the child's own lookup.
  for (const raw of callArgs(route.body)) {
    const args = lookupArgs(raw);
    if (args === null || !new RegExp(`\\b${child}\\b`).test(args)) continue;
    if (refs.some((ref) => new RegExp(`(?<![\\w.])${ref.replace('.', '\\.')}\\b`).test(args))) return true;
  }
  // (b) the loaded child is compared back against the parent.
  for (const cmp of code(route.body).matchAll(/([\w.]+)\s*[!=]==\s*([\w.]+)/g)) {
    if (!/_id$|\bid$/.test(cmp[1] ?? '')) continue;
    if (refs.some((ref) => ref === cmp[2])) return true;
  }
  return false;
}

const routes = scanRoutes(ROUTES);

describe('sub-resource scope census', () => {
  const subResources = routes.filter((r) => {
    const params = [...r.url.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!);
    return params.length >= 2 && ID_SHAPED.test(params[0]!) && ID_SHAPED.test(params[1]!);
  });

  it('has a population to ask about', () => {
    expect(subResources.length).toBeGreaterThan(20);
  });

  it('ties every child id to the parent it was reached through', () => {
    const untied: string[] = [];
    for (const route of subResources) {
      const key = `${route.method} ${route.url}`;
      if (key in NOT_A_SUB_RESOURCE) continue;
      const params = [...route.url.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!);
      if (!tied(route, params[1]!, parentRefs(route.body, params[0]!))) {
        untied.push(`${key} (${route.file}:${route.line})`);
      }
    }
    expect(untied).toEqual([]);
  });

  it('exempts nothing that is no longer a route', () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.url}`));
    expect(Object.keys(NOT_A_SUB_RESOURCE).filter((k) => !keys.has(k))).toEqual([]);
  });
});
