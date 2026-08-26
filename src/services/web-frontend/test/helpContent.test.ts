import { describe, expect, it } from 'vitest';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  articleById,
  categoryMeta,
  loadHelpBodies,
  primaryArticleForCategory,
  searchArticles,
} from '../src/data/helpContent';
import { HELP_BODIES } from '../src/data/helpBodies';

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
    expect(HELP_BODIES['grants-overview']).toContain('/help/asc718-public-overview');
  });

  it('names the HRIS providers Rippling, Gusto and Deel', () => {
    const hris = articleById('hris-overview');
    for (const provider of ['Rippling', 'Gusto', 'Deel']) {
      expect(HELP_BODIES['hris-overview']).toContain(provider);
      expect(hris!.keywords).toContain(provider.toLowerCase());
    }
  });

  it('finds the new engines by their domain terms', () => {
    expect(searchArticles('lookback', HELP_BODIES).some((a) => a.id === 'asc718-espp')).toBe(true);
    expect(searchArticles('calibrated opm', HELP_BODIES).some((a) => a.id === 'fund-calibrated-opm')).toBe(
      true,
    );
    expect(searchArticles('Tsiveriotis', HELP_BODIES).some((a) => a.id === 'debt-convertible')).toBe(true);
    expect(searchArticles('valuation cap', HELP_BODIES).some((a) => a.id === 'debt-safe')).toBe(true);
  });

  it('has a body for every article and an article for every body', () => {
    // The two halves of a split module drift apart silently: an article added
    // without prose renders an empty panel, and a body left behind after its
    // article is deleted is dead weight in a chunk nobody reads.
    const ids = HELP_ARTICLES.map((a) => a.id).sort();
    expect(Object.keys(HELP_BODIES).sort()).toEqual(ids);
    for (const a of HELP_ARTICLES) {
      expect(HELP_BODIES[a.id]!.trim().length, `${a.id} has an empty body`).toBeGreaterThan(0);
    }
  });

  it('searches metadata only when the corpus has not been loaded', () => {
    // A caller that has not paid for the prose gets a metadata match rather
    // than a lie: `searchArticles` cannot claim an article does not mention a
    // term it has never read.
    // "safe harbor" appears in two bodies and in no title, summary or keyword.
    const bodyOnly = 'safe harbor';
    expect(searchArticles(bodyOnly)).toHaveLength(0);
    expect(searchArticles(bodyOnly, HELP_BODIES).map((a) => a.id)).toContain('what-is-409a');
    // Title/keyword matches work either way — those are metadata.
    expect(searchArticles('dlom').some((a) => a.id === 'assumptions-dlom')).toBe(true);
  });

  it('loads the bodies through the split and gets the same corpus', async () => {
    await expect(loadHelpBodies()).resolves.toBe(HELP_BODIES);
  });

  it('searches across title, keywords and body', () => {
    const dlom = searchArticles('dlom', HELP_BODIES);
    expect(dlom.some((a) => a.id === 'assumptions-dlom')).toBe(true);

    const scim = searchArticles('SCIM', HELP_BODIES);
    expect(scim.some((a) => a.id === 'sso-overview')).toBe(true);

    // Empty query returns everything.
    expect(searchArticles('   ', HELP_BODIES)).toHaveLength(HELP_ARTICLES.length);
    // No matches → empty.
    expect(searchArticles('zzz-nonexistent-term', HELP_BODIES)).toHaveLength(0);
  });
});
