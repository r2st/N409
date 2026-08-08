import { describe, expect, it } from 'vitest';
import {
  categoryForKind,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_DEFS,
  kindFitsCategory,
  resolveDocumentFiling,
  summarizeCategories,
  type DocumentCategory,
} from '../../src/domain/documentCategories.js';
import { DOCUMENT_KINDS } from '../../src/domain/pipeline.js';

describe('document categories', () => {
  it('defines exactly the six intake buckets, in checklist order', () => {
    expect(DOCUMENT_CATEGORIES).toEqual([
      'captable_documents',
      'monthly_income_statements',
      'annual_income_statements',
      'balance_sheets',
      'projections',
      'uploads',
    ]);
    expect(DOCUMENT_CATEGORY_DEFS.map((d) => d.key)).toEqual([...DOCUMENT_CATEGORIES]);
  });

  it('gives every kind a home', () => {
    for (const kind of DOCUMENT_KINDS) {
      const category = categoryForKind(kind);
      expect(DOCUMENT_CATEGORIES, `${kind} → ${category}`).toContain(category);
      expect(kindFitsCategory(kind, category), `${kind} does not fit its own default`).toBe(true);
    }
  });

  it("accepts each bucket's own default kind", () => {
    for (const def of DOCUMENT_CATEGORY_DEFS) {
      expect(def.kinds, `${def.key} rejects its default`).toContain(def.defaultKind);
    }
  });

  it('requires only the cap table', () => {
    // Everything else has a fallback methodology, and marking optional things
    // required trains clients to ignore the checklist.
    expect(DOCUMENT_CATEGORY_DEFS.filter((d) => d.required).map((d) => d.key)).toEqual([
      'captable_documents',
    ]);
  });

  it('resolves an unstated income-statement period to annual', () => {
    // Guessing monthly would mark the monthly bucket satisfied on one upload;
    // an unstated period is not evidence of a monthly statement.
    expect(resolveDocumentFiling({ kind: 'income_statement' })).toEqual({
      kind: 'income_statement',
      category: 'annual_income_statements',
    });
  });

  it('lets the client state the period the kind cannot carry', () => {
    expect(resolveDocumentFiling({ kind: 'income_statement', category: 'monthly_income_statements' })).toEqual(
      { kind: 'income_statement', category: 'monthly_income_statements' },
    );
  });

  it('derives a kind from a category alone', () => {
    // The intake UI offers buckets, not kinds — someone clicking "Projections"
    // has never heard of a document kind.
    expect(resolveDocumentFiling({ category: 'projections' })).toEqual({
      kind: 'projections',
      category: 'projections',
    });
    expect(resolveDocumentFiling({ category: 'captable_documents' })).toEqual({
      kind: 'cap_table',
      category: 'captable_documents',
    });
  });

  it('refuses a contradictory pair rather than silently correcting it', () => {
    // Filing a balance sheet under "monthly income statements" is the exact
    // confusion categories exist to prevent; quietly moving it reintroduces it.
    const result = resolveDocumentFiling({ kind: 'balance_sheet', category: 'monthly_income_statements' });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('balance_sheet');
  });

  it('rejects unknown values on either axis', () => {
    expect(resolveDocumentFiling({ kind: 'tax_return' })).toHaveProperty('error');
    expect(resolveDocumentFiling({ category: 'quarterly_statements' })).toHaveProperty('error');
  });

  it('falls back to the catch-all when nothing is stated', () => {
    expect(resolveDocumentFiling({})).toEqual({ kind: 'other', category: 'uploads' });
  });

  it('reports every bucket, including the empty ones', () => {
    // An empty bucket is the thing the client needs to see, so filtering to
    // the ones with uploads would hide exactly the useful half.
    const summary = summarizeCategories([]);
    expect(summary).toHaveLength(6);
    expect(summary.every((s) => s.count === 0)).toBe(true);
    expect(summary.filter((s) => !s.satisfied).map((s) => s.key)).toEqual(['captable_documents']);
  });

  it('counts uploads per bucket and clears the required one', () => {
    const docs: Array<{ category: DocumentCategory }> = [
      { category: 'captable_documents' },
      { category: 'monthly_income_statements' },
      { category: 'monthly_income_statements' },
      { category: 'monthly_income_statements' },
    ];
    const byKey = new Map(summarizeCategories(docs).map((s) => [s.key, s]));
    expect(byKey.get('monthly_income_statements')!.count).toBe(3);
    expect(byKey.get('captable_documents')!.satisfied).toBe(true);
    expect(byKey.get('annual_income_statements')!.count).toBe(0);
    // An optional empty bucket is satisfied — it is not blocking anything.
    expect(byKey.get('annual_income_statements')!.satisfied).toBe(true);
  });
});
