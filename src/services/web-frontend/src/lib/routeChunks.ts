/**
 * Which page module serves each prerendered marketing route.
 *
 * Build-time only — the prerenderer uses it to name a route's own JavaScript
 * chunk in that route's static HTML. Nothing at runtime imports this file.
 *
 * The problem it solves is a round trip. A prerendered document carries the
 * shell's script tags, and every route below the landing page is lazy, so the
 * browser cannot learn that `/pricing` needs `PricingPage.js` until it has
 * downloaded `index.js`, executed it, and let React reach the lazy import.
 * That is HTML → entry → route, strictly sequential, before the page paints.
 * A `modulepreload` for the route's chunk in the head collapses it to two.
 *
 * Rollup names chunks by content hash, so the mapping cannot be written down
 * here; what is written down is the *module*, and the plugin looks up the chunk
 * Rollup emitted for it. `test/routeChunks.test.ts` fails if a published route
 * has no entry, or if an entry names a file that does not exist.
 */

/** Matched in order; the first pattern that matches a route path wins. */
const ROUTE_MODULES: Array<[RegExp, string]> = [
  // The landing page is eager on purpose — it is in the entry chunk, and there
  // is nothing extra to fetch.
  [/^\/$/, ''],
  [/^\/pricing$/, 'src/pages/marketing/PricingPage.tsx'],
  [/^\/which-valuation$/, 'src/pages/marketing/WhichValuationPage.tsx'],
  [
    /^\/(409a-valuation-guide|when-do-you-need-a-409a|how-much-does-a-409a-cost)$/,
    'src/pages/marketing/GuidePages.tsx',
  ],
  [/^\/tools\/409a-valuation-calculator$/, 'src/pages/marketing/CalculatorPage.tsx'],
  [/^\/sample-report$/, 'src/pages/marketing/SampleReportPage.tsx'],
  [/^\/compare\/409a-valuation-providers$/, 'src/pages/marketing/CompareHubPage.tsx'],
  [/^\/developers$/, 'src/pages/marketing/DevelopersPage.tsx'],
  [/^\/blog$/, 'src/pages/marketing/BlogPages.tsx'],
  [/^\/(about|contact|terms-of-service|privacy-policy)$/, 'src/pages/marketing/StaticPages.tsx'],
  [/^\/products\/[^/]+$/, 'src/pages/marketing/ProductPage.tsx'],
  [/^\/409a-valuation\/[^/]+$/, 'src/pages/marketing/StagePage.tsx'],
  // `/partners` and `/partners/:segment` are two exports of one module.
  [/^\/partners(\/[^/]+)?$/, 'src/pages/marketing/PartnerPages.tsx'],
  [/^\/compare\/[^/]+$/, 'src/pages/marketing/ComparePage.tsx'],
];

/** Every module a prerendered route can resolve to, for the census test. */
export const ROUTE_MODULE_FILES: readonly string[] = [
  ...new Set(ROUTE_MODULES.map(([, mod]) => mod).filter(Boolean)),
];

/**
 * The module serving `path`, relative to the package root.
 *
 * Returns `''` for a route already in the entry chunk and `undefined` for a
 * path this registry does not describe — the caller emits no preload for
 * either, so a missing entry costs a round trip rather than a broken page.
 */
export function routeModuleFor(path: string): string | undefined {
  return ROUTE_MODULES.find(([pattern]) => pattern.test(path))?.[1];
}
