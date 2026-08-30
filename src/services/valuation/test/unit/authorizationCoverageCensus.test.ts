import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../support/routeSource.js';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { PUBLIC_ROUTES } from '../../src/plugins/routeAudit.js';
import { PARTNER_API_ENDPOINTS, PARTNER_API_PREFIX } from '../../src/routes/partnerApi.js';

/**
 * The fourth sweep, and the census that says the four of them cover everything.
 *
 * Three source scans already stand over this service's authorization, each
 * owning a shape of URL:
 *
 *   * `privilegedRouteAuthorization` — `/api/v1/admin/`, `/api/v1/users`,
 *     `/api/v1/partners`, `/api/v1/report-templates`, `/scim/v2`: the surfaces
 *     where "any signed-in user" is never the right answer.
 *   * `valuationScopeAuthorization` — the 169 routes under
 *     `/api/v1/valuations/:id/…`.
 *   * `resourceScopeAuthorization` — everything else that names a row in its
 *     URL: an organization, a saved view, a comment, a fund, a task.
 *
 * Each of the three is keyed on the route naming *something*: a privileged
 * prefix, a valuation, a row. What none of them looks at is the route that
 * names nothing — `GET /api/v1/tasks`, `GET /api/v1/funds`,
 * `GET /api/v1/support/messages`, `GET /api/v1/firm/clients`. Seventy-five of
 * them, and they are not the safe residue: a list endpoint decides what the
 * caller may see by the filter it passes to the repo, so the failure is not a
 * 200 on one row belonging to somebody else but the whole table — every firm's
 * client roster, every engagement's task queue — returned to a valid session on
 * the first request with nothing in the URL to suggest anything was asked for.
 *
 * So the first half of this file is that fourth sweep, stated the same way as
 * the third: the handler must reach something that consults the caller before
 * it answers.
 *
 * What it cannot see is the same thing its three siblings cannot: whether the
 * expression it found is the one doing the work. `GET /api/v1/tasks` reads
 * `principal.id` to resolve `?assignee=me` *and* calls `requireOps`; delete the
 * `requireOps` and the sweep still passes, because the principal is still an
 * input. That is a deliberate floor rather than an oversight — a scan strict
 * enough to tell a filter from a guard would have to understand the handler —
 * and it is why `crossTenantResourceAccess` and the per-surface integration
 * suites exist. This asks the question that can be asked of every route at
 * once; they ask the sharper one of the routes that matter most.
 *
 * The second half is the part no individual sweep can do. Each of the four
 * decides what it owns by testing the URL, and the four predicates were written
 * at different times by different rounds; a route whose URL satisfies none of
 * them is swept by nothing and reads exactly like a route that is fine. The
 * coverage census closes that by working from the other end — the route table
 * the application actually registers, via `routeAudit.all()` — and requiring
 * every authenticated route in it to be claimed by exactly one sweep. A new
 * route with a shape nobody anticipated fails here rather than being audited by
 * nobody, which is the regression this file exists to make impossible.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/** Kept in step with `privilegedRouteAuthorization.test.ts`, whose list this mirrors. */
const PRIVILEGED_PREFIXES = [
  '/api/v1/admin/',
  '/api/v1/users',
  '/api/v1/partners',
  '/api/v1/report-templates',
  '/scim/v2',
];

/**
 * Ops-only guards — the same set the resource sweep uses, and for the same
 * reason: a handler that has established `isOps` has established access to
 * every row of every tenant, so the narrower question it would ask next could
 * only answer yes.
 */
const OPS_GUARD = /\bisOps\b|canEditWorkingData|canManageUsers|canManageTokens/;

/**
 * An expression that puts the caller into the decision.
 *
 * `principal.roles` is here and is not in the resource sweep's copy, because a
 * collection can be scoped by what the caller *is* rather than by which rows
 * they own: `GET /me/capabilities` answers `capabilitiesFor(principal)` and
 * touches no table at all. On a keyed route that spelling would be too weak —
 * reading the caller's roles says nothing about whose row `:id` is — which is
 * why the two lists differ rather than being shared.
 */
const OWNER_SCOPE =
  /principal\.id|principal\.partnerId|principal\.roles|valuationScope\(|resolveFirm\(|canManageBranding|canReadValuation|canReadReport|canPostComment|canEditComment/;

const CONSULTS_CALLER = new RegExp(`${OPS_GUARD.source}|${OWNER_SCOPE.source}`);

interface Route {
  file: string;
  line: number;
  method: string;
  url: string;
  body: string;
  helpers: ReadonlySet<string>;
}

/** Functions in a file whose body consults the caller, whatever they are named. */
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

/** The same resolution one level out through the file's own relative imports. */
function importedHelpersIn(source: string, file: string): Set<string> {
  const names = new Set<string>();
  const dir = path.dirname(path.join(ROUTES, file));
  for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(dir, m[1]!.replace(/\.js$/, '.ts'));
    let imported: string;
    try {
      imported = readFileSync(target, 'utf8');
    } catch {
      continue;
    }
    for (const name of declarationsIn(imported)) names.add(name);
  }
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
      helpers = new Set([...declarationsIn(source), ...importedHelpersIn(source, file)]);
      helpersByFile.set(r.file, helpers);
    }
    return { ...r, helpers };
  });
}

const key = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

/**
 * Read off `PUBLIC_ROUTES` rather than re-listed, so a route that stops being
 * public stops being exempt in the same commit. Same contract the resource
 * sweep states.
 */
const PUBLIC_KEYS = new Set(PUBLIC_ROUTES.map((r) => key(r.method, r.url)));

const ALL = routes();

const isPrivileged = (url: string) => PRIVILEGED_PREFIXES.some((p) => url.startsWith(p));
const isValuationKeyed = (url: string) => /^\/api\/v1\/valuations\/:/.test(url);
const isResourceKeyed = (url: string) => /\/:/.test(url);
const isPartner = (url: string) => url.startsWith(PARTNER_API_PREFIX);

/**
 * Which sweep owns a URL. The order is the order the sweeps subtract in — each
 * one excludes the buckets above it — so this is the single statement of the
 * partition the four files implement between them, and the coverage case below
 * is what holds them to it.
 */
type Sweep = 'partner' | 'privileged' | 'valuationScope' | 'resourceScope' | 'collection';
function sweepFor(url: string): Sweep {
  if (isPartner(url)) return 'partner';
  if (isPrivileged(url)) return 'privileged';
  if (isValuationKeyed(url)) return 'valuationScope';
  if (isResourceKeyed(url)) return 'resourceScope';
  return 'collection';
}

const COLLECTION = ALL.filter(
  (r) => sweepFor(r.url) === 'collection' && !PUBLIC_KEYS.has(key(r.method, r.url)),
);

const at = (r: Route) => `${r.method} ${r.url} (${r.file}:${r.line})`;

function consultsCaller(route: Route): boolean {
  if (CONSULTS_CALLER.test(route.body)) return true;
  const called = [...route.body.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]);
  return called.some((name) => name !== undefined && route.helpers.has(name));
}

/**
 * The collection routes that answer the same thing to every caller, and why
 * that is right rather than an oversight.
 *
 * Same contract as `PUBLIC_ROUTES` and as the privileged sweep's
 * `GUARDED_OTHERWISE`: an exemption has to say what makes the route safe, so a
 * reviewer can check the claim rather than trust the list. The bar is that the
 * response is a *constant of the codebase* — it would be identical for a
 * platform with no rows in it — because that is the only case where "who is
 * asking" genuinely cannot change the answer.
 *
 * Three of the four below were not on this list until R250, and they were not
 * passing the sweep either — they were passing `bodyFrom`. All three are
 * one-line handlers, which close with `}));` rather than with the `});` the
 * scan terminates on, so each one's "body" ran on into the routes registered
 * beneath it and the sweep found the *next* handler's `requirePrincipal`. The
 * scan is fixed (`support/routeSource.ts`), and the fix is what surfaced them:
 * a route that consults nobody has to say why, rather than borrowing a
 * neighbour's guard.
 */
const SAME_FOR_EVERYONE: ReadonlyArray<{ method: string; url: string; reason: string }> = [
  {
    method: 'GET',
    url: '/api/v1/intake/schema',
    reason:
      'the questionnaire form for a report kind — sections and cross-field rules compiled into the ' +
      'binary, selected by ?kind and read from no table; the wizard renders from it before an ' +
      'engagement exists, so there is no row and no tenant for it to be scoped to',
  },
  {
    method: 'GET',
    url: '/api/v1/cap-table/formats',
    reason:
      'the column-mapping presets for the cap-table importer — FORMAT_PRESETS and CAP_TABLE_FIELDS, ' +
      'both module constants describing the file layouts Carta and Pulley export; the handler takes ' +
      'no request argument at all and reads no table, so there is nothing about the caller to consult',
  },
  {
    method: 'GET',
    url: '/api/v1/grant-templates',
    reason:
      'the vesting-schedule presets the grant form offers — VESTING_TEMPLATES, a module constant ' +
      'describing four-year-with-a-cliff and its variants; it names no engagement and no tenant, and ' +
      'the same list is correct for a platform with no grants in it',
  },
  {
    method: 'GET',
    url: '/api/v1/tag-catalogue',
    reason:
      'the tag vocabulary itself, from `catalogue()` over TAG_CATALOGUE — the same fixed list the ' +
      'tagging agent is given and the one both write paths validate against, so it is a description ' +
      'of the codebase rather than of anybody’s data',
  },
];

const EXEMPT_KEYS = new Set(SAME_FOR_EVERYONE.map((r) => key(r.method, r.url)));

describe('collection routes scope their listing to the caller', () => {
  it('finds the route table it is auditing', () => {
    // A scan that silently matches nothing passes every assertion below.
    expect(ALL.length).toBeGreaterThan(300);
    expect(COLLECTION.length).toBeGreaterThan(40);
  });

  it('every one of them consults the caller before it answers', () => {
    const unscoped = COLLECTION.filter((r) => !EXEMPT_KEYS.has(key(r.method, r.url)) && !consultsCaller(r));
    expect(unscoped.map(at)).toEqual([]);
  });

  it('covers the listings where one caller could be shown another tenant', () => {
    // "More than forty" does not say the sweep reached the firm console or the
    // task queue. These are the collections that read across tenants, named so
    // that one dropping out of the scan fails here rather than passing quietly.
    const seen = new Set(COLLECTION.map((r) => key(r.method, r.url)));
    for (const expected of [
      'GET /api/v1/firm/clients',
      'GET /api/v1/firm/dashboard',
      'GET /api/v1/tasks',
      'GET /api/v1/reviews',
      'GET /api/v1/engagements',
      'GET /api/v1/funds',
      'GET /api/v1/debt/instruments',
      'GET /api/v1/monitors',
      'GET /api/v1/organizations',
      'GET /api/v1/saved-views',
      'GET /api/v1/notifications',
      'GET /api/v1/inbox',
      'GET /api/v1/search',
      'GET /api/v1/valuations',
      'GET /api/v1/support/messages',
      'GET /api/v1/contact/submissions',
      'GET /api/v1/stats/dashboard',
    ]) {
      expect([...seen], expected).toContain(expected);
    }
  });

  it('every exemption says what makes the route the same for everyone', () => {
    for (const entry of SAME_FOR_EVERYONE) expect(entry.reason.length, entry.url).toBeGreaterThan(40);
  });

  it('no exemption outlives the route it was written for', () => {
    const live = new Set(COLLECTION.map((r) => key(r.method, r.url)));
    expect(SAME_FOR_EVERYONE.filter((e) => !live.has(key(e.method, e.url))).map((e) => e.url)).toEqual([]);
  });

  it('no exemption covers a route that in fact scopes itself', () => {
    // A route that grows a scope should leave the list, or the list stops
    // describing anything.
    const redundant = COLLECTION.filter((r) => EXEMPT_KEYS.has(key(r.method, r.url)) && consultsCaller(r));
    expect(redundant.map(at)).toEqual([]);
  });

  it('reads an unfiltered listing as unscoped and a scoped one as scoped', () => {
    // The mechanism, against both shapes, so a regex that stopped matching
    // fails here rather than passing the sweep by finding nothing to complain
    // about.
    const unfiltered = {
      body: "app.get('/api/v1/widgets', { preHandler: app.authenticate }, async (req) => {\nreturn listWidgets(deps.pool);\n",
      helpers: new Set<string>(),
    } as Route;
    const scoped = {
      body: "app.get('/api/v1/widgets', { preHandler: app.authenticate }, async (req) => {\nconst principal = requirePrincipal(req);\nreturn listWidgets(deps.pool, valuationScope(principal));\n",
      helpers: new Set<string>(),
    } as Route;

    expect(consultsCaller(unfiltered)).toBe(false);
    expect(consultsCaller(scoped)).toBe(true);
  });
});

/** pg.Pool connects lazily; nothing here issues a query. */
function stubPool(): pg.Pool {
  return new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
}

function testConfig() {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: 'z'.repeat(48),
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);
}

/**
 * The registered route table, which is the only account of what this service
 * answers that cannot be out of date.
 *
 * Built once for the whole file. `routeAudit.all()` is populated by an `onRoute`
 * hook, so it includes the routes registered inside encapsulated
 * `app.register()` scopes — the Stripe webhooks, the SAML assertion consumer,
 * the delivery webhook — which a source scan for `app.get(` sees under a
 * different receiver name and which asserting synchronously would miss.
 */
async function registeredRoutes(): Promise<{ all: string[]; authenticated: string[] }> {
  const pool = stubPool();
  const app = buildApp({ config: testConfig(), pool });
  try {
    await app.ready();
    return { all: app.routeAudit.all(), authenticated: app.routeAudit.authenticated() };
  } finally {
    await app.close();
    await pool.end();
  }
}

const REGISTERED = await registeredRoutes();

describe('every authenticated route is claimed by exactly one authorization sweep', () => {
  /** `METHOD /url` → the sweep whose predicate matches it. */
  const claimed = REGISTERED.authenticated.map((k) => {
    const url = k.slice(k.indexOf(' ') + 1);
    return { key: k, url, sweep: sweepFor(url) };
  });

  it('finds a route table worth auditing', () => {
    expect(REGISTERED.all.length).toBeGreaterThan(400);
    expect(REGISTERED.authenticated.length).toBeGreaterThan(350);
  });

  it('leaves no authenticated route outside every sweep', () => {
    // `sweepFor` is total — `collection` is its fallthrough — so the way a
    // route escapes is not by matching nothing but by landing in a bucket whose
    // sweep cannot see it. The source scans read `src/routes/*.ts` for
    // `app.<verb>(` with a literal URL; anything registered another way is in
    // the runtime table and in no scan. That is not hypothetical: the partner
    // API builds its URLs from a registry (`define()` in partnerApi.ts), so its
    // seventeen routes are invisible to all four scans and are checked below on
    // their own terms instead.
    const scanned = new Set(ALL.map((r) => key(r.method, r.url)));
    const invisible = claimed
      .filter((r) => r.sweep !== 'partner' && !scanned.has(r.key))
      .map((r) => r.key)
      .sort();
    expect(invisible).toEqual([]);
  });

  it('each sweep still owns a live share of the table', () => {
    // Floors rather than exact counts, so ordinary additions do not trip this
    // — but per bucket, because the aggregate stays healthy while any single
    // bucket empties. Two privileged prefixes went stale for several rounds
    // under exactly that arithmetic (R185).
    const count = (s: Sweep) => claimed.filter((r) => r.sweep === s).length;
    expect(count('privileged'), 'privileged').toBeGreaterThan(80);
    expect(count('valuationScope'), 'valuationScope').toBeGreaterThan(150);
    expect(count('resourceScope'), 'resourceScope').toBeGreaterThan(30);
    expect(count('collection'), 'collection').toBeGreaterThan(40);
    expect(count('partner'), 'partner').toBeGreaterThan(10);
  });

  it('every partner API route is registered under an API-key guard', () => {
    // The partner sweep is the registry itself: `define()` attaches
    // `[app.authenticate, apiKeyGuard]` when — and only when — the endpoint
    // declares `auth: 'api_key'`, so a new entry that omits the field or
    // mistypes it registers with no preHandler at all. `routeAudit` catches
    // that as an unauthenticated route only because the two documentation
    // endpoints are the sole entries in PUBLIC_ROUTES under this prefix; this
    // says the same thing from the registry's side, where the mistake is made.
    const unguarded = PARTNER_API_ENDPOINTS.filter((e) => e.auth !== 'api_key').map(
      (e) => `${e.method} ${e.path}`,
    );
    expect(unguarded).toEqual(['GET /docs', 'GET /openapi.json']);
  });

  it('every partner API route in the registry is also in the route table', () => {
    // The registry is a document as well as a router. An entry that describes
    // an endpoint nobody registered is a partner integration written against a
    // 404, and `define()` is the only thing keeping the two in step.
    const live = new Set(REGISTERED.all);
    const missing = PARTNER_API_ENDPOINTS.filter(
      (e) => !live.has(key(e.method, PARTNER_API_PREFIX + e.path.replace(/\{(\w+)\}/g, ':$1'))),
    ).map((e) => `${e.method} ${e.path}`);
    expect(missing).toEqual([]);
  });

  it('the source scan sees the whole non-partner table, not a prefix of it', () => {
    // The inverse of the invisibility case, and the one that catches a broken
    // scan rather than a route registered oddly: if `routes()` started matching
    // only the first handler in each file, every assertion in every sweep would
    // still pass. Compared as a count with a small allowance, because a scan
    // reads `app.get(url` in the source while the table holds what Fastify
    // registered, and the two differ by routes the config switches off.
    const scannedNonPartner = ALL.filter((r) => sweepFor(r.url) !== 'partner').length;
    const liveNonPartner = REGISTERED.all.filter(
      (k) => sweepFor(k.slice(k.indexOf(' ') + 1)) !== 'partner',
    ).length;
    expect(scannedNonPartner).toBeGreaterThan(liveNonPartner * 0.95);
  });
});
