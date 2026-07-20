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
  it('covers all 26 required categories', () => {
    expect(HELP_CATEGORIES).toHaveLength(26);
    const ids = HELP_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(26); // ids are unique
    // A few of the spec's named categories are present.
    for (const id of ['dashboard', 'methodology', 'assumptions', 'sso', 'hris', 'settings']) {
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
