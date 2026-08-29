import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECEIVERS, scanRoutes } from '../support/routeSource.js';

/**
 * The census behind the censuses.
 *
 * Three route sweeps — `privilegedRouteAuthorization`,
 * `resourceScopeAuthorization` and `authorizationCoverageCensus` — assert
 * things about "every route". None of them can see a route the scan does not
 * return, and a scan that quietly stops matching passes all three at once: the
 * lists it compares are empty on both sides, so the suites go green while the
 * surface they claim to audit is unswept.
 *
 * That is not the abstract failure mode. Matching `app.get(` and nothing else —
 * which is what all three did — left out every route registered on an
 * encapsulated instance, and there are six such families: the Stripe, billing
 * and email-delivery webhooks, `POST /api/v1/unsubscribe`, the SAML assertion
 * consumer, and all six SCIM routes. Payments and identity, in other words.
 *
 * So the scan's two assumptions are asserted here rather than trusted:
 *
 * * the receiver names it matches are the only ones `src/routes` uses, so a
 *   seventh spelling is a failure here rather than a silent shrink; and
 * * a route registered under a `register` prefix resolves to the URL the
 *   service actually answers on, not the fragment in the source.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

const ALL = scanRoutes(ROUTES);
const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
const KEYS = new Set(ALL.map(key));

describe('the route source scan', () => {
  it('finds a route table of the size this service has', () => {
    expect(ALL.length).toBeGreaterThan(400);
  });

  it('matches every receiver a route in src/routes is registered on', () => {
    /*
     * The inverse of the allow-list: find every `<identifier>.<verb>(` in the
     * route files whose first argument is a path literal, and require the
     * identifier to be one the scan knows. A `Map.get('/some/key')` would show
     * up here too — none exists today, and if one is written the answer is to
     * look at it, which is the point.
     */
    const seen = new Set<string>();
    for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(ROUTES, file), 'utf8');
      for (const m of source.matchAll(
        /\b([A-Za-z_$][\w$]*)\.(?:get|post|put|patch|delete)[<(][^)]{0,80}?["'`]\//g,
      )) {
        seen.add(m[1]!);
      }
    }
    expect([...seen].filter((r) => !(RECEIVERS as readonly string[]).includes(r)).sort()).toEqual([]);
  });

  it('resolves a route registered under a register() prefix to the URL it answers on', () => {
    // SCIM is the prefixed surface. Its handlers read `scope.get('/Users')`;
    // the service answers at `/scim/v2/Users`, and every census keys on the
    // latter — `PRIVILEGED_PREFIXES` has `/scim/v2` in it.
    for (const expected of [
      'GET /scim/v2/ServiceProviderConfig',
      'GET /scim/v2/Users',
      'POST /scim/v2/Users',
      'GET /scim/v2/Users/:id',
      'PATCH /scim/v2/Users/:id',
      'DELETE /scim/v2/Users/:id',
    ]) {
      expect(KEYS).toContain(expected);
    }
    // And nothing filed under the unresolved fragment.
    expect([...KEYS].filter((k) => /^\w+ \/Users/.test(k))).toEqual([]);
  });

  it('sees the routes registered on an encapsulated scope for their own body parser', () => {
    for (const expected of [
      'POST /api/v1/auth/saml/acs',
      'POST /api/v1/stripe/webhook',
      'POST /api/v1/billing/webhook',
      'POST /api/v1/unsubscribe',
      'POST /api/v1/webhooks/email/:provider',
    ]) {
      expect(KEYS).toContain(expected);
    }
  });

  it('reads a handler body to its own closing brace, whatever its indentation', () => {
    // A route inside a `register` callback is indented one level deeper. Cut on
    // a fixed column, its body ends at the first nested `});` — which reads as
    // a handler that calls no guard and consults no caller.
    const patch = ALL.find((r) => key(r) === 'PATCH /scim/v2/Users/:id');
    expect(patch).toBeDefined();
    expect(patch!.body).toContain('loadManaged');
    expect(patch!.body).toContain('activeFromPatch');
    expect(patch!.body).toContain('User not found');
  });
});
