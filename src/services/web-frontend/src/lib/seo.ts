import type { Product } from './marketing';

/**
 * SEO configuration and structured-data builders (409.ai §24). The canonical
 * site origin is configurable per environment via `SITE_URL` (surfaced to the
 * client as `import.meta.env.VITE_SITE_URL`); everything else derives from it.
 */

export const SITE_NAME = 'N409';
export const SITE_TAGLINE = 'Independent, defensible 409A and business valuations.';

/**
 * Social preview image. This must be a raster format: Facebook, LinkedIn, X and
 * Slack all refuse `image/svg+xml` for `og:image`, so pointing at the SVG meant
 * every shared link rendered with no image at all. `og-image.svg` is kept as the
 * editable source and rasterised to this PNG (see public/README.md).
 */
export const DEFAULT_OG_IMAGE = '/og-image.png';
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

const FALLBACK_ORIGIN = 'https://409.doaide.com';

/**
 * Canonical origin with any trailing slash removed.
 *
 * The default reads `import.meta.env` defensively: this module is also imported
 * by the Node-side build plugin that prerenders each route's `<head>`, where
 * `import.meta.env` does not exist. Callers there pass the origin explicitly,
 * but the `?? {}` keeps an accidental bare call from throwing at build time.
 */
export function siteOrigin(
  env: { VITE_SITE_URL?: string } = (import.meta as { env?: { VITE_SITE_URL?: string } }).env ?? {},
): string {
  const raw = (env.VITE_SITE_URL ?? '').trim() || FALLBACK_ORIGIN;
  return raw.replace(/\/+$/, '');
}

/** Turn an app path (or already-absolute URL) into an absolute canonical URL. */
export function absoluteUrl(pathOrUrl: string, origin: string = siteOrigin()): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return path === '/' ? `${origin}/` : `${origin}${path}`;
}

/** Compose a `<title>`: `Page · N409`, collapsing when the page IS the brand. */
export function pageTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed === SITE_NAME) return `${SITE_NAME} · Valuations`;
  return `${trimmed} · ${SITE_NAME}`;
}

// ── Structured data (JSON-LD) ─────────────────────────────────────────────────

/** `Record<string, unknown>`-typed JSON-LD node; avoids `any` while staying open. */
export type JsonLd = Record<string, unknown>;

/** Organization schema for the homepage. */
export function organizationJsonLd(origin: string = siteOrigin()): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: `${origin}/`,
    logo: `${origin}${DEFAULT_OG_IMAGE}`,
    description: SITE_TAGLINE,
  };
}

/** Product schema for a product landing page, priced in USD. */
export function productJsonLd(product: Product, origin: string = siteOrigin()): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    category: product.short,
    brand: { '@type': 'Brand', name: SITE_NAME },
    url: `${origin}/products/${product.slug}`,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      price: (product.priceCents / 100).toFixed(2),
      availability: 'https://schema.org/InStock',
      url: `${origin}/products/${product.slug}`,
    },
  };
}

/**
 * WebSite schema. Names the site itself rather than the page, which is what lets
 * a search engine attribute a result to the brand instead of a bare hostname.
 *
 * No `potentialAction`/SearchAction: there is no public site search to point one
 * at, and declaring an endpoint that doesn't exist is worse than declaring none.
 */
export function websiteJsonLd(origin: string = siteOrigin()): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: `${origin}/`,
    description: SITE_TAGLINE,
    inLanguage: 'en-US',
    publisher: { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
  };
}

/** One step in a breadcrumb trail. `path` must be a page that really exists. */
export interface Crumb {
  name: string;
  path: string;
}

/**
 * BreadcrumbList schema. Google renders this in place of the raw URL in a
 * result, so a deep page reads `409.doaide.com › Compare › N409 vs Carta` rather than
 * the full path — and the trail must mirror real, crawlable ancestors, not an
 * invented hierarchy.
 */
export function breadcrumbJsonLd(crumbs: Crumb[], origin: string = siteOrigin()): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path, origin),
    })),
  };
}

export interface FaqItem {
  q: string;
  a: string;
}

/** FAQPage schema for the pricing page (and any FAQ block). */
export function faqJsonLd(items: FaqItem[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** A blog post, as much of it as a search result needs (design §16.2). */
export interface ArticleSeo {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  published_at: string | null;
  og_image?: string | null;
}

/**
 * BlogPosting schema.
 *
 * `datePublished` is the post's own date rather than the row's `created_at`,
 * for the reason 0122 gives: a post written on Tuesday and published on Friday
 * is a Friday post, and a search result that dates it to the draft is wrong in
 * the one field a reader uses to judge whether an article is current.
 *
 * The author falls back to the organisation rather than being omitted. An
 * article with no author at all reads as unattributed, which is the opposite
 * of what a valuation firm's writing should look like.
 */
export function articleJsonLd(post: ArticleSeo, origin: string = siteOrigin()): JsonLd {
  const url = absoluteUrl(`/blog/${post.slug}`, origin);
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    ...(post.published_at ? { datePublished: post.published_at } : {}),
    author: post.author
      ? { '@type': 'Person', name: post.author }
      : { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
    publisher: { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
    ...(post.og_image ? { image: absoluteUrl(post.og_image, origin) } : {}),
  };
}
