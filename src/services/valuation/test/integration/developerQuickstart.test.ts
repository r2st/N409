// The public quickstart, checked against the API it claims to describe.
//
// WHY: `/developers` renders its endpoint *table* from the server's own route
// registry, so that half cannot drift. The quickstart above it is hand-written
// curl, and it drifted immediately — step 1 told every prospective partner to
// call `GET /api/partner/v1/me`, and that endpoint did not exist. Anyone
// evaluating the integration ran the first command in the documentation and got
// a 404.
//
// That is the worst place to be wrong. The table is correct by construction and
// therefore never read suspiciously, and the prose beside it inherits that
// credibility without having earned it.
//
// So the prose is checked too: every path the quickstart calls must be an
// endpoint this service actually registers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PARTNER_API_ENDPOINTS, PARTNER_API_PREFIX } from '../../src/routes/partnerApi.js';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(here, '../../../web-frontend/src/pages/marketing/DevelopersPage.tsx');

/**
 * The API paths the quickstart tells a reader to call.
 *
 * The source is a template literal interpolating `PARTNER_API.prefix`, so the
 * marker to look for is the interpolation rather than the resolved prefix.
 * Concrete ids and query strings are normalized to the registry's own spelling:
 * a doc naming `/valuations/$ID/submit` is describing `/valuations/{id}/submit`,
 * and the registry is the thing being checked against.
 */
function quickstartPaths(): string[] {
  const source = readFileSync(PAGE, 'utf8');
  const found = [...source.matchAll(/\$\{PARTNER_API\.prefix\}([^\s"'`\\]*)/g)].map((m) => m[1]!);
  return [
    ...new Set(
      found
        .map((p) => p.split('?')[0]!)
        .map((p) => p.replace(/\/\$[A-Z_]+/g, '/{id}'))
        .filter((p) => p !== ''),
    ),
  ];
}

describe.skipIf(!dbUp)('the developer quickstart only calls endpoints that exist', () => {
  let ctx: TestApp;

  // The registry is populated as a side effect of registering the routes, so an
  // app has to exist before it can be read.
  beforeAll(async () => {
    ctx = await setupTestApp({});
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('finds paths to check, so a rewritten page cannot make this vacuous', () => {
    // Without this the regex silently matching nothing would be a passing test
    // over an empty list — the same shape of vacuity as a guard that stops
    // running when its precondition disappears.
    expect(quickstartPaths().length).toBeGreaterThanOrEqual(4);
  });

  it('names only registered endpoints', () => {
    const registered = new Set(PARTNER_API_ENDPOINTS.map((e) => e.path));
    const unknown = quickstartPaths().filter((p) => !registered.has(p));
    expect(unknown, `quickstart calls endpoints this API does not have: ${unknown.join(', ')}`).toEqual([]);
  });

  // The one that was broken, stated as itself.
  it('includes /me, which the API now has', () => {
    expect(quickstartPaths()).toContain('/me');
    expect(PARTNER_API_ENDPOINTS.map((e) => e.path)).toContain('/me');
  });

  // A quickstart that stops at "create" describes an integration that never
  // hands anything over — which is what this one did, because there was
  // nothing to hand over with.
  it('walks the whole lifecycle, not just the create', () => {
    const paths = quickstartPaths();
    expect(paths).toContain('/valuations');
    expect(paths).toContain('/valuations/{id}/documents');
    expect(paths).toContain('/valuations/{id}/submit');
  });

  it('uses the prefix the routes are actually mounted on', () => {
    expect(PARTNER_API_PREFIX).toBe('/api/partner/v1');
    expect(readFileSync(PAGE, 'utf8')).toContain('${PARTNER_API.prefix}');
  });
});
