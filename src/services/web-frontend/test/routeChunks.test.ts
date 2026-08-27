import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_MODULE_FILES, routeModuleFor } from '../src/lib/routeChunks';
import { allPageMeta } from '../src/lib/pageMetaRoutes';
import { routePreloadTags, withRoutePreloads } from '../src/lib/prerender';

const ROOT = path.resolve(__dirname, '..');

/**
 * Every prerendered route names the module that serves it.
 *
 * The registry buys back a round trip: a prerendered document is the finished
 * page, but its route's JavaScript is lazy, so without a `modulepreload` the
 * browser cannot start fetching it until `index.js` has downloaded and run.
 * A missing entry is invisible — the page still works, one round trip slower —
 * which is exactly the kind of regression that survives a release. So the
 * coverage is asserted rather than trusted, in both directions: no published
 * route without a module, and no module that has been renamed out from under
 * the registry.
 */
describe('every prerendered route resolves to a page module', () => {
  const routes = allPageMeta().map((p) => p.path);

  it('covers every route the prerenderer emits', () => {
    const uncovered = routes.filter((p) => routeModuleFor(p) === undefined);
    expect(uncovered).toEqual([]);
  });

  it('names only modules that exist', () => {
    for (const file of ROUTE_MODULE_FILES) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it('leaves the landing page alone — it is already in the entry chunk', () => {
    expect(routeModuleFor('/')).toBe('');
  });

  it('resolves each family to one module, and the families to different ones', () => {
    const families = [
      '/products/409a-valuation',
      '/409a-valuation/series-b',
      '/partners/cap-table-platforms',
      '/compare/carta',
    ].map((p) => routeModuleFor(p));
    expect(new Set(families).size).toBe(families.length);
    expect(families.every(Boolean)).toBe(true);
    // Two routes of one family share a chunk; that is the point of the split.
    expect(routeModuleFor('/compare/carta')).toBe(routeModuleFor('/compare/scalar'));
    // …and the hub is a different page from the comparisons it lists.
    expect(routeModuleFor('/compare/409a-valuation-providers')).not.toBe(routeModuleFor('/compare/carta'));
  });
});

describe('the preload tags a prerendered document carries', () => {
  const shell =
    '<head>\n    <link rel="modulepreload" crossorigin href="/assets/vendor-react-a.js">\n</head>';

  it('never preloads a chunk the shell already references', () => {
    const tags = routePreloadTags(['assets/PricingPage-x.js', 'assets/vendor-react-a.js'], shell);
    expect(tags).toContain('PricingPage-x.js');
    expect(tags).not.toContain('vendor-react-a.js');
  });

  it('emits nothing when there is nothing left to add', () => {
    expect(routePreloadTags(['assets/vendor-react-a.js'], shell)).toBe('');
    expect(withRoutePreloads(shell, ['assets/vendor-react-a.js'])).toBe(shell);
    expect(withRoutePreloads(shell, [])).toBe(shell);
  });

  it('puts them inside the head, before anything the shell declares', () => {
    const html = withRoutePreloads(shell, ['assets/PricingPage-x.js']);
    expect(html.indexOf('PricingPage-x.js')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('PricingPage-x.js')).toBeLessThan(html.indexOf('vendor-react-a.js'));
  });
});
