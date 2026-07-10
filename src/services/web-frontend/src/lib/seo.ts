import type { Product } from './marketing';

/**
 * SEO configuration and structured-data builders (409.ai §24). The canonical
 * site origin is configurable per environment via `SITE_URL` (surfaced to the
 * client as `import.meta.env.VITE_SITE_URL`); everything else derives from it.
 */

export const SITE_NAME = 'N409';
export const SITE_TAGLINE = 'Independent, defensible 409A and business valuations.';
export const DEFAULT_OG_IMAGE = '/og-image.svg';

const FALLBACK_ORIGIN = 'https://www.n409.ai';

/** Canonical origin with any trailing slash removed. */
export function siteOrigin(
  env: { VITE_SITE_URL?: string } = import.meta.env as { VITE_SITE_URL?: string },
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
