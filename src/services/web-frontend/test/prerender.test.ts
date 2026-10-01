import { describe, expect, it } from 'vitest';
import {
  HEAD_FALLBACK_END,
  HEAD_FALLBACK_START,
  PrerenderError,
  buildManifest,
  fontPreloadTags,
  outputPathFor,
  prerenderPages,
  renderRouteHtml,
  withFontPreloads,
} from '../src/lib/prerender';
import { pageMeta } from '../src/lib/pageMeta';
import { allPageMeta } from '../src/lib/pageMetaRoutes';
import { marketingRoutes } from '../src/lib/routes';

const ORIGIN = 'https://x.io';

/** A stand-in for Vite's emitted index.html, with hashed asset tags. */
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- A comment that mentions <title> and <meta name="description"> on purpose. -->
    ${HEAD_FALLBACK_START}
    <title>DoAide 409A · Valuations</title>
    <meta name="description" content="shell fallback" />
    ${HEAD_FALLBACK_END}
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

describe('renderRouteHtml', () => {
  const meta = pageMeta('/pricing')!;

  it('replaces the fallback block with the route metadata', () => {
    const html = renderRouteHtml(SHELL, meta, ORIGIN);
    expect(html).toContain('<title>Pricing · DoAide 409A</title>');
    expect(html).not.toContain('shell fallback');
    expect(html).not.toContain(HEAD_FALLBACK_START);
    expect(html).toContain('<link rel="canonical" href="https://x.io/pricing" />');
    expect(html).toContain('<meta property="og:url" content="https://x.io/pricing" />');
  });

  it('leaves exactly one title and one description', () => {
    // Counted outside comments — the shell deliberately mentions both tags in
    // prose, and that text is not markup.
    const markup = renderRouteHtml(SHELL, meta, ORIGIN).replace(/<!--[\s\S]*?-->/g, '');
    expect(markup.match(/<title>/g)).toHaveLength(1);
    expect(markup.match(/<meta name="description"/g)).toHaveLength(1);
  });

  it('does not disturb a comment that happens to mention head tags', () => {
    // Matching on `<title>` text instead of the sentinels used to swallow the
    // rest of the head, leaving an unterminated comment around the asset tags.
    const html = renderRouteHtml(SHELL, meta, ORIGIN);
    expect(html).toContain('A comment that mentions <title>');
    expect(html.match(/<!--/g)).toHaveLength(html.match(/-->/g)!.length);
  });

  it('preserves the hashed script and stylesheet references', () => {
    const html = renderRouteHtml(SHELL, meta, ORIGIN);
    expect(html).toContain('/assets/index-abc123.js');
    expect(html).toContain('/assets/index-def456.css');
    expect(html).toContain('<div id="root"></div>');
  });

  it('adds a noscript fallback carrying the headline and description', () => {
    const html = renderRouteHtml(SHELL, meta, ORIGIN);
    expect(html).toMatch(/<noscript><h1>Pricing<\/h1><p>.+<\/p><\/noscript>/);
  });

  it('escapes markup that appears in page metadata', () => {
    const html = renderRouteHtml(
      SHELL,
      { title: 'A & B', description: '<script>alert(1)</script>', path: '/x' },
      ORIGIN,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('throws rather than silently emitting a page with no metadata', () => {
    expect(() => renderRouteHtml('<html><head></head><body></body></html>', meta, ORIGIN)).toThrow(
      PrerenderError,
    );
  });
});

describe('output paths and manifest', () => {
  it('maps the root to index.html and others to directory indexes', () => {
    expect(outputPathFor('/')).toBe('index.html');
    expect(outputPathFor('/pricing')).toBe('pricing/index.html');
    expect(outputPathFor('/products/409a-valuation')).toBe('products/409a-valuation/index.html');
  });

  it('renders every marketing route the sitemap advertises', () => {
    const pages = prerenderPages(SHELL, ORIGIN);
    expect(pages).toHaveLength(allPageMeta().length);
    const rendered = new Set(pages.map((p) => p.route));
    for (const route of marketingRoutes()) {
      expect(rendered.has(route.path), `${route.path} not prerendered`).toBe(true);
    }
  });

  it('gives each route a unique output file', () => {
    const files = prerenderPages(SHELL, ORIGIN).map((p) => p.fileName);
    expect(files).toHaveLength(new Set(files).size);
  });

  it('builds a route to file manifest the web service can serve from', () => {
    const manifest = buildManifest(prerenderPages(SHELL, ORIGIN));
    expect(manifest.routes['/']).toBe('index.html');
    expect(manifest.routes['/pricing']).toBe('pricing/index.html');
    expect(Object.keys(manifest.routes)).toHaveLength(allPageMeta().length);
  });

  it('gives each prerendered page its own title', () => {
    const titles = prerenderPages(SHELL, ORIGIN).map((p) => /<title>(.*?)<\/title>/.exec(p.html)?.[1]);
    expect(titles.every(Boolean)).toBe(true);
    expect(titles).toHaveLength(new Set(titles).size);
  });
});

describe('font preloads', () => {
  const assets = [
    'assets/index-abc.js',
    'assets/fraunces-latin-wght-normal-aaa.woff2',
    'assets/fraunces-vietnamese-wght-normal-bbb.woff2',
    'assets/public-sans-latin-wght-normal-ccc.woff2',
    'assets/public-sans-latin-ext-wght-normal-ddd.woff2',
  ];

  it('preloads only the latin faces the site actually renders', () => {
    const tags = fontPreloadTags(assets);
    expect(tags).toContain('fraunces-latin-wght-normal-aaa.woff2');
    expect(tags).toContain('public-sans-latin-wght-normal-ccc.woff2');
    expect(tags).not.toContain('vietnamese');
    expect(tags).not.toContain('latin-ext');
  });

  it('marks preloads crossorigin so the CSS fetch reuses them', () => {
    // Without crossorigin a same-origin font preload is not reused and the
    // file is downloaded twice.
    expect(fontPreloadTags(assets)).toContain('crossorigin="anonymous"');
    expect(fontPreloadTags(assets)).toContain('as="font"');
  });

  it('injects preloads at the top of the head', () => {
    const html = withFontPreloads(SHELL, assets);
    expect(html.indexOf('rel="preload"')).toBeLessThan(html.indexOf('<meta charset'));
  });

  it('leaves the document untouched when no fonts were emitted', () => {
    expect(withFontPreloads(SHELL, ['assets/index-abc.js'])).toBe(SHELL);
    expect(fontPreloadTags([])).toBe('');
  });
});
