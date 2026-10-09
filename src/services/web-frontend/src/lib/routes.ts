import { COMPARISONS, FUNDING_STAGES, PARTNER_SEGMENTS, PRODUCTS } from './marketing';

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

const BLOG_SLUGS = [
  'what-is-a-409a-valuation',
  'how-often-do-you-need-a-409a-valuation',
  'why-your-409a-is-lower-than-your-post-money',
  '409a-valuations-explained-for-employees',
  'what-an-irs-409a-audit-asks-for',
  'opm-pwerm-and-the-hybrid-method',
  'dlom-finnerty-chaffe-and-what-auditors-check',
  'the-three-valuation-approaches',
  'liquidation-preferences-and-the-allocation-waterfall',
  'how-safes-and-convertible-notes-affect-your-409a',
  'iso-vs-nso-how-stock-options-are-taxed',
  'the-83b-election-explained',
  'section-83i-qualified-equity-grant-deferral',
  'qsbs-section-1202-what-founders-need-to-know',
  'section-1244-ordinary-loss-on-failed-startup-stock',
  'rule-701-and-equity-compensation-disclosure',
  'down-rounds-underwater-options-and-repricing',
  'double-trigger-rsus-and-the-ipo-tax-bill',
  'profits-interests-and-the-llc-hurdle',
  'tender-offers-secondary-sales-and-your-409a',
  'asc-718-stock-based-compensation-for-startups',
  'ifrs-2-vs-asc-718',
  'asc-820-level-3-fair-value-for-fund-portfolios',
  'asc-805-purchase-price-allocation',
  'goodwill-impairment-for-private-companies',
  'emi-share-options-uk-hmrc-valuation',
  'csop-share-options-uk-hmrc-valuation',
  'esop-valuation-and-adequate-consideration',
  'cheap-stock-and-the-pre-ipo-409a',
  'inside-the-409a-valuation-process',
  'post-money-and-pre-money-safes-the-conversion-arithmetic',
  'caps-discounts-and-accrued-interest-how-a-note-converts',
  'the-option-pool-shuffle',
  'bridge-rounds-and-the-valuation-in-between',
  'structured-rounds-and-the-price-behind-the-headline',
  'founder-secondaries-and-what-they-do-to-your-409a',
  'pay-to-play-recapitalizations-and-the-common-stock',
  'venture-debt-warrants-and-how-they-are-valued',
  'ipo-readiness-the-valuation-work-that-starts-early',
  'secondary-market-prices-and-what-a-409a-does-with-them',
  'qsbs-stacking-packing-and-non-grantor-trusts',
  'qsbs-the-active-business-and-asset-tests-in-detail',
  'qsbs-redemptions-and-how-eligibility-is-quietly-lost',
  '409a-valuations-for-non-us-companies-with-us-employees',
  'hmrc-share-and-assets-valuation-how-agreement-works',
  'canadian-employee-stock-options-and-fair-market-value',
  'what-a-409a-valuation-actually-defends',
  'indian-esop-valuations-and-the-merchant-banker-requirement',
  'israeli-section-102-options-and-the-trustee-route',
  'what-a-valuation-provider-needs-from-your-cap-table',
  'board-approval-and-the-409a-paper-trail',
];

/** Marketing/public routes only — auth and app routes are intentionally excluded. */
export function marketingRoutes(): SitemapRoute[] {
  const routes: SitemapRoute[] = [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/pricing', changefreq: 'weekly', priority: 0.9 },
    { path: '/which-valuation', changefreq: 'monthly', priority: 0.7 },
    { path: '/tools/409a-valuation-calculator', changefreq: 'monthly', priority: 0.8 },
    { path: '/tools/stock-option-tax-calculator', changefreq: 'monthly', priority: 0.8 },
    { path: '/tools/409a-compliance-checker', changefreq: 'monthly', priority: 0.8 },
    { path: '/tools/startup-valuation-estimator', changefreq: 'monthly', priority: 0.8 },
    { path: '/tools/readiness-checker', changefreq: 'monthly', priority: 0.8 },
    { path: '/tools/deadline-widget', changefreq: 'monthly', priority: 0.7 },
    { path: '/tools/cost-comparison', changefreq: 'monthly', priority: 0.8 },
    { path: '/referral', changefreq: 'monthly', priority: 0.8 },
    { path: '/free-tools', changefreq: 'monthly', priority: 0.8 },
    { path: '/resources', changefreq: 'weekly', priority: 0.7 },
    // The three educational pages. High priority because they are the top of
    // the funnel — a founder reads these before they know what to buy.
    { path: '/409a-valuation-guide', changefreq: 'monthly', priority: 0.8 },
    { path: '/409a-valuation-methods', changefreq: 'monthly', priority: 0.7 },
    { path: '/409a-valuation-cost-comparison', changefreq: 'monthly', priority: 0.7 },
    { path: '/when-do-you-need-a-409a', changefreq: 'monthly', priority: 0.7 },
    { path: '/how-much-does-a-409a-cost', changefreq: 'monthly', priority: 0.7 },
    { path: '/sample-report', changefreq: 'monthly', priority: 0.8 },
    { path: '/compare/409a-valuation-providers', changefreq: 'monthly', priority: 0.7 },
    // The partner channel is a second acquisition funnel, not a footnote: one
    // cap-table platform is worth a lot of individual signups.
    { path: '/partners', changefreq: 'monthly', priority: 0.8 },
    { path: '/developers', changefreq: 'monthly', priority: 0.7 },
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
  for (const segment of PARTNER_SEGMENTS) {
    routes.push({ path: `/partners/${segment.slug}`, changefreq: 'monthly', priority: 0.6 });
  }
  for (const comparison of COMPARISONS) {
    routes.push({ path: `/compare/${comparison.slug}`, changefreq: 'monthly', priority: 0.6 });
  }
  for (const slug of BLOG_SLUGS) {
    routes.push({ path: `/blog/${slug}`, changefreq: 'monthly', priority: 0.6 });
  }
  return routes;
}
