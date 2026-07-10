import { Helmet } from 'react-helmet-async';
import {
  DEFAULT_OG_IMAGE,
  SITE_NAME,
  absoluteUrl,
  pageTitle,
  type JsonLd,
} from '../lib/seo';

export interface SeoProps {
  /** Page title (without the site suffix). */
  title: string;
  /** Meta description / OG + Twitter description. */
  description: string;
  /** Canonical app path, e.g. `/pricing`. Defaults to the current pathname. */
  path?: string;
  /** OG/Twitter image (app path or absolute URL). */
  image?: string;
  /** OG type — `website` for most pages, `product` for product pages. */
  type?: 'website' | 'product' | 'article';
  /** One or more JSON-LD structured-data nodes. */
  jsonLd?: JsonLd | JsonLd[];
  /** Emit `robots: noindex` (e.g. thin/utility pages). */
  noindex?: boolean;
}

/**
 * Per-page head management (409.ai §24): title, meta description, canonical,
 * Open Graph, Twitter Card, and optional JSON-LD. Client-side via
 * react-helmet-async — the SPA has no SSR, so tags are applied on mount.
 */
export function Seo({
  title,
  description,
  path,
  image,
  type = 'website',
  jsonLd,
  noindex,
}: SeoProps): React.JSX.Element {
  const canonicalPath =
    path ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const url = absoluteUrl(canonicalPath);
  const imageUrl = absoluteUrl(image ?? DEFAULT_OG_IMAGE);
  const fullTitle = pageTitle(title);
  const nodes = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      {noindex && <meta name="robots" content="noindex,nofollow" />}

      {/* Open Graph */}
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={imageUrl} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={imageUrl} />

      {nodes.map((node, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(node)}
        </script>
      ))}
    </Helmet>
  );
}
