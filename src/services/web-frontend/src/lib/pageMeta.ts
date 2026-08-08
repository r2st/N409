import {
  COMPARISONS,
  MIN_PRODUCT_PRICE_CENTS,
  PRICING_FAQ,
  PRODUCTS,
  comparisonBySlug,
  formatUsd,
  productBySlug,
} from './marketing';
import {
  SITE_TAGLINE,
  breadcrumbJsonLd,
  faqJsonLd,
  organizationJsonLd,
  productJsonLd,
  websiteJsonLd,
} from './seo';
import type { HeadInput } from './headTags';

/**
 * Per-route `<head>` metadata for every public marketing URL (409.ai §24).
 *
 * This registry is the single source for both renderers: marketing pages spread
 * it into `<Seo>` at runtime, and the build-time prerenderer walks it to bake
 * the same tags into static HTML. Defining a page's title and description in
 * one place is what guarantees the Slack/LinkedIn preview matches the page.
 *
 * Pure data — no browser or `import.meta` access — so the Vite config can
 * import it directly.
 */

/** Breadcrumb root. Every trail starts at the homepage. */
const HOME_CRUMB = { name: 'Home', path: '/' };

/**
 * The comparison hub. It is a real page that links to every individual
 * comparison, so it is the genuine crawlable parent of `/compare/:slug` — worth
 * naming once here rather than duplicating the title in two places.
 */
const COMPARE_HUB_PATH = '/compare/409a-valuation-providers';
const COMPARE_HUB_TITLE = '409A valuation providers compared';

/** Static (non-parameterised) marketing routes. */
function staticPages(): HeadInput[] {
  return [
    {
      path: '/',
      title: 'N409',
      description: `${SITE_TAGLINE} AI-assisted intake, a transparent valuation engine, and analyst-signed reports across ${PRODUCTS.length} report types — first draft in 24 hours, from ${formatUsd(MIN_PRODUCT_PRICE_CENTS)}.`,
      jsonLd: organizationJsonLd(),
    },
    {
      path: '/pricing',
      title: 'Pricing',
      description: `Transparent, per-report valuation pricing — one flat price, no subscriptions. 409A from ${formatUsd(MIN_PRODUCT_PRICE_CENTS)} with a 24-hour first draft and Express delivery available.`,
      jsonLd: faqJsonLd(PRICING_FAQ),
    },
    {
      path: '/which-valuation',
      title: 'Which valuation do you need?',
      description:
        "Answer a couple of quick questions and we'll point you at the right valuation report for your situation.",
    },
    {
      path: COMPARE_HUB_PATH,
      title: COMPARE_HUB_TITLE,
      description:
        'The five kinds of 409A valuation provider — AI-native platforms, cap-table products, bundled providers, startup CPAs and independent firms — and what founders should ask before choosing one.',
    },
    {
      path: '/blog',
      title: 'Blog',
      description:
        'Notes on 409A and fair-value practice from the N409 team — methodology, audit defensibility, and what actually changes when valuation work is automated.',
    },
    {
      path: '/about',
      title: 'About N409',
      description:
        'N409 is an AI-assisted valuation platform producing independent, defensible 409A and business valuations — AI intake, a transparent engine, and credentialed analyst sign-off.',
    },
    {
      path: '/contact',
      title: 'Contact us',
      description:
        'Get in touch with the N409 team — questions about a valuation, pricing, partnerships, or support.',
    },
    {
      path: '/terms-of-service',
      title: 'Terms of service',
      description: 'The terms governing your use of the N409 valuation platform.',
    },
    {
      path: '/privacy-policy',
      title: 'Privacy policy',
      description: 'How N409 collects, uses, and protects your data, including cookies and analytics.',
    },
  ];
}

/**
 * Metadata for a single product landing page.
 *
 * Three nodes: Product (the offer), BreadcrumbList (so a result reads
 * `n409.ai › 409A Valuation` instead of a raw path) and WebSite (so the result
 * is attributed to the brand). There is no `/products` index page, so the trail
 * is Home → product — inventing an intermediate crumb would point crawlers at a
 * URL that 404s.
 */
export function productPageMeta(slug: string): HeadInput | undefined {
  const product = productBySlug(slug);
  if (!product) return undefined;
  const path = `/products/${product.slug}`;
  return {
    path,
    title: product.name,
    description: product.description,
    type: 'product',
    jsonLd: [
      productJsonLd(product),
      breadcrumbJsonLd([HOME_CRUMB, { name: product.name, path }]),
      websiteJsonLd(),
    ],
  };
}

/**
 * Metadata for a single competitor comparison page. The hub at
 * COMPARE_HUB_PATH links to every one of these, so it is a real parent and the
 * breadcrumb is a three-step trail.
 */
export function comparePageMeta(slug: string): HeadInput | undefined {
  const comparison = comparisonBySlug(slug);
  if (!comparison) return undefined;
  const path = `/compare/${comparison.slug}`;
  const title = `N409 vs ${comparison.competitor}`;
  return {
    path,
    title,
    description: comparison.summary,
    jsonLd: [
      breadcrumbJsonLd([
        HOME_CRUMB,
        { name: COMPARE_HUB_TITLE, path: COMPARE_HUB_PATH },
        { name: title, path },
      ]),
      websiteJsonLd(),
    ],
  };
}

/** Every prerenderable marketing page, in sitemap order. */
export function allPageMeta(): HeadInput[] {
  return [
    ...staticPages(),
    ...PRODUCTS.map((p) => productPageMeta(p.slug)!),
    ...COMPARISONS.map((c) => comparePageMeta(c.slug)!),
  ];
}

/** Look up metadata by canonical path. Returns undefined for unknown routes. */
export function pageMeta(path: string): HeadInput | undefined {
  return allPageMeta().find((p) => p.path === path);
}
