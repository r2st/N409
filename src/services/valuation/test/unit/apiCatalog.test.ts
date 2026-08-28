/**
 * The generated client-API spec, held to the route table it claims to describe.
 *
 * Three things can go wrong with a document like this, and only the first is
 * obvious:
 *
 *  1. it under-reports — a route ships and the spec does not mention it;
 *  2. it over-reports — a section or a tag outlives the routes it described,
 *     so the document advertises a surface that no longer exists;
 *  3. it misreports — an operation is marked public that needs a session, or
 *     the other way round, which is the one error that costs a reader something
 *     worse than confusion.
 *
 * All three are checked against `app.routeAudit`, which is the same structure
 * the boot-time authentication guard uses, so none of them can be answered from
 * a list somebody maintains alongside the routes.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PROBLEM_CATALOG, ApiProblem } from '@n409/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { PUBLIC_ROUTES } from '../../src/plugins/routeAudit.js';
import { FixedWindowRateLimiter, WeightedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { deploymentRateLimits } from '../../src/domain/rateLimitPolicy.js';
import {
  API_SECTIONS,
  API_TAGS,
  buildClientOpenApiDocument,
  parseRouteKey,
  sectionFor,
  templatePath,
  underPrefix,
} from '../../src/domain/apiCatalog.js';

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
 * Production's throttles, passed explicitly.
 *
 * `buildApp` only installs these when `NODE_ENV` is production, and the
 * document is honest about that — a deployment enforcing nothing publishes no
 * ceiling and no 429. Generating the document here with none installed would
 * therefore describe a surface the deployed service does not have.
 * `rateLimitPolicyCensus.test.ts` owns the rate-limit half; this file just
 * needs the document to look like the deployed one.
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

describe('every registered route is placed in a section', () => {
  it('leaves nothing unplaced', () => {
    const orphans = app.routeAudit
      .all()
      .map((key) => parseRouteKey(key))
      .filter((route) => !sectionFor(route.path))
      .map((route) => `${route.method} ${route.path}`);
    expect(orphans, 'routes matching no prefix in API_SECTIONS').toEqual([]);
  });

  it('finds the routes it is supposed to be placing', () => {
    // A route table that came back empty would make the check above pass by
    // asking nothing — the same shape of vacuous guard the problem-type census
    // had to be rescued from.
    expect(app.routeAudit.all().length).toBeGreaterThan(300);
  });

  it('has no section that matches nothing', () => {
    const routes = app.routeAudit.all().map((key) => parseRouteKey(key).path);
    const dead = API_SECTIONS.filter(
      (section) => !routes.some((path) => underPrefix(path, section.prefix)),
    ).map((section) => section.prefix);
    expect(dead, 'prefixes in API_SECTIONS that no registered route sits under').toEqual([]);
  });

  it('has no tag that no section reaches, and no section naming an undeclared tag', () => {
    const declared = new Set(API_TAGS.map((tag) => tag.name));
    const used = new Set(API_SECTIONS.map((section) => section.tag));
    expect(
      [...used].filter((tag) => !declared.has(tag)),
      'sections naming an undeclared tag',
    ).toEqual([]);
    expect(
      [...declared].filter((tag) => !used.has(tag)),
      'tags no section reaches',
    ).toEqual([]);
  });

  it('describes every tag it declares', () => {
    for (const tag of API_TAGS) {
      // Tag prose is the only documentation this spec carries, so a placeholder
      // here is the whole document being empty for that group of endpoints.
      expect(tag.description.length, `${tag.name} description`).toBeGreaterThan(60);
    }
  });

  it('matches a prefix only at a segment boundary', () => {
    // `/api/v1/me` and `/api/v1/metrics` differ after the shared prefix by a
    // character, not a slash — a naive `startsWith` files the second under
    // "Current user".
    expect(underPrefix('/api/v1/metrics', '/api/v1/me')).toBe(false);
    expect(underPrefix('/api/v1/me/tokens', '/api/v1/me')).toBe(true);
    expect(underPrefix('/api/v1/me', '/api/v1/me')).toBe(true);
    // And the root section covers the banner alone rather than the whole API.
    expect(underPrefix('/health', '/')).toBe(false);
    expect(underPrefix('/', '/')).toBe(true);
  });

  it('prefers the longest matching prefix', () => {
    expect(sectionFor('/api/v1/valuations/:id/payments/quote')?.tag).toBe('Billing');
    expect(sectionFor('/api/v1/valuations/:id/params')?.tag).toBe('Valuations');
    expect(sectionFor('/api/v1/intake/schema')?.tag).toBe('Valuation schemas');
    expect(sectionFor('/api/v1/intake/portal')?.tag).toBe('Client intake');
  });
});

describe('the generated document describes the service that generated it', () => {
  it('has an operation for every non-partner route and nothing else', () => {
    const rendered = new Set<string>();
    for (const [path, operations] of Object.entries(paths())) {
      for (const method of Object.keys(operations)) rendered.add(`${method.toUpperCase()} ${path}`);
    }
    const expected = new Set(
      app.routeAudit
        .all()
        .map((key) => parseRouteKey(key))
        .filter((route) => !sectionFor(route.path)?.excluded)
        .map((route) => `${route.method} ${templatePath(route.path)}`),
    );
    expect([...expected].filter((key) => !rendered.has(key)).sort()).toEqual([]);
    expect([...rendered].filter((key) => !expected.has(key)).sort()).toEqual([]);
    expect(rendered.size).toBeGreaterThan(300);
  });

  it('omits the partner routes, which have their own richer spec', () => {
    const partner = Object.keys(paths()).filter((path) => path.startsWith('/api/partner/'));
    expect(partner).toEqual([]);
    // …but the routes exist, so this is an exclusion rather than an absence.
    expect(app.routeAudit.all().some((key) => key.includes('/api/partner/v1/'))).toBe(true);
  });

  it('marks an operation public exactly when the route is not authenticated', () => {
    const authenticated = new Set(app.routeAudit.authenticated());
    const wrong: string[] = [];
    for (const key of app.routeAudit.all()) {
      const { method, path } = parseRouteKey(key);
      if (sectionFor(path)?.excluded) continue;
      const operation = paths()[templatePath(path)]![method.toLowerCase()]!;
      const declaresAuth = (operation.security as unknown[]).length > 0;
      if (declaresAuth !== authenticated.has(key)) wrong.push(key);
    }
    expect(wrong, 'operations whose security block disagrees with the preHandler').toEqual([]);
  });

  it('gives every public operation the reason it is public', () => {
    const rendered = paths();
    for (const route of PUBLIC_ROUTES) {
      const path = templatePath(route.url);
      if (sectionFor(route.url)?.excluded) continue;
      const operation = rendered[path]?.[route.method.toLowerCase()];
      expect(operation, `${route.method} ${route.url} is missing from the spec`).toBeDefined();
      expect(operation!.description as string).toContain(route.reason);
    }
  });

  it('leaves authenticated operations without invented prose', () => {
    // The deliberate omission. A summary rearranged out of the path reads like
    // documentation and is not, and a reader cannot tell the two apart — so an
    // operation with nothing true to say says nothing.
    const rendered = paths();
    const authenticated = app.routeAudit.authenticated();
    const invented = authenticated
      .map((key) => parseRouteKey(key))
      .filter((route) => !sectionFor(route.path)?.excluded)
      .filter((route) => 'summary' in (rendered[templatePath(route.path)]![route.method.toLowerCase()] ?? {}))
      .map((route) => `${route.method} ${route.path}`);
    expect(invented).toEqual([]);
  });

  it('declares path parameters for every templated segment', () => {
    for (const [path, operations] of Object.entries(paths())) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      for (const [method, operation] of Object.entries(operations)) {
        const declared = ((operation.parameters as Array<{ name: string }> | undefined) ?? []).map(
          (p) => p.name,
        );
        expect(declared.sort(), `${method} ${path}`).toEqual([...names].sort());
      }
    }
  });

  it('gives every operation a unique operationId', () => {
    const ids = Object.values(paths()).flatMap((operations) =>
      Object.values(operations).map((operation) => operation.operationId as string),
    );
    // A generator turns these into method names; a collision silently drops one.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the error half of the document is the error catalogue', () => {
  it('declares every field the shared problem handler can emit', () => {
    // A spec that under-reports the error body is how a client ends up with no
    // generated type for `retry_after_seconds` — the one field a 429 handler
    // needs — and reaches past its own types to find it, or does not.
    const body = new ApiProblem({
      status: 429,
      title: 'Too Many Requests',
      type: 'urn:n409:problem:rate-limited',
      detail: 'slow down',
      retryAfterSeconds: 30,
      extensions: { errors: [{ path: ['kind'] }] },
    }).toBody('/api/v1/valuations');
    const schema = (document().components as { schemas: { Problem: { properties: object } } }).schemas
      .Problem;
    expect(Object.keys(body).filter((key) => !(key in schema.properties))).toEqual([]);
  });

  it('offers the catalogue’s own vocabulary as the enum of `type`', () => {
    const schema = (
      document().components as { schemas: { Problem: { properties: { type: { enum: string[] } } } } }
    ).schemas.Problem;
    expect(schema.properties.type.enum.sort()).toEqual(Object.keys(PROBLEM_CATALOG).sort());
  });

  it('describes each declared failure with the catalogue’s own sentences', () => {
    const operation = paths()['/api/v1/valuations']!.get!;
    const responses = operation.responses as Record<string, { description: string }>;
    for (const [status, type] of [
      ['401', 'urn:n409:problem:unauthorized'],
      ['403', 'urn:n409:problem:forbidden'],
      ['404', 'urn:n409:problem:not-found'],
      ['429', 'urn:n409:problem:rate-limited'],
      ['500', 'urn:n409:problem:internal'],
    ] as const) {
      expect(responses[status]!.description).toContain(PROBLEM_CATALOG[type]!.resolution);
    }
  });

  it('does not promise a 401 on a route that never requires a session', () => {
    // Telling a client to handle an authentication failure on the sign-in route
    // is the kind of noise that makes a generated client's error handling
    // meaningless.
    const login = paths()['/api/v1/auth/login']!.post!;
    expect(Object.keys(login.responses as object)).not.toContain('401');
  });
});

describe('the documents are served', () => {
  it('serves the spec as an OpenAPI document, without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    // The registered media type, not application/json: tools content-sniff on
    // it, and several of them ask the user what the file is otherwise.
    expect(res.headers['content-type']).toContain('application/openapi+json');
    const body = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    // Served after `ready()`, so the route table is complete — a spec built
    // during registration would describe whatever had been registered so far.
    expect(Object.keys(body.paths).length).toBeGreaterThan(200);
    expect(body.paths['/api/v1/openapi.json']).toBeDefined();
  });

  it('serves the error catalogue, without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/problems' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { problems: Array<{ type: string; resolution: string }> };
    expect(body.problems.map((p) => p.type).sort()).toEqual(Object.keys(PROBLEM_CATALOG).sort());
    // The array projection has to lose nothing, which is why each entry repeats
    // its own key rather than relying on the map it came out of.
    for (const entry of body.problems) expect(entry.resolution.length).toBeGreaterThan(40);
  });

  it('answers a problem+json body a client can look up in what it just served', async () => {
    // The loop closing: a failure carries a `type`, and the same deployment
    // will explain that `type` to an unauthenticated caller.
    const refused = await app.inject({ method: 'GET', url: '/api/v1/valuations' });
    expect(refused.statusCode).toBe(401);
    const problem = refused.json() as { type: string };
    const catalogue = await app.inject({ method: 'GET', url: '/api/v1/problems' });
    const types = (catalogue.json() as { problems: Array<{ type: string }> }).problems.map((p) => p.type);
    expect(types).toContain(problem.type);
  });
});
