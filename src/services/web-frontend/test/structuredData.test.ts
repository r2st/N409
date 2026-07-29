/**
 * BreadcrumbList + WebSite structured data on the product and comparison pages.
 *
 * Without them a result for a deep page shows a bare URL and is attributed to a
 * hostname rather than the brand. Both nodes are added through the same
 * pageMeta registry the prerenderer walks, so the baked HTML — the only copy a
 * crawler sees — carries them too.
 */

import { describe, expect, it } from 'vitest';
import { COMPARISONS, PRODUCTS } from '../src/lib/marketing';
import { allPageMeta, comparePageMeta, productPageMeta } from '../src/lib/pageMeta';
import { breadcrumbJsonLd, websiteJsonLd } from '../src/lib/seo';
import { buildHeadTags, renderHeadTags } from '../src/lib/headTags';

const ORIGIN = 'https://x.io';

type Node = Record<string, unknown>;
const nodesFor = (meta: { jsonLd?: unknown }): Node[] => {
  const raw = meta.jsonLd;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []) as Node[];
};
const typeOf = (nodes: Node[], type: string) => nodes.find((n) => n['@type'] === type);

describe('websiteJsonLd', () => {
  it('names the site and its publisher', () => {
    const node = websiteJsonLd(ORIGIN);
    expect(node['@context']).toBe('https://schema.org');
    expect(node['@type']).toBe('WebSite');
    expect(node.url).toBe('https://x.io/');
    expect(node.name).toBe('N409');
    expect((node.publisher as Node)['@type']).toBe('Organization');
  });

  it('declares no search action, because there is no site search to declare', () => {
    expect(websiteJsonLd(ORIGIN).potentialAction).toBeUndefined();
  });
});

describe('breadcrumbJsonLd', () => {
  it('numbers positions from 1 and resolves absolute item URLs', () => {
    const node = breadcrumbJsonLd(
      [
        { name: 'Home', path: '/' },
        { name: 'Compare', path: '/compare/409a-valuation-providers' },
      ],
      ORIGIN,
    );
    expect(node['@type']).toBe('BreadcrumbList');
    const items = node.itemListElement as Node[];
    expect(items.map((i) => i.position)).toEqual([1, 2]);
    expect(items[0]!.item).toBe('https://x.io/');
    expect(items[1]!.item).toBe('https://x.io/compare/409a-valuation-providers');
    expect(items.every((i) => i['@type'] === 'ListItem')).toBe(true);
  });

  it('produces an empty list for no crumbs rather than throwing', () => {
    expect(breadcrumbJsonLd([], ORIGIN).itemListElement).toEqual([]);
  });
});

describe('product pages', () => {
  it('carry Product, BreadcrumbList and WebSite', () => {
    for (const product of PRODUCTS) {
      const nodes = nodesFor(productPageMeta(product.slug)!);
      const types = nodes.map((n) => n['@type']);
      expect(types, product.slug).toContain('Product');
      expect(types, product.slug).toContain('BreadcrumbList');
      expect(types, product.slug).toContain('WebSite');
    }
  });

  it('breadcrumb ends on the page itself', () => {
    const product = PRODUCTS[0]!;
    const crumbs = typeOf(nodesFor(productPageMeta(product.slug)!), 'BreadcrumbList')!
      .itemListElement as Node[];
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]!.name).toBe('Home');
    expect(crumbs[1]!.name).toBe(product.name);
    expect(String(crumbs[1]!.item)).toContain(`/products/${product.slug}`);
  });
});

describe('comparison pages', () => {
  it('carry BreadcrumbList and WebSite', () => {
    for (const comparison of COMPARISONS) {
      const types = nodesFor(comparePageMeta(comparison.slug)!).map((n) => n['@type']);
      expect(types, comparison.slug).toContain('BreadcrumbList');
      expect(types, comparison.slug).toContain('WebSite');
    }
  });

  it('route through the comparison hub, which is itself a published page', () => {
    const comparison = COMPARISONS[0]!;
    const crumbs = typeOf(nodesFor(comparePageMeta(comparison.slug)!), 'BreadcrumbList')!
      .itemListElement as Node[];
    expect(crumbs).toHaveLength(3);
    expect(crumbs.map((c) => c.name)).toEqual([
      'Home',
      '409A valuation providers compared',
      `N409 vs ${comparison.competitor}`,
    ]);
  });

  it('never points a crumb at a page we do not publish', () => {
    // A breadcrumb item that 404s is worse than no breadcrumb: Google drops the
    // whole trail and the page keeps its raw URL in results.
    const published = new Set(allPageMeta().map((p) => p.path));
    for (const meta of allPageMeta()) {
      const crumbs = typeOf(nodesFor(meta), 'BreadcrumbList');
      if (!crumbs) continue;
      for (const item of crumbs.itemListElement as Node[]) {
        const path = new URL(String(item.item)).pathname.replace(/\/$/, '') || '/';
        expect(published.has(path), `${meta.path} → ${path}`).toBe(true);
      }
    }
  });
});

describe('prerendered output', () => {
  it('bakes every node into the static HTML a crawler receives', () => {
    // Social and search crawlers do not run JavaScript, so only the baked copy
    // counts — a node that exists solely in the React render is invisible.
    const html = renderHeadTags(buildHeadTags(productPageMeta(PRODUCTS[0]!.slug)!, ORIGIN));
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('"@type":"WebSite"');
    expect(html.match(/<script type="application\/ld\+json">/g)).toHaveLength(3);
  });

  it('escapes structured data so it cannot break out of the script block', () => {
    const html = renderHeadTags(
      buildHeadTags(
        {
          path: '/x',
          title: 'x',
          description: 'x',
          jsonLd: breadcrumbJsonLd([{ name: '</script><img>', path: '/' }], ORIGIN),
        },
        ORIGIN,
      ),
    );
    expect(html).not.toContain('</script><img>');
    expect(html).toContain('\\u003c/script');
  });
});
