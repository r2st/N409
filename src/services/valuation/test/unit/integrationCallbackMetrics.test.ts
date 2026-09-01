import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  recordIntegrationCallbackOutcome,
  registerIntegrationCallbackMetrics,
  resetIntegrationCallbackMetrics,
} from '../../src/observability/integrationCallbacks.js';

/**
 * A connect flow that fails as a 302 (R341, methodology M11).
 *
 * The three OAuth callbacks — HRIS, accounting, cap-table sync — each build one
 * `back(result)` helper and answer every outcome through it, refusals included,
 * as a redirect to the engagement's page. Five results go through it and only
 * two left a trace anywhere: `connected` writes an audit event through
 * `upsertConnection`, `error` writes a warn for the token exchange. `denied`,
 * `retired` and `unauthorized` wrote nothing at all, on any of the three doors.
 *
 * Which is `ssoOutcomes.ts`'s shape one flow over. A refusal answered as a
 * redirect is counted in `http_requests_total`'s 3xx class beside every ordinary
 * navigation; `HighServerErrorRate` sees no 5xx, `SlowRequests` sees nothing,
 * and the breakers see nothing because the provider is not one of ours. So a
 * rotated Rippling client secret, a redirect URI that no longer matches, or a
 * role migration that breaks `isOps` refuses every connection attempt with every
 * instrument on the box reading green — and the only symptom is a query
 * parameter in one person's browser.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = ['hris', 'accounting', 'capTableSync'] as const;
const sourceOf = (route: string) => readFileSync(path.resolve(HERE, `../../src/routes/${route}.ts`), 'utf8');

describe('the integration callback outcome counter', () => {
  afterEach(() => resetIntegrationCallbackMetrics());

  it('counts an outcome by family', () => {
    const registry = new MetricsRegistry();
    registerIntegrationCallbackMetrics(registry);
    recordIntegrationCallbackOutcome('hris', 'unauthorized');
    recordIntegrationCallbackOutcome('accounting', 'connected');
    recordIntegrationCallbackOutcome('cap-table', 'denied');

    const text = registry.render();
    expect(text).toContain('integration_callback_outcomes_total{family="hris",outcome="unauthorized"} 1');
    expect(text).toContain('integration_callback_outcomes_total{family="accounting",outcome="connected"} 1');
    expect(text).toContain('integration_callback_outcomes_total{family="cap-table",outcome="denied"} 1');
  });

  it('is inert before registration rather than throwing', () => {
    expect(() => recordIntegrationCallbackOutcome('hris', 'error')).not.toThrow();
  });

  it('records from inside `back`, so no outcome can be added without one', () => {
    /*
     * The `scheduleSweep` argument. A recorder at each of the five `return`
     * sites is a recorder the sixth is written without — and the sixth is
     * exactly the kind of outcome that gets added later, on a refusal path,
     * which is the population that was silent to begin with.
     *
     * Held structurally: `back` must be the only thing that redirects in this
     * handler, and it must record.
     */
    for (const route of ROUTES) {
      const src = sourceOf(route);
      const back =
        /const back = \(result: IntegrationCallbackOutcome\) => \{\s*recordIntegrationCallbackOutcome\('(hris|accounting|cap-table)', result\);\s*return reply\.redirect\(/;
      expect(src, route).toMatch(back);
      // Every callback outcome goes through it: the only `reply.redirect` in
      // the file is the one inside `back`.
      expect([...src.matchAll(/reply\.redirect\(/g)], route).toHaveLength(1);
    }
  });

  it('keeps `connected` on every door, so a refusal ratio has a denominator', () => {
    // One person clicking Deny on a consent screen is Tuesday; nothing but
    // `denied` for an afternoon is a setting somebody changed. A bare refusal
    // count cannot separate those, and how many connections a firm makes per
    // day is not something a dashboard holds.
    for (const route of ROUTES) {
      expect(sourceOf(route), route).toContain("back('connected')");
    }
  });

  it('writes a line for the two refusals a person has to act on', () => {
    /*
     * The counter is what a rule reads; this is the half somebody needs once it
     * has fired, and it is where the identities are. `retired` names an
     * engagement the firm withdrew while somebody was on a consent screen;
     * `unauthorized` is a thirty-minute token presented by an account whose
     * access ended inside those thirty minutes. Neither wrote anything at all,
     * and `registerProblemHandler` cannot see either — they are 302s, not 4xx.
     */
    for (const route of ROUTES) {
      const src = sourceOf(route);
      expect(src, route).toContain(
        "'integration callback refused: the engagement was withdrawn during the OAuth hop'",
      );
      expect(src, route).toContain(
        "'integration callback refused: the actor may no longer complete this connection'",
      );
      // With the three fields that make the line answerable: which provider,
      // which engagement, and who was holding the token.
      expect(
        [...src.matchAll(/\{ provider, valuationId: state\.valuationId, userId: state\.userId \}/g)],
        route,
      ).toHaveLength(2);
    }
  });

  it('is registered on the app, or nothing above reaches a scrape', () => {
    const app = readFileSync(path.resolve(HERE, '../../src/app.ts'), 'utf8');
    expect(app).toContain('registerIntegrationCallbackMetrics(metricsRegistry)');
  });
});
