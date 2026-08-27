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
  it('defines exactly the thirteen intake buckets, in checklist order', () => {
    // The five a model is blocked on first, then the corporate record (0112),
    // then the catch-all. Order is asserted and not just membership: it is
    // what the checklist renders, and opening on "board resolutions" would
    // bury the one required bucket.
    expect(DOCUMENT_CATEGORIES).toEqual([
      'captable_documents',
      'monthly_income_statements',
      'annual_income_statements',
      'balance_sheets',
      'projections',
      'corporate_documents',
      'shareholder_agreements',
      'stock_option_plan',
      'board_resolutions',
      'pitch_deck',
      'intellectual_property',
      'prior_valuations',
      'uploads',
    ]);
    expect(DOCUMENT_CATEGORY_DEFS.map((d) => d.key)).toEqual([...DOCUMENT_CATEGORIES]);
  });

  it('keeps the catch-all last and open to every kind', () => {
    // A file whose uploader will not choose has to land somewhere, so the
    // bucket that exists for exactly that must not refuse a kind.
    const uploads = DOCUMENT_CATEGORY_DEFS.at(-1)!;
    expect(uploads.key).toBe('uploads');
    for (const kind of DOCUMENT_KINDS) expect(kindFitsCategory(kind, 'uploads')).toBe(true);
  });

  it('routes the two kinds that name their own bucket', () => {
    // Before 0112 both landed in the catch-all. Everything else that reaches
    // a corporate bucket is `other`, which names five of them equally, so it
    // stays uncategorised rather than being guessed at.
    expect(categoryForKind('pitch_deck')).toBe('pitch_deck');
    expect(categoryForKind('prior_valuation')).toBe('prior_valuations');
    expect(categoryForKind('other')).toBe('uploads');
  });

  it('lets an "other" file be filed in any corporate bucket', () => {
    // The whole point of the second axis: the bylaws, the option plan and the
    // board consents are one kind to the extractor and three answers to
    // "which thing we asked for is this".
    for (const category of [
      'corporate_documents',
      'shareholder_agreements',
      'stock_option_plan',
      'board_resolutions',
      'intellectual_property',
    ] as const) {
      expect(resolveDocumentFiling({ kind: 'other', category })).toEqual({ kind: 'other', category });
    }
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
    expect(
      resolveDocumentFiling({ kind: 'income_statement', category: 'monthly_income_statements' }),
    ).toEqual({ kind: 'income_statement', category: 'monthly_income_statements' });
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
    const summary = summarizeCategories(new Map());
    expect(summary).toHaveLength(13);
    expect(summary.every((s) => s.count === 0)).toBe(true);
    expect(summary.filter((s) => !s.satisfied).map((s) => s.key)).toEqual(['captable_documents']);
  });

  it('counts uploads per bucket and clears the required one', () => {
    // Counts rather than rows: `documentCoverage` answers this in SQL now, so
    // the checklist stays exact on an engagement whose file list is a page.
    // Counting a page here would have reported a bucket as unsatisfied
    // because its uploads sat past `DOCUMENT_PAGE_LIMIT`.
    const counts = new Map<DocumentCategory, number>([
      ['captable_documents', 1],
      ['monthly_income_statements', 3],
    ]);
    const byKey = new Map(summarizeCategories(counts).map((s) => [s.key, s]));
    expect(byKey.get('monthly_income_statements')!.count).toBe(3);
    expect(byKey.get('captable_documents')!.satisfied).toBe(true);
    expect(byKey.get('annual_income_statements')!.count).toBe(0);
    // An optional empty bucket is satisfied — it is not blocking anything.
    expect(byKey.get('annual_income_statements')!.satisfied).toBe(true);
  });
});
