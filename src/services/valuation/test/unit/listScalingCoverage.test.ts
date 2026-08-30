import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../support/routeSource.js';
import {
  collectionRoutes,
  pathOf,
  ROUTES_DIR,
  SCALING_ENDPOINTS,
  shapeOf,
  UNMEASURED,
} from '../support/listEndpoints.js';

/**
 * The roster `listQueryScaling` measures covers the collection endpoints the
 * service actually registers.
 *
 * The scaling suite is a population guard — "no list endpoint costs more
 * statements as the list grows" — and a population guard is worth exactly what
 * its population is. Its roster was a literal inside the integration file,
 * hand-extended by whoever remembered, and it had fallen thirteen endpoints
 * behind: an unlisted endpoint is not asked, and not being asked reads in a
 * test run exactly like passing.
 *
 * This is the guard on the guard, and it is a *unit* test on purpose. The
 * suite it protects skips itself where there is no Postgres, so the roster's
 * only check used to disappear on precisely the machines least likely to
 * notice. A source scan needs no database, so the drift fails everywhere.
 *
 * It cannot say whether an endpoint is *correctly* measured — only that it is
 * measured. The statement counting is the integration suite's job; keeping it
 * pointed at everything is this one's.
 */
describe('every collection endpoint is measured for statement scaling', () => {
  const measured = new Set(SCALING_ENDPOINTS.map(([, url]) => pathOf(url)));

  it('is reading a real route table', () => {
    // The vacuity guard. Both halves of the predicate are shapes this codebase
    // reformats — a route registration wrapped onto two lines, a repo helper
    // renamed — and the census passes trivially the moment either stops firing.
    expect(scanRoutes(ROUTES_DIR).length).toBeGreaterThan(300);
    const routes = collectionRoutes();
    expect(routes.length).toBeGreaterThan(40);

    // And it is finding collections rather than everything: `/api/v1/me` reads
    // one row and is out, `/api/v1/funds` reads many and is in.
    const urls = routes.map((r) => r.url);
    expect(urls).toContain('/api/v1/funds');
    expect(urls).not.toContain('/api/v1/me');
  });

  it('leaves no collection endpoint unaccounted for', () => {
    const unaccounted = collectionRoutes()
      .filter((r) => !measured.has(r.url) && !(r.url in UNMEASURED))
      .map((r) => `${r.url} (${r.file}:${r.line})`);
    expect([...new Set(unaccounted)]).toEqual([]);
  });

  it('measures nothing the service no longer registers', () => {
    // The other direction, and the one a rename breaks: a measured URL that no
    // longer exists answers 404, and the integration suite's own guard turns
    // that into a failure only where a database is up.
    const registered = new Set(scanRoutes(ROUTES_DIR).map((r) => shapeOf(r.url)));
    const gone = SCALING_ENDPOINTS.map(([, url]) => shapeOf(url)).filter((url) => !registered.has(url));
    expect([...new Set(gone)]).toEqual([]);
  });

  it('names no exemption that has stopped being a collection endpoint', () => {
    const routes = new Set(collectionRoutes().map((r) => r.url));
    expect(Object.keys(UNMEASURED).filter((url) => !routes.has(url))).toEqual([]);
  });

  it('states a mechanism, not a hope, for every exemption', () => {
    // Same bar as `unboundedListCensus`: "it is a small list" is the reason a
    // per-row query survives to the day the list is not.
    const vague = Object.entries(UNMEASURED).filter(
      ([, why]) =>
        why.trim().length < 40 ||
        /\b(small|short|few|low) (enough|in practice)\b|\bunlikely to\b|\brarely\b|\bfor now\b|\bnobody has\b|\bin practice\b/i.test(
          why,
        ),
    );
    expect(vague.map(([url]) => url)).toEqual([]);
  });

  it('gives every measured endpoint a distinct label', () => {
    // The suite keys its two measurements by label, so a duplicate silently
    // drops one endpoint's "before" reading onto another's "after".
    const labels = SCALING_ENDPOINTS.map(([label]) => label);
    expect(labels.length).toBe(new Set(labels).size);
  });
});
