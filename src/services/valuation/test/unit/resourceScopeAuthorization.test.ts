import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../support/routeSource.js';
import { PUBLIC_ROUTES } from '../../src/plugins/routeAudit.js';

/**
 * The third id-keyed surface, and the one no sweep had reached.
 *
 * Three route audits already stand. `plugins/routeAudit.ts` fails boot when a
 * route escapes `app.authenticate` — that establishes *who* is calling.
 * `privilegedRouteAuthorization.test.ts` sweeps `/admin`, `/users`, `/partners`,
 * `/operations`, `/report-templates`, `/prompts` and `/scim`, where "any
 * signed-in user" is never the right answer. `valuationScopeAuthorization.test.ts`
 * sweeps the 169 routes under `/api/v1/valuations/:id/…`.
 *
 * Between them sits everything else that names a row in its URL: an
 * organization, a saved view, a comment, an API token, an intake link, an
 * invoice, a fund, a debt instrument, a task, a support message. Thirty-eight
 * routes, none of them on a privileged prefix, none of them keyed on a
 * valuation, and none of them swept by anything. They are the same failure the
 * valuation sweep exists for, one noun over: `GET /api/v1/organizations/:id`
 * that reads `:id` and returns what hangs off it answers with another firm's
 * holding-company roll-up to a caller holding a perfectly valid session, on the
 * first request, with a 200 and no log line to find it by.
 *
 * The question each of these routes has to answer is narrower than the
 * valuation sweep's, because these rows have no `partner_id` column to compare
 * against and each resource decides ownership its own way. So the invariant is
 * stated as: the handler must reach *something that consults the caller* before
 * it answers — either an ops guard (which subsumes the question, exactly as it
 * does in the valuation sweep) or an expression that puts the principal's own
 * id or tenant into the decision. What it must not do is take the id from the
 * URL, hand it to a repo, and send back the row.
 *
 * A source scan, for the reason the other two sweeps give: authorization is a
 * property of every handler, and exercising thirty-eight endpoints against a real
 * database to assert 404 is a suite nobody would run.
 * `crossTenantResourceAccess.test.ts` carries the behavioural half for the
 * resources a second tenant can actually name; this carries the coverage.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/**
 * Prefixes another sweep already owns. Kept in step with
 * `privilegedRouteAuthorization.test.ts`, whose own list this mirrors — a
 * prefix that moved out of that file without moving in here would fall through
 * both, which is the gap this whole file is about.
 */
const PRIVILEGED_PREFIXES = [
  '/api/v1/admin/',
  '/api/v1/users',
  '/api/v1/partners',
  '/api/v1/report-templates',
  '/scim/v2',
];

/**
 * Ops-only guards. A handler that has established `isOps` has established
 * access to every row of every tenant — `valuationScope` returns
 * `{ kind: 'all' }` for such a principal — so the per-row question it would
 * ask next could only ever answer yes. The implication runs that way and not
 * the other: a scope check does not imply ops.
 */
const OPS_GUARD = /\bisOps\b|canEditWorkingData|canManageUsers|canManageTokens/;

/**
 * An expression that puts the caller into the decision.
 *
 * Deliberately broader than the valuation sweep's list of rbac predicates,
 * because these resources do not share one. A saved view compares
 * `owner_id !== principal.id`; an intake link resolves the firm through
 * `resolveFirm`; a personal token checks `created_by`; branding asks
 * `canManageBranding`. What they have in common is that the principal is an
 * input, and a handler where it is not has not asked whose row this is.
 */
const OWNER_SCOPE =
  /principal\.id|principal\.partnerId|valuationScope\(|resolveFirm\(|canManageBranding|canReadValuation|canReadReport|canPostComment|canEditComment/;

const CONSULTS_CALLER = new RegExp(`${OPS_GUARD.source}|${OWNER_SCOPE.source}`);

interface Route {
  file: string;
  line: number;
  method: string;
  url: string;
  body: string;
  /** File-local (and one-import-deep) helpers whose body consults the caller. */
  helpers: ReadonlySet<string>;
}

/**
 * Functions in a file that consult the caller — `loadOwnedOrg`, `loadEditable`,
 * `resolveFirm`, `requireOps`, whatever this file happens to call it.
 *
 * Resolved per file rather than against a list of names, for the reason both
 * sibling sweeps give: the helper is spelled differently in every route file,
 * and a list of names would have to be edited by the same person who forgot
 * the check.
 */
function declarationsIn(source: string): Set<string> {
  const names = new Set<string>();
  const declaration =
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  const starts: Array<{ name: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const name = match[1] ?? match[2];
    if (name) starts.push({ name, index: match.index });
  }
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    if (CONSULTS_CALLER.test(source.slice(start.index, end))) names.add(start.name);
  });
  return names;
}

/**
 * The same resolution one level out through the file's own relative imports,
 * and judged the same way: what the imported module's function bodies consult,
 * never the fact that a name was imported. One level only — following the
 * graph further reaches something that mentions `principal.id` for an
 * unrelated reason and starts marking routes authorized by association, which
 * is how a sweep stops sweeping.
 */
function importedHelpersIn(source: string, file: string): Set<string> {
  const names = new Set<string>();
  const dir = path.dirname(path.join(ROUTES, file));
  for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(dir, m[1]!.replace(/\.js$/, '.ts'));
    let imported: string;
    try {
      imported = readFileSync(target, 'utf8');
    } catch {
      continue; // a type-only path, or one this resolution does not reach
    }
    for (const name of declarationsIn(imported)) names.add(name);
  }
  return names;
}

function helpersIn(source: string, file: string): Set<string> {
  const names = declarationsIn(source);
  for (const name of importedHelpersIn(source, file)) names.add(name);
  return names;
}

/**
 * The scan itself is shared (`test/support/routeSource.ts`): matching `app.` on
 * its own missed every route registered on an encapsulated instance — the
 * Stripe, billing and email-delivery webhooks, unsubscribe, the SAML assertion
 * consumer and the whole SCIM surface — in this census and in the two beside
 * it. What stays here is the per-file helper resolution.
 */
function routes(): Route[] {
  const helpersByFile = new Map<string, Set<string>>();
  return scanRoutes(ROUTES).map((r) => {
    let helpers = helpersByFile.get(r.file);
    if (!helpers) {
      const source = readFileSync(path.join(ROUTES, r.file), 'utf8');
      const file = r.file;
      helpers = helpersIn(source, file);
      helpersByFile.set(r.file, helpers);
    }
    return { ...r, helpers };
  });
}

/**
 * Routes deliberately reachable without a session are not a tenant question:
 * a login page's brand and a published marketing article have no caller to
 * scope to, and `routeAudit.ts` already holds each of them to a written
 * reason. Read off `PUBLIC_ROUTES` rather than re-listed here, so a route that
 * stops being public stops being exempt in the same commit.
 */
const PUBLIC_KEYS = new Set(PUBLIC_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.url}`));

const ALL = routes();
const KEYED = ALL.filter(
  (r) =>
    /\/:/.test(r.url) &&
    !/\/valuations\/:/.test(r.url) &&
    !PRIVILEGED_PREFIXES.some((p) => r.url.startsWith(p)) &&
    !PUBLIC_KEYS.has(`${r.method} ${r.url}`),
);

const at = (r: Route) => `${r.method} ${r.url} (${r.file}:${r.line})`;

function consultsCaller(route: Route): boolean {
  if (CONSULTS_CALLER.test(route.body)) return true;
  const called = [...route.body.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]);
  return called.some((name) => name !== undefined && route.helpers.has(name));
}

describe('routes keyed on a non-valuation resource scope it to the caller', () => {
  it('finds the route table it is auditing', () => {
    // A scan that silently matches nothing passes every assertion below. Loose
    // on purpose, so ordinary additions do not trip them.
    expect(ALL.length).toBeGreaterThan(300);
    expect(KEYED.length).toBeGreaterThan(30);
  });

  it('every one of them consults the caller before it answers', () => {
    const unscoped = KEYED.filter((r) => !consultsCaller(r)).map(at);
    expect(unscoped).toEqual([]);
  });

  it('covers the resources that actually have a second tenant', () => {
    // The sweep is only worth what it covers, and "greater than thirty" does
    // not say it reached the organizations or the saved views. These are the
    // collections where two tenants can both name a row, named so that one
    // dropping out of the scan is a failure here rather than a quieter sweep.
    const collections = new Set(KEYED.map((r) => r.url.split('/').slice(0, 4).join('/')));
    for (const expected of [
      '/api/v1/organizations',
      '/api/v1/saved-views',
      '/api/v1/comments',
      '/api/v1/api-tokens',
      '/api/v1/firm',
      '/api/v1/billing',
      '/api/v1/me',
      '/api/v1/notifications',
      '/api/v1/support',
      '/api/v1/funds',
      '/api/v1/debt',
      '/api/v1/tasks',
    ]) {
      expect([...collections], expected).toContain(expected);
    }
  });

  it('reads a bare id lookup as unscoped and an owner-checked one as scoped', () => {
    // The mechanism, stated against both shapes, so a regex that stopped
    // matching fails here rather than passing the sweep by finding nothing to
    // complain about.
    const bare = {
      body: "app.get('/api/v1/widgets/:id', { preHandler: app.authenticate }, async (req) => {\nconst { id } = req.params as { id: string };\nreturn findWidgetById(deps.pool, id);\n",
      helpers: new Set<string>(),
    } as Route;
    const owned = {
      body: "app.get('/api/v1/widgets/:id', { preHandler: app.authenticate }, async (req) => {\nconst widget = await findWidgetById(deps.pool, id);\nif (widget.owner_id !== principal.id) throw problems.notFound();\n",
      helpers: new Set<string>(),
    } as Route;

    expect(consultsCaller(bare)).toBe(false);
    expect(consultsCaller(owned)).toBe(true);
  });

  it('recognises a helper by what it consults, not by what it is called', () => {
    const source = `
      const loadOwnedThing = async (principal, id) => {
        const row = await findThingById(pool, id);
        if (!row || row.owner_user_id !== principal.id) throw problems.notFound();
        return row;
      };
      const loadAnyThing = async (pool, id) => findThingById(pool, id);
    `;
    const helpers = declarationsIn(source);
    expect(helpers.has('loadOwnedThing')).toBe(true);
    expect(helpers.has('loadAnyThing')).toBe(false);
  });

  it('does not treat a public route as a tenant question it answered', () => {
    // `/api/v1/public/branding/:key` names a row and consults nobody, which is
    // correct and is why it is exempt. The exemption has to come from
    // PUBLIC_ROUTES and not from a second list here: a route that loses its
    // public status has to lose its exemption in the same commit.
    const publicBranding = ALL.find((r) => r.url === '/api/v1/public/branding/:key');
    expect(publicBranding, 'the public branding route still exists').toBeDefined();
    expect(consultsCaller(publicBranding!)).toBe(false);
    expect(KEYED).not.toContain(publicBranding);
  });
});
