import {
  DEFAULT_OG_IMAGE,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SITE_NAME,
  absoluteUrl,
  pageTitle,
  siteOrigin,
  type JsonLd,
} from './seo';

/**
 * The one place `<head>` content is defined (409.ai §24).
 *
 * Two consumers render from this: the `<Seo>` component at runtime (via
 * react-helmet-async) and the build-time prerenderer that bakes the same tags
 * into each route's static HTML. Social crawlers — Slack, LinkedIn, X, Facebook,
 * WhatsApp, iMessage — do not execute JavaScript, so *only* the baked copy is
 * what a shared link actually shows. Keeping both paths on one builder is what
 * stops the preview a prospect sees from drifting from the page they land on.
 */

export interface HeadInput {
  title: string;
  description: string;
  /** Canonical app path, e.g. `/pricing`. */
  path: string;
  image?: string;
  type?: 'website' | 'product' | 'article';
  jsonLd?: JsonLd | JsonLd[];
  noindex?: boolean;
}

/** A single `<meta>`/`<link>` tag, keyed by whichever attribute identifies it. */
export interface HeadTag {
  tag: 'meta' | 'link';
  /** `name`, `property`, or `rel` — the attribute crawlers match on. */
  key: 'name' | 'property' | 'rel';
  keyValue: string;
  /** `content` for meta, `href` for link. */
  value: string;
}

export interface HeadTags {
  /** Fully composed document title, including the site suffix. */
  title: string;
  tags: HeadTag[];
  jsonLd: JsonLd[];
}

const meta = (key: 'name' | 'property', keyValue: string, value: string): HeadTag => ({
  tag: 'meta',
  key,
  keyValue,
  value,
});

/**
 * Build every head tag for a page. `origin` is explicit so the Node-side
 * prerenderer can resolve canonical/OG URLs without `import.meta.env`.
 */
export function buildHeadTags(input: HeadInput, origin: string = siteOrigin()): HeadTags {
  const url = absoluteUrl(input.path, origin);
  const imageUrl = absoluteUrl(input.image ?? DEFAULT_OG_IMAGE, origin);
  const title = pageTitle(input.title);
  const type = input.type ?? 'website';

  const tags: HeadTag[] = [
    meta('name', 'description', input.description),
    { tag: 'link', key: 'rel', keyValue: 'canonical', value: url },

    // Open Graph. og:image:width/height let crawlers reserve the card slot
    // before they fetch the image, which is what stops LinkedIn and Slack
    // falling back to a thumbnail-sized preview.
    meta('property', 'og:type', type),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:title', title),
    meta('property', 'og:description', input.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', imageUrl),
    meta('property', 'og:image:width', String(OG_IMAGE_WIDTH)),
    meta('property', 'og:image:height', String(OG_IMAGE_HEIGHT)),
    meta('property', 'og:image:alt', input.description),
    meta('property', 'og:locale', 'en_US'),

    // Twitter Card
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', title),
    meta('name', 'twitter:description', input.description),
    meta('name', 'twitter:image', imageUrl),
    meta('name', 'twitter:image:alt', input.description),
  ];

  // Without max-image-preview:large, Google renders a thumbnail rather than the
  // large card in Discover and rich results.
  tags.push(
    meta(
      'name',
      'robots',
      input.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1',
    ),
  );

  const jsonLd = input.jsonLd ? (Array.isArray(input.jsonLd) ? input.jsonLd : [input.jsonLd]) : [];
  return { title, tags, jsonLd };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for interpolation into an HTML attribute or text node. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * Escape a JSON-LD payload for embedding in a `<script>` element. `<` must be
 * escaped so a value containing `</script>` cannot terminate the block early —
 * the standard XSS hole in inline structured data.
 */
export function serializeJsonLd(node: JsonLd): string {
  return JSON.stringify(node).replace(/</g, '\\u003c');
}

/** Render head tags as the HTML string baked into a prerendered document. */
export function renderHeadTags({ title, tags, jsonLd }: HeadTags): string {
  const lines = [`<title>${escapeHtml(title)}</title>`];
  for (const t of tags) {
    const valueAttr = t.tag === 'meta' ? 'content' : 'href';
    lines.push(`<${t.tag} ${t.key}="${escapeHtml(t.keyValue)}" ${valueAttr}="${escapeHtml(t.value)}" />`);
  }
  for (const node of jsonLd) {
    lines.push(`<script type="application/ld+json">${serializeJsonLd(node)}</script>`);
  }
  return lines.join('\n    ');
}
