import {
  COMPARISONS,
  FUNDING_STAGES,
  PARTNER_SEGMENTS,
  PRODUCTS,
  formatUsd,
  productBySlug,
} from './marketing';
import {
  comparisonBySlug,
  fundingStageBySlug,
  partnerSegmentBySlug,
  stagePriceRangeCents,
} from './marketingContent';
import { breadcrumbJsonLd, faqJsonLd, productJsonLd, websiteJsonLd } from './seo';
import { COMPARE_HUB_PATH, COMPARE_HUB_TITLE, HOME_CRUMB, staticPages } from './pageMeta';
import type { HeadInput } from './headTags';

/**
 * `<head>` metadata for the four slug-driven marketing page families —
 * `/products/:slug`, `/409a-valuation/:stage`, `/partners/:segment` and
 * `/compare/:slug`.
 *
 * Split out of `pageMeta.ts` for the same reason `marketingContent.ts` was
 * split out of `marketing.ts`, and it is the half that made that split pay.
 * `pageMeta(path)` used to be `allPageMeta().find(...)`, so the landing page
 * asking for its own title reached every builder below, and through them every
 * comparison table and stage write-up — all of it in the entry chunk, and all
 * of it constructed on each render to return one of forty-seven records.
 *
 * Nothing eager imports this module: each of the four page components asks for
 * its own metadata, and `allPageMeta()` is build-time only (the prerenderer and
 * the sitemap). `test/pageMeta.test.ts` still checks the union covers every
 * published route.
 */

/**
 * Metadata for a single product landing page.
 *
 * Three nodes: Product (the offer), BreadcrumbList (so a result reads
 * `409.doaide.com › 409A Valuation` instead of a raw path) and WebSite (so the result
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
 * Metadata for a funding-stage landing page.
 *
 * The parent crumb is the 409A product page, which links to every stage — the
 * trail a search result reads is `409.doaide.com › 409A Valuation › Series B`. The
 * stage FAQ is marked up because those questions are the reason the page ranks;
 * the price in the description is derived so it cannot drift from checkout.
 */
export function stagePageMeta(slug: string): HeadInput | undefined {
  const stage = fundingStageBySlug(slug);
  if (!stage) return undefined;
  const path = `/409a-valuation/${stage.slug}`;
  const { fromCents, toCents } = stagePriceRangeCents(stage);
  const price =
    fromCents === toCents ? formatUsd(fromCents) : `${formatUsd(fromCents)}–${formatUsd(toCents)}`;
  const product = productBySlug('409a-valuation')!;
  return {
    path,
    title: `${stage.name} 409A valuation`,
    description: `${stage.searchBlurb} Typically ${price}, drafted in 24 hours.`,
    jsonLd: [
      faqJsonLd(stage.faq),
      breadcrumbJsonLd([
        HOME_CRUMB,
        { name: product.name, path: `/products/${product.slug}` },
        { name: `${stage.name} 409A valuation`, path },
      ]),
      websiteJsonLd(),
    ],
  };
}

/**
 * Metadata for a partner-segment page. `/partners` links to all four, so it is
 * the real parent of the trail.
 */
export function partnerSegmentPageMeta(slug: string): HeadInput | undefined {
  const segment = partnerSegmentBySlug(slug);
  if (!segment) return undefined;
  const path = `/partners/${segment.slug}`;
  return {
    path,
    title: `Partner with DoAide 409A — ${segment.name}`,
    description: segment.searchBlurb,
    jsonLd: [
      faqJsonLd(segment.faq),
      breadcrumbJsonLd([
        HOME_CRUMB,
        { name: 'Partner programme', path: '/partners' },
        { name: segment.name, path },
      ]),
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
  const title = `DoAide 409A vs ${comparison.competitor}`;
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
    ...FUNDING_STAGES.map((s) => stagePageMeta(s.slug)!),
    ...PARTNER_SEGMENTS.map((s) => partnerSegmentPageMeta(s.slug)!),
    ...COMPARISONS.map((c) => comparePageMeta(c.slug)!),
  ];
}

/**
 * Look up any published page's metadata by canonical path — static or
 * slug-driven.
 *
 * This is what `pageMeta` in `pageMeta.ts` used to be, and it is kept for the
 * callers that genuinely have a path and no idea which family it belongs to:
 * the prerenderer, the sitemap check, and the tests that assert a route is
 * described *somewhere*. A page component should not use it — it knows its own
 * family, and reaching this function from one would put every other family's
 * content back on that page's critical path.
 */
export function anyPageMeta(path: string): HeadInput | undefined {
  return allPageMeta().find((p) => p.path === path);
}
