import { buildHeadTags, escapeHtml, renderHeadTags } from './headTags';
import { allPageMeta } from './pageMetaRoutes';
import type { HeadInput } from './headTags';

/**
 * Build-time `<head>` prerendering for the public marketing routes (409.ai §24).
 *
 * The site is a client-rendered SPA, so every `<title>`, description, and Open
 * Graph tag is injected by React after the bundle executes. Search engines cope
 * with that; **social crawlers do not**. Slack, LinkedIn, X, Facebook, WhatsApp
 * and iMessage fetch the raw HTML and never run scripts — so before this, every
 * marketing link shared anywhere rendered as a bare "DoAide 409A · Valuations" with no
 * description and no image. For a site whose primary distribution is founders
 * passing links to each other, that is a silent conversion leak.
 *
 * Rather than adopt SSR for the whole app, we bake the head of each known
 * marketing route into its own static HTML document at build time. The body
 * stays the SPA mount point — crawlers only ever read the head, and browsers
 * hydrate exactly as before. A `<noscript>` block carries the headline and
 * description for the rare text-only client.
 */

/**
 * `<link rel="preload">` tags for the latin font faces.
 *
 * Fonts referenced from a stylesheet are only discovered once that stylesheet
 * has been fetched and parsed, which lands the display face — the one drawing
 * the hero headline, i.e. the LCP element — late enough to cause a visible
 * swap. Preloading pulls the request forward to the initial HTML parse.
 *
 * `crossorigin` is required even for same-origin font preloads: without it the
 * preloaded response is not reused by the CSS-initiated fetch and the file is
 * downloaded twice.
 */
export function fontPreloadTags(assetFileNames: string[]): string {
  const latinFaces = assetFileNames.filter((name) => /latin-wght-normal.*\.woff2$/.test(name)).sort();
  return latinFaces
    .map(
      (name) => `<link rel="preload" href="/${name}" as="font" type="font/woff2" crossorigin="anonymous" />`,
    )
    .join('\n    ');
}

/** Insert preload tags immediately after `<head>` so they parse first. */
export function withFontPreloads(html: string, assetFileNames: string[]): string {
  const preloads = fontPreloadTags(assetFileNames);
  if (!preloads) return html;
  return html.replace(/<head>/i, `<head>\n    ${preloads}`);
}

/**
 * `<link rel="modulepreload">` tags for a route's own chunk and its imports.
 *
 * The shell already modulepreloads what the *entry* statically imports. Every
 * route below the landing page is lazy, so its chunk is invisible to the
 * preload scanner: the browser learns about `PricingPage.js` only after it has
 * fetched and run `index.js`. On a prerendered document — where the HTML is
 * already the finished page — that is a wasted serial round trip in front of
 * the paint. Naming the chunk in the head lets both downloads overlap.
 *
 * `fileNames` is the route chunk followed by the chunks it statically imports;
 * anything the shell already references is skipped, so a chunk is never
 * preloaded twice.
 */
export function routePreloadTags(fileNames: readonly string[], shell: string): string {
  return fileNames
    .filter((name) => !shell.includes(`/${name}`))
    .map((name) => `<link rel="modulepreload" crossorigin href="/${name}" />`)
    .join('\n    ');
}

/** Insert a route's own module preloads immediately after `<head>`. */
export function withRoutePreloads(html: string, fileNames: readonly string[]): string {
  const tags = routePreloadTags(fileNames, html);
  if (!tags) return html;
  return html.replace(/<head>/i, `<head>\n    ${tags}`);
}

/** Where a prerendered route's document is written, relative to the outDir. */
export function outputPathFor(routePath: string): string {
  if (routePath === '/') return 'index.html';
  return `${routePath.replace(/^\/+/, '')}/index.html`;
}

/** Route path → emitted file, consumed by the web service at request time. */
export interface PrerenderManifest {
  /** Map of canonical route path to the file that serves it, e.g. `/pricing`. */
  routes: Record<string, string>;
}

/**
 * Marker comments in index.html delimiting the shell's fallback title and
 * description. Substituting an explicit, uniquely-named block is deliberate:
 * pattern-matching `<title>…</title>` out of the document instead will also
 * match the words inside an HTML comment that happens to mention the tag, and
 * silently swallow the rest of the head.
 */
export const HEAD_FALLBACK_START = '<!--n409:head-fallback-start-->';
export const HEAD_FALLBACK_END = '<!--n409:head-fallback-end-->';

const FALLBACK_BLOCK = new RegExp(`[ \\t]*${HEAD_FALLBACK_START}[\\s\\S]*?${HEAD_FALLBACK_END}`, 'i');

/** Thrown when the shell has been edited such that prerendering can't proceed. */
export class PrerenderError extends Error {}

/**
 * Replace the head/body of the built shell with a route-specific document.
 *
 * `shell` is Vite's emitted `index.html`, already carrying the hashed script and
 * stylesheet tags. The shell's fallback metadata block is swapped for the
 * route's real tags in place, so ordering relative to the asset tags is
 * preserved.
 */
export function renderRouteHtml(shell: string, meta: HeadInput, origin: string): string {
  if (!FALLBACK_BLOCK.test(shell)) {
    // Failing loudly beats emitting pages with no metadata: a silent skip here
    // would ship a site whose every shared link previews as blank.
    throw new PrerenderError(`index.html is missing the ${HEAD_FALLBACK_START} … ${HEAD_FALLBACK_END} block`);
  }
  const head = renderHeadTags(buildHeadTags(meta, origin));
  const html = shell.replace(FALLBACK_BLOCK, `    ${head}`);

  // Text-only fallback. Hidden from browsers the moment scripts run, so it
  // never double-renders, but present for clients that read markup only.
  const noscript =
    `<noscript>` +
    `<h1>${escapeHtml(meta.title)}</h1>` +
    `<p>${escapeHtml(meta.description)}</p>` +
    `</noscript>`;

  return html.replace(/<div id="root"><\/div>/i, `<div id="root"></div>\n    ${noscript}`);
}

/** One prerendered document, ready to be written to the build output. */
export interface PrerenderedPage {
  /** Canonical route path, e.g. `/pricing`. */
  route: string;
  /** Output file path relative to the outDir, e.g. `pricing/index.html`. */
  fileName: string;
  html: string;
}

/** Render every known marketing route against the built shell. */
export function prerenderPages(
  shell: string,
  origin: string,
  pages: HeadInput[] = allPageMeta(),
): PrerenderedPage[] {
  return pages.map((meta) => ({
    route: meta.path,
    fileName: outputPathFor(meta.path),
    html: renderRouteHtml(shell, meta, origin),
  }));
}

/** Build the route → file manifest the web service uses to serve these. */
export function buildManifest(pages: PrerenderedPage[]): PrerenderManifest {
  return {
    routes: Object.fromEntries(pages.map((p) => [p.route, p.fileName])),
  };
}
