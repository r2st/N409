import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The per-engagement half of the route audit.
 *
 * Two sweeps already stand behind this one and neither covers what it covers.
 * `plugins/routeAudit.ts` fails boot when a route escapes `app.authenticate`,
 * which establishes *who* is calling. `privilegedRouteAuthorization.test.ts`
 * sweeps the admin/ops prefixes, where "any signed-in user" is never the right
 * answer. Between them sits the surface this platform mostly consists of: 169
 * routes under `/api/v1/valuations/:id/…`, where every caller is legitimately
 * signed in, most are legitimately non-ops, and the only question that matters
 * is whether *this* engagement is one of theirs.
 *
 * A route that skips that question is not a 401 and not a 403. It answers, with
 * another firm's cap table, to a caller holding a perfectly valid session — and
 * it does so on the first request, silently, with a 200. There is no log line
 * to find it by. That is the failure this exists to make impossible to ship.
 *
 * Two invariants, because there are two ways to get it wrong:
 *
 *   1. The route never asks. It reads `:id` and returns what hangs off it.
 *   2. The route asks about `:id`, then reads a *child* by the child's own id.
 *      `GET /valuations/:id/grants/:grantId` authorizing `:id` and then
 *      selecting `grantId` from the whole table is an engagement the caller
 *      owns used as a key to one they do not — and it reads exactly like
 *      correct code, which is what makes it worth a machine's attention.
 *
 * A source scan, for the reason the privileged sweep gives: authorization is a
 * property of every handler, and 169 endpoints exercised against a real
 * database to assert 404 is a suite nobody would run. The integration suites
 * carry the behavioural assertions for the surfaces that matter most; this
 * carries the coverage.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/**
 * A predicate that answers "may this principal see this engagement". Any of
 * them, called anywhere the handler can reach, satisfies invariant 1.
 */
const SCOPE_PREDICATE = /canReadValuation|canReadReport|valuationScope|patchableFields|canPostComment/;

/**
 * Ops-only guards, which satisfy it a different way: `valuationScope` returns
 * `{ kind: 'all' }` for an ops principal, so a handler that has already
 * established `isOps` has established read access to every engagement. Asking
 * `canReadValuation` afterwards could only ever return true.
 *
 * This is the one place the sweep trusts a *stronger* check in place of the
 * expected one, so it is worth being explicit that the implication runs in that
 * direction and not the other: a scope check does not imply ops.
 */
const OPS_GUARD = /\bisOps\b|canEditWorkingData|canManageUsers/;

const AUTHORIZES = new RegExp(`${SCOPE_PREDICATE.source}|${OPS_GUARD.source}`);

interface Route {
  file: string;
  line: number;
  method: string;
  url: string;
  body: string;
  /** File-local helpers whose own body consults one of the predicates above. */
  helpers: ReadonlySet<string>;
}

/**
 * Functions in a file that reach a predicate — `loadReadable`, `authorize`,
 * `loadAuthorizedValuation`, whatever this particular file calls it.
 *
 * Resolved per file rather than against a fixed list of names, exactly as the
 * privileged sweep resolves its guards: nine route files spell this helper nine
 * different ways, and a list of names would have to be edited by the same
 * person who forgets the check.
 */
function helpersIn(source: string): Set<string> {
  const names = new Set<string>();
  const declaration =
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  const starts: Array<{ name: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const name = match[1] ?? match[2];
    if (name) starts.push({ name, index: match.index });
  }
  // Each declaration's body runs to the next one — enough to see what it calls
  // without parsing TypeScript.
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    if (AUTHORIZES.test(source.slice(start.index, end))) names.add(start.name);
  });
  return names;
}

function routes(): Route[] {
  const found: Route[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(ROUTES, file), 'utf8');
    const lines = source.split('\n');
    const helpers = helpersIn(source);

    lines.forEach((line, i) => {
      const verb = /app\.(get|post|put|patch|delete)[<(]/.exec(line);
      if (!verb) return;
      // The URL wraps to the next line when the options object is long.
      const url = /["'`](\/[^"'`]*)["'`]/.exec(lines.slice(i, i + 3).join(' '));
      if (!url?.[1]) return;

      let body = '';
      for (let j = i; j < Math.min(lines.length, i + 250); j++) {
        body += `${lines[j]}\n`;
        if (/^ {2,4}\}\);\s*$/.test(lines[j] ?? '')) break;
      }
      found.push({ file, line: i + 1, method: verb[1]!.toUpperCase(), url: url[1], body, helpers });
    });
  }
  return found;
}

const ALL = routes();
/** Routes keyed on one engagement — the surface with a per-row owner. */
const SCOPED = ALL.filter((r) => /\/valuations\/:/.test(r.url));
const at = (r: Route) => `${r.method} ${r.url} (${r.file}:${r.line})`;

function authorizes(route: Route): boolean {
  if (AUTHORIZES.test(route.body)) return true;
  const called = [...route.body.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]);
  return called.some((name) => name !== undefined && route.helpers.has(name));
}

/** `/valuations/:id/x/:childId` → ['childId']; the parent `:id` is not a child. */
function childParams(url: string): string[] {
  const tail = url.split('/valuations/:id/')[1];
  if (tail === undefined) return [];
  return [...tail.matchAll(/:(\w+)/g)].map((m) => m[1]!);
}

/**
 * Is the child read as a child, rather than as a top-level row that happens to
 * be named in this URL?
 *
 * Three shapes count, because the codebase uses all three. Either the lookup
 * takes the engagement id alongside the child id — `findNetworkItem(pool, id,
 * itemId)`, which pushes the constraint into SQL — or the handler compares
 * parentage after loading, `grant.valuation_id !== id`.
 *
 * The third is a segment that names no row at all. `:pipeline` and `:field_key`
 * are checked against a closed set declared in the source — `AI_PIPELINES`,
 * `OVERWRITE_FIELDS_BY_KEY` — and a value that survives that check is one of a
 * handful of compile-time constants, not an id that could belong to somebody
 * else's engagement. Rooting is not a question these can fail.
 *
 * What does not count is a lookup by the child id alone.
 */
function childIsScopedToParent(route: Route, child: string): boolean {
  // Two things in a handler name both ids inside one pair of parentheses while
  // being no kind of lookup, and each is enough on its own to mark every nested
  // route scoped — which is how this check quietly stops checking anything:
  //
  //   app.get('/api/v1/valuations/:id/grants/:grantId', …
  //   const { id, grantId } = req.params as { id: string; grantId: string }
  //
  // The registration's own URL is the worse of the two, because it is present
  // on every route by construction, so leaving it in makes the sweep vacuous
  // rather than merely lenient. String literals go first for that reason; a
  // lookup passes ids as bindings, never as text.
  const body = route.body
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")
    .replace(/as\s*\{[^}]*\}/g, '')
    .replace(/\{[^{}]*\}\s*=\s*req\.params/g, '');
  const passedWithParent = new RegExp(
    String.raw`\(\s*[^)]*\b(?:id|valuation\.id|valuationId)\b[^)]*\b${child}\b`,
    's',
  );
  const comparedToParent = /valuation_id\s*!==\s*(?:id|valuation\.id)/;
  // A module-level constant collection consulted with the segment: names no row.
  const boundedByConstant = new RegExp(
    String.raw`\b[A-Z][A-Z0-9_]{2,}\b[^\n]*\.(?:has|get|includes)\(\s*${child}\b`,
  );
  return passedWithParent.test(body) || comparedToParent.test(body) || boundedByConstant.test(body);
}

describe('per-engagement routes authorize the engagement', () => {
  it('finds the route table it is auditing', () => {
    // A scan that silently matches nothing passes every assertion below. These
    // are the numbers that say the parser still understands how routes are
    // registered — deliberately loose, so ordinary additions do not trip them.
    expect(ALL.length).toBeGreaterThan(300);
    expect(SCOPED.length).toBeGreaterThan(120);
  });

  it('every route keyed on an engagement checks the caller may read it', () => {
    const unscoped = SCOPED.filter((r) => !authorizes(r)).map(at);
    expect(unscoped).toEqual([]);
  });

  it('every nested resource is read as a child of that engagement', () => {
    const nested = SCOPED.filter((r) => childParams(r.url).length > 0);
    expect(nested.length).toBeGreaterThan(30);

    const unrooted = nested
      .filter((r) => !childParams(r.url).every((c) => childIsScopedToParent(r, c)))
      .map(at);
    expect(unrooted).toEqual([]);
  });

  it('recognises a helper by what it consults, not by what it is called', () => {
    // The mechanism the two sweeps above depend on. A differently-named loader
    // counts; one that merely fetches the row does not, which is the whole
    // distinction — `findValuationById` reads, it does not authorize.
    const source = `
      async function loadForCaller(pool, principal, id) {
        const valuation = await findValuationById(pool, id);
        if (!canReadValuation(principal, toRef(valuation))) throw problems.notFound();
        return valuation;
      }
      const loadAnything = async (pool, id) => findValuationById(pool, id);
    `;
    const helpers = helpersIn(source);
    expect(helpers.has('loadForCaller')).toBe(true);
    expect(helpers.has('loadAnything')).toBe(false);
  });

  it('reads a bare child lookup as unscoped and a parented one as scoped', () => {
    // The other mechanism, stated against both shapes the codebase uses, so a
    // regex that stopped matching fails here rather than passing the sweep by
    // finding nothing to complain about.
    const bare = {
      body: 'const { id, grantId } = req.params as { id: string; grantId: string };\nconst grant = await findGrantById(deps.pool, grantId);',
    } as Route;
    const paired = { body: 'const item = await findNetworkItem(deps.pool, id, itemId);' } as Route;
    const compared = {
      body: 'const grant = await findGrantById(deps.pool, grantId);\nif (grant.valuation_id !== id) throw problems.notFound();',
    } as Route;

    const bounded = {
      body: "app.put('/api/v1/valuations/:id/overwrites/:field_key', async (req) => {\nconst def = OVERWRITE_FIELDS_BY_KEY.get(field_key);",
    } as Route;

    expect(childIsScopedToParent(bare, 'grantId')).toBe(false);
    expect(childIsScopedToParent(paired, 'itemId')).toBe(true);
    expect(childIsScopedToParent(compared, 'grantId')).toBe(true);
    expect(childIsScopedToParent(bounded, 'field_key')).toBe(true);
  });

  it('does not read a route URL as evidence that its child is rooted', () => {
    // Every nested registration names `:id` and `:childId` inside one pair of
    // parentheses. Counting that made the sweep pass on a handler that looked
    // its child up by id alone — vacuously, on all 40 routes at once.
    const unrooted = {
      body: "app.get('/api/v1/valuations/:id/probe/:probeId', { preHandler: app.authenticate }, async (req) => {\nconst { id, probeId } = req.params as { id: string; probeId: string };\nawait loadReadable(deps.pool, id, principal);\nreturn findProbeById(deps.pool, probeId);",
    } as Route;
    expect(childIsScopedToParent(unrooted, 'probeId')).toBe(false);
  });

  it('does not count the parent id as a child of itself', () => {
    expect(childParams('/api/v1/valuations/:id/cap-table')).toEqual([]);
    expect(childParams('/api/v1/valuations/:id/grants/:grantId')).toEqual(['grantId']);
  });
});
