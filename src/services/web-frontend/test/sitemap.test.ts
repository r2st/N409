import { describe, expect, it } from 'vitest';
import { buildRobotsTxt, buildSitemapXml } from '../src/lib/sitemap';
import { marketingRoutes } from '../src/lib/routes';
import { COMPARISONS, PRODUCTS } from '../src/lib/marketing';

describe('marketingRoutes (§24)', () => {
  it('covers the homepage, every product, and every comparison', () => {
    const paths = marketingRoutes().map((r) => r.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/pricing');
    for (const product of PRODUCTS) expect(paths).toContain(`/products/${product.slug}`);
    for (const comparison of COMPARISONS) expect(paths).toContain(`/compare/${comparison.slug}`);
  });

  it('keeps priorities within 0..1', () => {
    for (const route of marketingRoutes()) {
      expect(route.priority).toBeGreaterThanOrEqual(0);
      expect(route.priority).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildSitemapXml', () => {
  const xml = buildSitemapXml('https://example.com/');

  it('is a well-formed urlset', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('strips the trailing slash from the base and emits absolute locs', () => {
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain(`<loc>https://example.com/products/${PRODUCTS[0]!.slug}</loc>`);
    expect(xml).not.toContain('example.com//');
  });

  it('includes lastmod only when provided', () => {
    expect(xml).not.toContain('<lastmod>');
    expect(buildSitemapXml('https://example.com', undefined, '2026-07-10')).toContain(
      '<lastmod>2026-07-10</lastmod>',
    );
  });
});

describe('buildRobotsTxt', () => {
  it('allows all and points at the sitemap', () => {
    const txt = buildRobotsTxt('https://example.com/');
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Sitemap: https://example.com/sitemap.xml');
  });
});
