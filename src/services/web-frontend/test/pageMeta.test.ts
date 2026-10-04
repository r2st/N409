import { describe, expect, it } from 'vitest';
import { pageMeta } from '../src/lib/pageMeta';
import {
  allPageMeta,
  comparePageMeta,
  partnerSegmentPageMeta,
  productPageMeta,
  stagePageMeta,
} from '../src/lib/pageMetaRoutes';
import { marketingRoutes } from '../src/lib/routes';
import { COMPARISONS, FUNDING_STAGES, PARTNER_SEGMENTS, PRODUCTS } from '../src/lib/marketing';

describe('page metadata registry (§24)', () => {
  it('covers every route we publish in the sitemap', () => {
    // A sitemap entry with no metadata is a page we told Google to index and
    // then handed it a generic title and no description.
    const covered = new Set(allPageMeta().map((p) => p.path));
    const missing = marketingRoutes()
      .map((r) => r.path)
      .filter((path) => !covered.has(path));
    expect(missing).toEqual([]);
  });

  it('publishes a sitemap entry for every page it describes', () => {
    const inSitemap = new Set(marketingRoutes().map((r) => r.path));
    const orphans = allPageMeta()
      .map((p) => p.path)
      .filter((path) => !inSitemap.has(path));
    expect(orphans).toEqual([]);
  });

  it('has one entry per path', () => {
    const paths = allPageMeta().map((p) => p.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });

  it('covers all products and comparisons', () => {
    // Twenty static pages: home, pricing, which-valuation, the four
    // tool pages (409A calculator, stock option tax calculator, compliance
    // checker, startup valuation estimator), resources, the three educational
    // guides (409A guide, when do you need one, what does it cost), the sample
    // report, the compare hub, the partner hub, developers, blog, about,
    // contact, terms, privacy.
    // Individual blog posts are database rows and are deliberately absent —
    // this registry is build-time data.
    expect(allPageMeta()).toHaveLength(
      20 + PRODUCTS.length + FUNDING_STAGES.length + PARTNER_SEGMENTS.length + COMPARISONS.length,
    );
    for (const product of PRODUCTS) {
      expect(productPageMeta(product.slug)?.path).toBe(`/products/${product.slug}`);
    }
    for (const stage of FUNDING_STAGES) {
      expect(stagePageMeta(stage.slug)?.path).toBe(`/409a-valuation/${stage.slug}`);
    }
    for (const segment of PARTNER_SEGMENTS) {
      expect(partnerSegmentPageMeta(segment.slug)?.path).toBe(`/partners/${segment.slug}`);
    }
    for (const comparison of COMPARISONS) {
      expect(comparePageMeta(comparison.slug)?.path).toBe(`/compare/${comparison.slug}`);
    }
  });

  it('returns undefined for unknown slugs and paths', () => {
    expect(productPageMeta('not-a-product')).toBeUndefined();
    expect(comparePageMeta('not-a-competitor')).toBeUndefined();
    expect(stagePageMeta('not-a-stage')).toBeUndefined();
    expect(partnerSegmentPageMeta('not-a-segment')).toBeUndefined();
    expect(pageMeta('/nope')).toBeUndefined();
  });

  it('gives every page a title and a description within search-result limits', () => {
    for (const page of allPageMeta()) {
      expect(page.title.trim(), page.path).not.toBe('');
      // Google truncates around 155–160 characters; anything much longer is
      // cut off mid-sentence in the result. The floor catches placeholders.
      expect(page.description.length, `${page.path} description length`).toBeGreaterThan(50);
      expect(page.description.length, `${page.path} description length`).toBeLessThanOrEqual(200);
    }
  });

  it('writes a distinct description for each page', () => {
    // Duplicate descriptions across pages are a classic thin-content signal.
    const descriptions = allPageMeta().map((p) => p.description);
    expect(descriptions).toHaveLength(new Set(descriptions).size);
  });

  it('marks product pages as og:type product with Product structured data', () => {
    const meta = productPageMeta(PRODUCTS[0]!.slug)!;
    expect(meta.type).toBe('product');
    expect(JSON.stringify(meta.jsonLd)).toContain('"@type":"Product"');
  });

  it('keeps the headline price in sync with the catalogue', () => {
    // The homepage and pricing descriptions quote a "from" price; if it drifts
    // from what checkout charges we are advertising a price we don't honour.
    const cheapest = Math.min(...PRODUCTS.map((p) => p.priceCents));
    const expected = `$${(cheapest / 100).toLocaleString('en-US')}`;
    expect(pageMeta('/')!.description).toContain(expected);
    expect(pageMeta('/pricing')!.description).toContain(expected);
  });
});
