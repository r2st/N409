import { COMPARISONS, FUNDING_STAGES, PRODUCTS } from './marketing';

/**
 * Static route inventory for SEO (409.ai §24). Pure data — no browser or
 * `import.meta` access — so it can be imported both by the client bundle and by
 * the Vite build plugin that emits `sitemap.xml`.
 */
export interface SitemapRoute {
  /** Absolute path, always leading-slash, never trailing-slash (except '/'). */
  path: string;
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** 0.0–1.0 relative priority hint. */
  priority: number;
}

/** Marketing/public routes only — auth and app routes are intentionally excluded. */
export function marketingRoutes(): SitemapRoute[] {
  const routes: SitemapRoute[] = [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/pricing', changefreq: 'weekly', priority: 0.9 },
    { path: '/which-valuation', changefreq: 'monthly', priority: 0.7 },
    { path: '/tools/409a-valuation-calculator', changefreq: 'monthly', priority: 0.8 },
    // The three educational pages. High priority because they are the top of
    // the funnel — a founder reads these before they know what to buy.
    { path: '/409a-valuation-guide', changefreq: 'monthly', priority: 0.8 },
    { path: '/when-do-you-need-a-409a', changefreq: 'monthly', priority: 0.7 },
    { path: '/how-much-does-a-409a-cost', changefreq: 'monthly', priority: 0.7 },
    { path: '/sample-report', changefreq: 'monthly', priority: 0.8 },
    { path: '/compare/409a-valuation-providers', changefreq: 'monthly', priority: 0.7 },
    // The blog index only. Individual posts live in the database and are
    // authored after this file is built, so listing them here would either be
    // a stale list or a build that has to reach the database.
    { path: '/blog', changefreq: 'weekly', priority: 0.6 },
    { path: '/about', changefreq: 'monthly', priority: 0.5 },
    { path: '/contact', changefreq: 'monthly', priority: 0.5 },
    { path: '/terms-of-service', changefreq: 'yearly', priority: 0.3 },
    { path: '/privacy-policy', changefreq: 'yearly', priority: 0.3 },
  ];
  for (const product of PRODUCTS) {
    routes.push({ path: `/products/${product.slug}`, changefreq: 'monthly', priority: 0.8 });
  }
  // Stage pages rank for the query a founder actually types ("series b 409a
  // valuation"), so they sit just under the product pages rather than with the
  // long tail.
  for (const stage of FUNDING_STAGES) {
    routes.push({ path: `/409a-valuation/${stage.slug}`, changefreq: 'monthly', priority: 0.7 });
  }
  for (const comparison of COMPARISONS) {
    routes.push({ path: `/compare/${comparison.slug}`, changefreq: 'monthly', priority: 0.6 });
  }
  return routes;
}
