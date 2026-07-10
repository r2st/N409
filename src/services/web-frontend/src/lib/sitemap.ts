import { marketingRoutes, type SitemapRoute } from './routes';

/** Strip any trailing slash so `base + path` never doubles up. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a `sitemap.xml` document for the given base URL (409.ai §24). Routes
 * default to the marketing inventory; `lastmod` is optional and applied to
 * every URL when supplied (an ISO date, e.g. build date).
 */
export function buildSitemapXml(
  baseUrl: string,
  routes: SitemapRoute[] = marketingRoutes(),
  lastmod?: string,
): string {
  const base = normalizeBase(baseUrl);
  const urls = routes
    .map((route) => {
      const loc = escapeXml(route.path === '/' ? `${base}/` : `${base}${route.path}`);
      const lines = [
        '  <url>',
        `    <loc>${loc}</loc>`,
        lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>` : null,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority.toFixed(1)}</priority>`,
        '  </url>',
      ].filter((line): line is string => line !== null);
      return lines.join('\n');
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Render `robots.txt` — allow everything and point crawlers (including AI
 * crawlers, which we welcome) at the sitemap. Mirrors 409.ai §24.
 */
export function buildRobotsTxt(baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  return [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}
