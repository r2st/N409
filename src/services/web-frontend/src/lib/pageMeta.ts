import {
  MIN_PRODUCT_PRICE_CENTS,
  PARTNER_FAQ,
  PRICING_FAQ,
  PRODUCTS,
  VALUATION_TRIGGERS,
  formatUsd,
  productBySlug,
} from './marketing';
import { SITE_TAGLINE, faqJsonLd, organizationJsonLd } from './seo';
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
export const HOME_CRUMB = { name: 'Home', path: '/' };

/**
 * The comparison hub. It is a real page that links to every individual
 * comparison, so it is the genuine crawlable parent of `/compare/:slug` — worth
 * naming once here rather than duplicating the title in two places.
 */
export const COMPARE_HUB_PATH = '/compare/409a-valuation-providers';
export const COMPARE_HUB_TITLE = '409A valuation providers compared';

/**
 * The 409A's own list price, for the cost page's description.
 *
 * Not `MIN_PRODUCT_PRICE_CENTS` — that is the cheapest product across the whole
 * catalogue, and a page titled "how much does a 409A cost" answering with the
 * SMB price would be wrong in the search result itself. Derived rather than
 * written so it tracks the product registry.
 */
const NINE_A_PRICE_CENTS = productBySlug('409a-valuation')!.priceCents;

/** Static (non-parameterised) marketing routes. */
export function staticPages(): HeadInput[] {
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
      path: '/409a-valuation-guide',
      title: 'The 409A valuation guide',
      description:
        'What a 409A valuation is, why the IRS safe harbor matters more than the number itself, how the value is derived across the market, income and asset approaches, and what a defensible report shows.',
    },
    {
      path: '/when-do-you-need-a-409a',
      title: 'When do you need a 409A valuation?',
      description:
        'Four events require a 409A valuation: the first option grant, the 12-month expiry, a priced round, and any other material event — plus what a discounted strike price costs the option holder.',
      // The trigger list is a genuine question-and-answer pair per entry, which
      // is what `faqJsonLd` is for — the timing question is the one that gets
      // asked as a question, so it is the one worth marking up.
      jsonLd: faqJsonLd(VALUATION_TRIGGERS.map((t) => ({ q: t.title, a: t.body }))),
    },
    {
      path: '/how-much-does-a-409a-cost',
      title: 'How much does a 409A valuation cost?',
      description: `What a 409A valuation costs and what drives the price — market bands from bundled cap-table platforms to advisory firms, N409 from ${formatUsd(NINE_A_PRICE_CENTS)}, and the audit-support rate that is not on the quote.`,
    },
    {
      path: '/tools/409a-valuation-calculator',
      title: '409A valuation calculator',
      description:
        'Free 409A valuation calculator — estimate a range for your common stock from a priced round, capital raised, revenue or profit. No signup, no email required.',
    },
    {
      path: '/sample-report',
      title: 'Sample 409A valuation report',
      description:
        'See what a defensible 409A valuation report contains — every chapter of the deliverable and the exhibits behind each figure, prepared for IRS safe-harbor reliance.',
    },
    {
      path: COMPARE_HUB_PATH,
      title: COMPARE_HUB_TITLE,
      description:
        'The five kinds of 409A valuation provider — AI-native platforms, cap-table products, bundled providers, startup CPAs and independent firms — and what founders should ask before choosing one.',
    },
    {
      path: '/partners',
      title: 'Partner programme',
      description:
        'Refer valuation clients, deliver them under your own brand on your own subdomain, or submit them over an API with signed webhooks — analyst-reviewed and dual-signed either way.',
      jsonLd: faqJsonLd(PARTNER_FAQ),
    },
    {
      path: '/developers',
      title: 'Partner API for developers',
      description:
        'The N409 partner API: bearer keys, idempotent submission, an OpenAPI 3.1 document you can generate a client from, and HMAC-signed webhooks on state changes and report-ready.',
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
 * Look up a **statically described** page's metadata by canonical path.
 *
 * The four slug-driven families are deliberately not searched here. Each of
 * those pages already knows its own slug and calls its own builder in
 * `pageMetaRoutes.ts`; routing them through this lookup instead meant every
 * caller — including the landing page, on the critical path — built the
 * metadata for all forty-seven published routes and threw forty-six away.
 * `allPageMeta()` is still the union, for the prerenderer and the sitemap.
 *
 * Returns undefined for an unknown path, and for a slug-driven one.
 */
export function pageMeta(path: string): HeadInput | undefined {
  return staticPages().find((p) => p.path === path);
}
