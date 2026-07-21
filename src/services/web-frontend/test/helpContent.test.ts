import { describe, expect, it } from 'vitest';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  articleById,
  categoryMeta,
  primaryArticleForCategory,
  searchArticles,
} from '../src/data/helpContent';

describe('helpContent', () => {
  it('covers all 29 categories (26 core + 3 specialized engines)', () => {
    expect(HELP_CATEGORIES).toHaveLength(29);
    const ids = HELP_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(29); // ids are unique
    // A few of the spec's named categories are present.
    for (const id of ['dashboard', 'methodology', 'assumptions', 'sso', 'hris', 'settings']) {
      expect(ids).toContain(id);
    }
    // The three newest valuation engines each get their own category.
    for (const id of ['asc718-public', 'fund-holdings', 'debt-valuation']) {
      expect(ids).toContain(id);
    }
  });

  it('gives every category at least one article', () => {
    for (const cat of HELP_CATEGORIES) {
      expect(primaryArticleForCategory(cat.id), `category ${cat.id} has no article`).toBeDefined();
    }
  });

  it('uses unique article ids that map to real categories', () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categoryIds = new Set(HELP_CATEGORIES.map((c) => c.id));
    for (const a of HELP_ARTICLES) {
      expect(categoryIds.has(a.category), `article ${a.id} → unknown category ${a.category}`).toBe(true);
    }
  });

  it('only links to related articles that exist', () => {
    for (const a of HELP_ARTICLES) {
      for (const rel of a.related ?? []) {
        expect(articleById(rel), `${a.id} → missing related ${rel}`).toBeDefined();
      }
    }
  });

  it('resolves category metadata by id', () => {
    expect(categoryMeta('methodology')?.label).toBe('Methodology');
    expect(categoryMeta('nope')).toBeUndefined();
  });

  it('documents the three newest engines with route-linked, cross-linked articles', () => {
    const engineArticles = [
      'asc718-public-overview',
      'asc718-expected-term',
      'asc718-espp',
      'asc718-tsr',
      'fund-holdings-overview',
      'fund-fair-value-hierarchy',
      'fund-calibrated-opm',
      'fund-nav',
      'fund-waterfall',
      'debt-valuation-overview',
      'debt-yield-dcf',
      'debt-credit-spread',
      'debt-convertible',
      'debt-safe',
    ];
    for (const id of engineArticles) {
      const a = articleById(id);
      expect(a, `missing article ${id}`).toBeDefined();
      // Each engine article points at its feature page and is findable in search.
      expect(a!.route, `${id} has no route`).toMatch(/^\/(valuations|funds|debt)$/);
      expect(a!.keywords.length, `${id} needs keywords`).toBeGreaterThan(2);
    }

    // The overview articles route to the exact feature pages.
    expect(articleById('asc718-public-overview')!.route).toBe('/valuations');
    expect(articleById('fund-holdings-overview')!.route).toBe('/funds');
    expect(articleById('debt-valuation-overview')!.route).toBe('/debt');
  });

  it('cross-links the private grants article to the new public ASC 718 engine', () => {
    const grants = articleById('grants-overview');
    expect(grants!.title.toLowerCase()).toContain('private');
    expect(grants!.related).toContain('asc718-public-overview');
    expect(grants!.body).toContain('/help/asc718-public-overview');
  });

  it('names the HRIS providers Rippling, Gusto and Deel', () => {
    const hris = articleById('hris-overview');
    for (const provider of ['Rippling', 'Gusto', 'Deel']) {
      expect(hris!.body).toContain(provider);
      expect(hris!.keywords).toContain(provider.toLowerCase());
    }
  });

  it('finds the new engines by their domain terms', () => {
    expect(searchArticles('lookback').some((a) => a.id === 'asc718-espp')).toBe(true);
    expect(searchArticles('calibrated opm').some((a) => a.id === 'fund-calibrated-opm')).toBe(true);
    expect(searchArticles('Tsiveriotis').some((a) => a.id === 'debt-convertible')).toBe(true);
    expect(searchArticles('valuation cap').some((a) => a.id === 'debt-safe')).toBe(true);
  });

  it('searches across title, keywords and body', () => {
    const dlom = searchArticles('dlom');
    expect(dlom.some((a) => a.id === 'assumptions-dlom')).toBe(true);

    const scim = searchArticles('SCIM');
    expect(scim.some((a) => a.id === 'sso-overview')).toBe(true);

    // Empty query returns everything.
    expect(searchArticles('   ')).toHaveLength(HELP_ARTICLES.length);
    // No matches → empty.
    expect(searchArticles('zzz-nonexistent-term')).toHaveLength(0);
  });
});
