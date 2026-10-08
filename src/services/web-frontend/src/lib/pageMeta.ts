import {
  LANDING_FAQ,
  MIN_PRODUCT_PRICE_CENTS,
  PARTNER_FAQ,
  PRICING_FAQ,
  PRODUCTS,
  VALUATION_TRIGGERS,
  formatUsd,
  productBySlug,
} from './marketing';
import {
  SITE_TAGLINE,
  breadcrumbJsonLd,
  faqJsonLd,
  organizationJsonLd,
  serviceJsonLd,
  webApplicationJsonLd,
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
      title: 'DoAide 409A',
      description: `${SITE_TAGLINE} AI-assisted intake, a transparent valuation engine, and analyst-signed reports across ${PRODUCTS.length} report types — first draft in 24 hours, from ${formatUsd(MIN_PRODUCT_PRICE_CENTS)}.`,
      jsonLd: [organizationJsonLd(), webApplicationJsonLd(), serviceJsonLd(), faqJsonLd(LANDING_FAQ)],
    },
    {
      path: '/pricing',
      title: 'Pricing',
      description: `Transparent, per-report valuation pricing — one flat price, no subscriptions. 409A from ${formatUsd(MIN_PRODUCT_PRICE_CENTS)} with a 24-hour first draft and Express delivery available.`,
      jsonLd: [
        faqJsonLd(PRICING_FAQ),
        breadcrumbJsonLd([HOME_CRUMB, { name: 'Pricing', path: '/pricing' }]),
      ],
    },
    {
      path: '/which-valuation',
      title: 'Which valuation do you need?',
      description:
        "Answer a couple of quick questions and we'll point you at the right valuation report for your situation.",
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'Which Valuation', path: '/which-valuation' }]),
    },
    {
      path: '/409a-valuation-guide',
      title: 'The 409A valuation guide',
      description:
        'What a 409A valuation is, why the IRS safe harbor matters more than the number itself, how the value is derived across the market, income and asset approaches, and what a defensible report shows.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: '409A Valuation Guide', path: '/409a-valuation-guide' },
      ]),
    },
    {
      path: '/when-do-you-need-a-409a',
      title: 'When do you need a 409A valuation?',
      description:
        'Four events require a 409A valuation: the first option grant, the 12-month expiry, a priced round, and any other material event — plus what a discounted strike price costs the option holder.',
      jsonLd: [
        faqJsonLd(VALUATION_TRIGGERS.map((t) => ({ q: t.title, a: t.body }))),
        breadcrumbJsonLd([
          HOME_CRUMB,
          { name: 'Resources', path: '/resources' },
          { name: 'When Do You Need a 409A', path: '/when-do-you-need-a-409a' },
        ]),
      ],
    },
    {
      path: '/409a-valuation-methods',
      title: '409A valuation methods explained: market, income, asset approach',
      description:
        'The three valuation approaches used in a 409A — market (comparable companies), income (discounted cash flow), and asset (net asset value) — how they are applied, weighted, and reconciled into a defensible fair market value.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: '409A Valuation Methods', path: '/409a-valuation-methods' },
      ]),
    },
    {
      path: '/409a-valuation-cost-comparison',
      title: '409A valuation cost comparison: Big 4 vs boutique vs automated',
      description:
        'How much a 409A valuation costs across provider types — Big 4 firms ($10K–$30K+), boutiques ($3K–$10K), cap-table add-ons, and AI-native platforms (from $49) — and what drives the real cost including audit support.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: '409A Cost Comparison', path: '/409a-valuation-cost-comparison' },
      ]),
    },
    {
      path: '/how-much-does-a-409a-cost',
      title: 'How much does a 409A valuation cost?',
      description: `What a 409A valuation costs and what drives the price — market bands from bundled cap-table platforms to advisory firms, DoAide 409A from ${formatUsd(NINE_A_PRICE_CENTS)}, and the audit-support rate that is not on the quote.`,
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: 'How Much Does a 409A Cost', path: '/how-much-does-a-409a-cost' },
      ]),
    },
    {
      path: '/tools/409a-valuation-calculator',
      title: '409A valuation calculator',
      description:
        'Free 409A valuation calculator — estimate a range for your common stock from a priced round, capital raised, revenue or profit. No signup, no email required.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: '409A Calculator', path: '/tools/409a-valuation-calculator' },
      ]),
    },
    {
      path: '/tools/stock-option-tax-calculator',
      title: 'Stock option tax calculator',
      description:
        'Free stock option tax calculator — estimate tax implications of exercising ISOs and NSOs, AMT exposure, and cost basis. No signup required.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: 'Stock Option Tax Calculator', path: '/tools/stock-option-tax-calculator' },
      ]),
    },
    {
      path: '/tools/409a-compliance-checker',
      title: '409A compliance checker',
      description:
        'Free 409A compliance checker — answer five questions to check whether your 409A valuation is current and meets IRS safe harbor requirements. Instant results.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: '409A Compliance Checker', path: '/tools/409a-compliance-checker' },
      ]),
    },
    {
      path: '/tools/startup-valuation-estimator',
      title: 'Startup valuation estimator — how much is my startup worth?',
      description:
        'Free startup valuation estimator — enter revenue, growth rate, industry, and funding stage to estimate your company\'s fair market value and 409A common stock range. No signup required.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Resources', path: '/resources' },
        { name: 'Startup Valuation Estimator', path: '/tools/startup-valuation-estimator' },
      ]),
    },
    {
      path: '/free-tools',
      title: 'Free 409A tools for startups',
      description:
        'Free 409A valuation tools — calculator, safe harbor compliance checker, startup valuation estimator, and stock option tax calculator. No signup, no email required.',
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'Free Tools', path: '/free-tools' }]),
    },
    {
      path: '/resources',
      title: '409A resources & tools',
      description:
        'Free 409A tools, guides, and educational resources — valuation calculator, stock option tax calculator, compliance checker, and expert guides on 409A valuations.',
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'Resources', path: '/resources' }]),
    },
    {
      path: '/sample-report',
      title: 'Sample 409A valuation report',
      description:
        'See what a defensible 409A valuation report contains — every chapter of the deliverable and the exhibits behind each figure, prepared for IRS safe-harbor reliance.',
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'Sample Report', path: '/sample-report' }]),
    },
    {
      path: COMPARE_HUB_PATH,
      title: COMPARE_HUB_TITLE,
      description:
        'The five kinds of 409A valuation provider — AI-native platforms, cap-table products, bundled providers, startup CPAs and independent firms — and what founders should ask before choosing one.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Compare', path: COMPARE_HUB_PATH },
      ]),
    },
    {
      path: '/partners',
      title: 'Partner programme',
      description:
        'Refer valuation clients, deliver them under your own brand on your own subdomain, or submit them over an API with signed webhooks — analyst-reviewed and dual-signed either way.',
      jsonLd: [
        faqJsonLd(PARTNER_FAQ),
        breadcrumbJsonLd([HOME_CRUMB, { name: 'Partners', path: '/partners' }]),
      ],
    },
    {
      path: '/developers',
      title: 'Partner API for developers',
      description:
        'The DoAide 409A partner API: bearer keys, idempotent submission, an OpenAPI 3.1 document you can generate a client from, and HMAC-signed webhooks on state changes and report-ready.',
      jsonLd: breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Partners', path: '/partners' },
        { name: 'Developers', path: '/developers' },
      ]),
    },
    {
      path: '/blog',
      title: 'Blog',
      description:
        'Notes on 409A and fair-value practice from the DoAide 409A team — methodology, audit defensibility, and what actually changes when valuation work is automated.',
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'Blog', path: '/blog' }]),
    },
    {
      path: '/about',
      title: 'About DoAide 409A',
      description:
        'DoAide 409A is an AI-assisted valuation platform producing independent, defensible 409A and business valuations — AI intake, a transparent engine, and credentialed analyst sign-off.',
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'About', path: '/about' }]),
    },
    {
      path: '/contact',
      title: 'Contact us',
      description:
        'Get in touch with the DoAide 409A team — questions about a valuation, pricing, partnerships, or support.',
      jsonLd: breadcrumbJsonLd([HOME_CRUMB, { name: 'Contact', path: '/contact' }]),
    },
    {
      path: '/terms-of-service',
      title: 'Terms of service',
      description: 'The terms governing your use of the DoAide 409A valuation platform.',
    },
    {
      path: '/privacy-policy',
      title: 'Privacy policy',
      description: 'How DoAide 409A collects, uses, and protects your data, including cookies and analytics.',
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
