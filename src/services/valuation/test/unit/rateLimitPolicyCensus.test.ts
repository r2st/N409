import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { PUBLIC_ROUTES } from '../../src/plugins/routeAudit.js';
import { FixedWindowRateLimiter, WeightedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import {
  buildClientOpenApiDocument,
  parseRouteKey,
  sectionFor,
  templatePath,
} from '../../src/domain/apiCatalog.js';
import { costOfRequest } from '../../src/domain/requestCost.js';
import {
  PUBLIC_POLICIES,
  PUBLIC_RATE_LIMITS,
  deploymentRateLimits,
  rateLimitForOperation,
  type RateLimitPolicy,
} from '../../src/domain/rateLimitPolicy.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * What the published spec says about rate limiting, held to what the service
 * does about it.
 *
 * The document used to declare a `429` on every one of its 448 operations and
 * nothing else — no limit, no key, no window, no `retry-after`, and none of the
 * `x-ratelimit-*` headers the service returns on the way to a refusal. Two
 * different failures sat in that: a client had no way to pace itself, and
 * around forty operations were promised a status they cannot produce. A
 * liveness probe documented as answering 429 is the same noise as the 401 on
 * the sign-in route that `apiCatalog.test.ts` already refuses to publish.
 *
 * So this is a census in both directions. `PUBLIC_RATE_LIMITS` has to name
 * every unauthenticated route and no others, which makes adding one fail here
 * until somebody says what governs it; and every claim the document then makes
 * is checked against the mechanism that would have to produce it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The `src/` tree: this file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../../..');

/** pg.Pool connects lazily; nothing in this file issues a query. */
function stubPool(): pg.Pool {
  return new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
}

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  pool = stubPool();
  app = buildApp({
    config: loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'z'.repeat(48),
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv),
    pool,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

/**
 * Production's three limiters, as this build would construct them.
 *
 * Passed explicitly rather than read from the app under test, because
 * `buildApp` only installs them when `NODE_ENV` is production — a document
 * generated here with none installed would let every assertion below about the
 * authenticated surface pass by having nothing to check.
 */
const LIMITS = deploymentRateLimits({
  session: new FixedWindowRateLimiter(300, 60_000),
  organisation: new FixedWindowRateLimiter(1_500, 60_000),
  cost: new WeightedWindowRateLimiter(200, 60_000),
});

const document = () =>
  buildClientOpenApiDocument({
    routes: app.routeAudit.all(),
    authenticated: new Set(app.routeAudit.authenticated()),
    publicReasons: new Map(
      PUBLIC_ROUTES.map((route) => [`${route.method.toUpperCase()} ${route.url}`, route.reason]),
    ),
    rateLimits: LIMITS,
    version: 'test',
  });

const paths = () => document().paths as Record<string, Record<string, Record<string, unknown>>>;

/** Every rendered operation as `ROUTE KEY` → operation, route key in `:id` form. */
function operations(): Array<{
  key: string;
  method: string;
  path: string;
  operation: Record<string, unknown>;
}> {
  const rendered = paths();
  return app.routeAudit
    .all()
    .map((key) => ({ key, ...parseRouteKey(key) }))
    .filter((route) => !sectionFor(route.path)?.excluded)
    .map((route) => ({
      ...route,
      operation: rendered[templatePath(route.path)]![route.method.toLowerCase()]!,
    }));
}

const routeKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

describe('the public rate-limit table names the public surface exactly', () => {
  it('names every public route and no others', () => {
    // The drift guard, and the reason this is a census: a public endpoint added
    // tomorrow fails here until somebody decides whether a stranger may call it
    // as fast as they like — and, if so, writes down why.
    expect(Object.keys(PUBLIC_RATE_LIMITS).sort()).toEqual(
      PUBLIC_ROUTES.map((route) => routeKey(route.method, route.url)).sort(),
    );
  });

  it('names only routes the service registers', () => {
    const registered = new Set(app.routeAudit.all());
    expect(Object.keys(PUBLIC_RATE_LIMITS).filter((key) => !registered.has(key))).toEqual([]);
  });

  it('argues for every route it calls unlimited', () => {
    for (const [key, verdict] of Object.entries(PUBLIC_RATE_LIMITS)) {
      if (verdict.kind !== 'open') continue;
      // "No limit" is the column that needs the argument. A placeholder here is
      // an unthrottled public endpoint nobody has thought about.
      expect(verdict.why.length, key).toBeGreaterThan(25);
    }
  });

  it('has no named policy that governs nothing', () => {
    const used = new Set(
      Object.values(PUBLIC_RATE_LIMITS)
        .filter((verdict) => verdict.kind === 'throttled')
        .map((verdict) => verdict.policy.name),
    );
    const dead = Object.values(PUBLIC_POLICIES as Record<string, RateLimitPolicy>)
      .map((policy) => policy.name)
      .filter((name) => !used.has(name));
    expect(dead, 'policies in PUBLIC_POLICIES no route is filed under').toEqual([]);
  });

  it('gives every policy a real counter and a sentence', () => {
    for (const policy of Object.values(PUBLIC_POLICIES as Record<string, RateLimitPolicy>)) {
      expect(policy.description.length, policy.name).toBeGreaterThan(40);
      expect(policy.windows.length, policy.name).toBeGreaterThan(0);
      for (const window of policy.windows) {
        expect(window.limit, policy.name).toBeGreaterThan(0);
        expect(window.windowSeconds, policy.name).toBeGreaterThan(0);
      }
    }
  });

  it('finds a surface worth censusing', () => {
    // The vacuity guard the throttle census had to learn: every assertion above
    // passes for an empty table.
    expect(Object.keys(PUBLIC_RATE_LIMITS).length).toBeGreaterThan(40);
    expect(
      Object.values(PUBLIC_RATE_LIMITS).filter((verdict) => verdict.kind === 'throttled').length,
    ).toBeGreaterThan(15);
  });
});

describe('the document declares a 429 exactly where one can be raised', () => {
  it('promises it on every operation a limiter governs', () => {
    const missing = operations()
      .filter(({ method, path, key }) => {
        const limit = rateLimitForOperation({
          method,
          path,
          authenticated: new Set(app.routeAudit.authenticated()).has(key),
          limits: LIMITS,
        });
        return limit.policies.length > 0;
      })
      .filter(({ operation }) => !('429' in (operation.responses as object)))
      .map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('does not promise it on a route nothing limits', () => {
    // The half that was wrong. `GET /health` was documented as answering 429.
    const authenticated = new Set(app.routeAudit.authenticated());
    const invented = operations()
      .filter(({ method, path, key }) => {
        const limit = rateLimitForOperation({
          method,
          path,
          authenticated: authenticated.has(key),
          limits: LIMITS,
        });
        return limit.policies.length === 0;
      })
      .filter(({ operation }) => '429' in (operation.responses as object))
      .map(({ key }) => key);
    expect(invented).toEqual([]);
  });

  it('leaves a meaningful number of operations on each side of that line', () => {
    const withRefusal = operations().filter(({ operation }) => '429' in (operation.responses as object));
    const without = operations().filter(({ operation }) => !('429' in (operation.responses as object)));
    expect(withRefusal.length).toBeGreaterThan(300);
    // Around thirty: the probes, the pre-login chrome, the OAuth return legs and
    // the provider webhooks. A change that drove this to zero would make the
    // assertion above pass by asking nothing.
    expect(without.length).toBeGreaterThan(20);
  });

  it('names the specific probes that stopped promising one', () => {
    for (const key of [
      'GET /health',
      'GET /ready',
      'GET /api/v1/public/settings',
      'POST /api/v1/stripe/webhook',
    ]) {
      const { method, path } = parseRouteKey(key);
      const operation = paths()[templatePath(path)]![method.toLowerCase()]!;
      expect(Object.keys(operation.responses as object), key).not.toContain('429');
    }
  });
});

describe('every 429 the document declares says how to back off', () => {
  it('declares the retry-after header on all of them', () => {
    const bare = operations()
      .map(({ key, operation }) => ({
        key,
        refusal: (operation.responses as Record<string, { headers?: Record<string, unknown> }>)['429'],
      }))
      .filter(({ refusal }) => refusal !== undefined)
      .filter(({ refusal }) => !refusal!.headers || !('retry-after' in refusal!.headers))
      .map(({ key }) => key);
    expect(bare, 'operations declaring a 429 without the header a client backs off on').toEqual([]);
  });

  it('carries the field as well as the header in the problem schema', () => {
    const schema = (
      document().components as { schemas: { Problem: { properties: Record<string, unknown> } } }
    ).schemas.Problem;
    expect(schema.properties).toHaveProperty('retry_after_seconds');
  });
});

describe('the x-ratelimit headers are declared where the service sets them', () => {
  const authenticatedOps = () => {
    const authenticated = new Set(app.routeAudit.authenticated());
    return operations().filter(({ key }) => authenticated.has(key));
  };

  const successHeaders = (operation: Record<string, unknown>): string[] =>
    Object.keys(
      (operation.responses as Record<string, { headers?: Record<string, unknown> }>)['2XX']?.headers ?? {},
    );

  it('gives every authenticated operation the account and organisation trios', () => {
    const missing = authenticatedOps()
      .filter(({ operation }) => {
        const headers = successHeaders(operation);
        return !['x-ratelimit-limit-user', 'x-ratelimit-limit-org', 'x-ratelimit-reset-org'].every((name) =>
          headers.includes(name),
        );
      })
      .map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('adds the cost trio only where the heavy budget is actually charged', () => {
    // `applyCostLimiter` returns before touching the limiter on an ordinary
    // request and sets no header, so declaring the trio everywhere would be
    // describing a response nobody receives.
    const wrong = authenticatedOps()
      .filter(({ method, path, operation }) => {
        const charged = costOfRequest(method, path) > 0;
        return successHeaders(operation).includes('x-ratelimit-limit-cost') !== charged;
      })
      .map(({ key }) => key);
    expect(wrong).toEqual([]);
    expect(
      authenticatedOps().filter(({ operation }) =>
        successHeaders(operation).includes('x-ratelimit-limit-cost'),
      ).length,
      'heavy operations',
    ).toBeGreaterThan(10);
  });

  it('declares none of them on the unauthenticated surface', () => {
    // Those limiters answer with a `retry-after` on the refusal and report
    // nothing on the way there; a declared header that never arrives is worse
    // than an undeclared one, because a client can branch on it.
    const authenticated = new Set(app.routeAudit.authenticated());
    const invented = operations()
      .filter(({ key }) => !authenticated.has(key))
      .filter(({ operation }) => successHeaders(operation).length > 0)
      .map(({ key }) => key);
    expect(invented).toEqual([]);
  });
});

describe('x-rate-limit states the numbers a client would have to guess', () => {
  it('is present on every operation', () => {
    const bare = operations()
      .filter(({ operation }) => !('x-rate-limit' in operation))
      .map(({ key }) => key);
    expect(bare).toEqual([]);
  });

  it('gives an unlimited operation the reviewed sentence rather than silence', () => {
    const unreasoned = operations()
      .map(({ key, operation }) => ({
        key,
        ext: operation['x-rate-limit'] as { unlimited?: boolean; reason?: string },
      }))
      .filter(({ ext }) => ext.unlimited)
      .filter(({ ext }) => !ext.reason)
      .map(({ key }) => key);
    expect(unreasoned).toEqual([]);
  });

  it('charges each heavy operation exactly what the cost table charges it', () => {
    const authenticated = new Set(app.routeAudit.authenticated());
    const wrong = operations()
      .filter(({ key }) => authenticated.has(key))
      .map(({ key, method, path, operation }) => ({
        key,
        declared: (operation['x-rate-limit'] as { cost_units?: number }).cost_units,
        actual: costOfRequest(method, path),
      }))
      .filter(({ declared, actual }) => (actual > 0 ? declared !== actual : declared !== undefined))
      .map(({ key }) => key);
    expect(wrong, 'operations whose declared cost disagrees with domain/requestCost.ts').toEqual([]);
  });

  it('reports the sign-in policy as the two counters the route actually checks', () => {
    const login = paths()['/api/v1/auth/login']!.post!;
    const ext = login['x-rate-limit'] as { policies: Array<{ name: string; windows: unknown[] }> };
    expect(ext.policies.map((policy) => policy.name)).toEqual(['auth-sign-in']);
    // Per email *and* per IP: reporting only one of them would tell a client it
    // has headroom that the other counter is about to deny.
    expect(ext.policies[0]!.windows).toEqual([
      { limit: 10, window_seconds: 900, key: 'email' },
      { limit: 100, window_seconds: 900, key: 'ip' },
    ]);
  });

  it('states the heavy budget in cost units rather than in requests', () => {
    const ai = paths()['/api/v1/valuations/{id}/ai/{pipeline}']!.post!;
    const ext = ai['x-rate-limit'] as {
      cost_units: number;
      policies: Array<{ name: string; windows: Array<{ unit?: string }> }>;
    };
    expect(ext.cost_units).toBe(25);
    const heavy = ext.policies.find((policy) => policy.name === 'heavy-operations');
    expect(heavy?.windows[0]?.unit).toBe('cost-units');
  });
});

describe('the document describes the deployment that served it', () => {
  it('publishes no ceiling when the process installs no limiter', () => {
    // The reason the limits are read off the limiter objects rather than off
    // config: outside production `buildApp` constructs none of them, and a
    // document reciting SESSION_RATE_LIMIT_PER_MIN there would be promising a
    // ceiling nothing applies.
    expect(deploymentRateLimits({})).toEqual({});
    const bare = buildClientOpenApiDocument({
      routes: app.routeAudit.all(),
      authenticated: new Set(app.routeAudit.authenticated()),
      publicReasons: new Map(),
      rateLimits: {},
      version: 'test',
    });
    expect((bare.info as { description: string }).description).toContain('installs no throttle');
    const listed = bare.paths as Record<string, Record<string, Record<string, unknown>>>;
    // …and an authenticated operation then declares no 429 either, because on
    // that deployment nothing can raise one.
    expect(Object.keys(listed['/api/v1/valuations']!.get!.responses as object)).not.toContain('429');
  });

  it('states each installed counter in the description', () => {
    const description = (document().info as { description: string }).description;
    for (const fragment of [
      '300 requests per 60s per account',
      '1500 requests per 60s per organisation',
      '200 cost units per 60s per account',
      'x-ratelimit-',
      'retry_after_seconds',
    ]) {
      expect(description, fragment).toContain(fragment);
    }
  });
});

/**
 * The other half of the contract, and the one that was broken in code rather
 * than in prose: `PROBLEM_CATALOG` tells a refused caller to wait the stated
 * number of seconds, and the number is only stated when the thrower supplies
 * it. Ten of the twenty-one `tooManyRequests` call sites did not — every 429 on
 * the auth surface plus the re-authentication prompt — so the field the
 * published advice names was absent exactly where an anonymous client meets it.
 */
describe('every 429 this service raises states when to come back', () => {
  // The TypeScript services. `services/ai` and `services/engine-wrapper` are
  // Python and raise their own 429s through FastAPI, not through this helper.
  const ROOTS = ['services/valuation/src', 'services/web/src', 'services/report/src', 'packages'];
  const CALL = 'problems.tooManyRequests(';

  /** Replaces comment bodies with spaces, preserving every offset and line. */
  function blankComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (m, keep: string) => keep + ' '.repeat(m.length - keep.length));
  }

  /**
   * True when the argument list starting at `open` has a comma at depth zero —
   * i.e. a second argument was passed. Walks the source rather than matching a
   * regex because these calls span lines and their `detail` is a template
   * literal that may itself contain commas.
   */
  function hasSecondArgument(source: string, open: number): boolean {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i]!;
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) return false;
      } else if (ch === ',' && depth === 1) return true;
    }
    return false;
  }

  function callSites(): Array<{ file: string; line: number; withRetryAfter: boolean }> {
    const sites: Array<{ file: string; line: number; withRetryAfter: boolean }> = [];
    for (const root of ROOTS) {
      const dir = path.join(SRC, root);
      if (!existsSync(dir)) continue;
      for (const file of sourceFiles(dir)) {
        const segments = file.split(path.sep);
        // Build output, and the shared package's own tests of the helper — those
        // exercise `tooManyRequests` with and without the argument on purpose.
        if (segments.includes('dist') || segments.includes('test')) continue;
        // Comments blanked, not stripped, so every offset below still names the
        // right line. R369's `realtimeStreams.ts` opens by quoting the very call
        // it exists to instrument — "the route answers
        // `problems.tooManyRequests(...)`" — and this scan read the ellipsis as
        // a bare 429 and failed on a paragraph. A census red for a reason that
        // cannot be fixed in the code it audits is a census people learn to
        // ignore, which is the whole failure it was written against (R420).
        const source = blankComments(readFileSync(file, 'utf8'));
        for (let at = source.indexOf(CALL); at !== -1; at = source.indexOf(CALL, at + 1)) {
          const open = at + CALL.length - 1;
          sites.push({
            file: path.relative(SRC, file).split(path.sep).join('/'),
            line: source.slice(0, at).split('\n').length,
            withRetryAfter: hasSecondArgument(source, open),
          });
        }
      }
    }
    return sites;
  }

  it('scans every tree it claims to', () => {
    expect(ROOTS.filter((root) => !existsSync(path.join(SRC, root)))).toEqual([]);
  });

  it('passes a retry-after at every call site', () => {
    const bare = callSites()
      .filter((site) => !site.withRetryAfter)
      .map((site) => `${site.file}:${site.line}`);
    expect(bare, '429s raised without the seconds the catalogue promises the caller').toEqual([]);
  });

  it('finds the call sites it is supposed to be checking', () => {
    // The vacuity guard: a renamed helper would empty the scan and the
    // assertion above would pass by asking nothing.
    expect(callSites().length).toBeGreaterThan(15);
  });

  it('does not read a paragraph about a 429 as a 429', () => {
    // R420. The modules that count their own refusals explain themselves by
    // quoting the call, and half of those quotations are `(...)`. Pinned here
    // rather than only by the green above, so a future edit to `blankComments`
    // that stops blanking is caught by an assertion that says why.
    const prose = '/* the route answers `problems.tooManyRequests(...)` */\n';
    const real = "problems.tooManyRequests('nope', 30);";
    expect(blankComments(prose + real).indexOf(CALL)).toBe((prose + real).indexOf(real));
    // And blanking preserves offsets, so the line number a failure reports is
    // still the line the call is on.
    expect(blankComments(prose + real)).toHaveLength((prose + real).length);
  });

  it('reads the argument list rather than the line', () => {
    // The scanner has to see past a template literal containing a comma, and
    // past a nested call, or it reports a false pass and a false failure in
    // turn.
    const withComma = 'problems.tooManyRequests(`too many, slow down`)';
    const nested = 'problems.tooManyRequests(detail(a, b))';
    const second = 'problems.tooManyRequests(`too many, slow down`, wait(a, b))';
    expect(hasSecondArgument(withComma, withComma.indexOf('('))).toBe(false);
    expect(hasSecondArgument(nested, nested.indexOf('('))).toBe(false);
    expect(hasSecondArgument(second, second.indexOf('('))).toBe(true);
  });
});
