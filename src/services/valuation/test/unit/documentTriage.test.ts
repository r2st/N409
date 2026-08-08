import { describe, expect, it } from 'vitest';
import { normalizeFilename, refileTarget, suggestCategory } from '../../src/domain/documentTriage.js';

/**
 * The filename suggester (design §9.2).
 *
 * What is being pinned down here is restraint as much as recall. A suggester
 * that guesses under uncertainty is the silent reclassification 0105 exists to
 * prevent, wearing a dropdown — so "returns nothing" is the correct behaviour
 * on anything ambiguous and is tested as hard as the matches are.
 */
describe('suggestCategory', () => {
  it('reads the corporate record out of the filenames people actually upload', () => {
    const cases: Array<[string, string]> = [
      ['Bylaws_Amended_2023.pdf', 'corporate_documents'],
      ['certificate-of-incorporation.PDF', 'corporate_documents'],
      ['Acme Operating Agreement (executed).docx', 'corporate_documents'],
      ['2021 Stock Option Plan.pdf', 'stock_option_plan'],
      ['equity_incentive_plan_v3.pdf', 'stock_option_plan'],
      ['Shareholders Agreement - final.pdf', 'shareholder_agreements'],
      ['board-consent-2024-03.pdf', 'board_resolutions'],
      ['Unanimous Written Consent.pdf', 'board_resolutions'],
      ['Acme_pitch_deck_seriesA.pdf', 'pitch_deck'],
      ['US-Patent-11223344.pdf', 'intellectual_property'],
      ['409A_report_2023.pdf', 'prior_valuations'],
    ];
    for (const [filename, category] of cases) {
      expect(suggestCategory(filename)?.category, filename).toBe(category);
    }
  });

  it('says which term it matched, so the suggestion can be checked at a glance', () => {
    // A confidence score invites trusting the suggestion. The matched term
    // invites reading the filename, which is the point.
    expect(suggestCategory('Bylaws_Amended_2023.pdf')?.matched).toBe('bylaws');
    expect(suggestCategory('board-consent-2024-03.pdf')?.matched).toBe('board consent');
  });

  it('returns nothing rather than guessing at an ambiguous name', () => {
    for (const filename of ['Q3.xlsx', 'scan_0012.pdf', 'final final v2.docx', 'IMG_4471.HEIC']) {
      expect(suggestCategory(filename), filename).toBeNull();
    }
  });

  it('never suggests a finance bucket — a filename cannot tell those apart', () => {
    // "Financials 2023" is a monthly, an annual or a balance sheet with equal
    // likelihood, and that ambiguity is why the category axis exists at all.
    for (const filename of ['Financials 2023.xlsx', 'P&L.xlsx', 'balance sheet dec.pdf']) {
      expect(suggestCategory(filename), filename).toBeNull();
    }
  });

  it('prefers the more specific rule when a name satisfies two', () => {
    // "Amended and Restated Certificate of Incorporation" contains both the
    // specific phrase and the bare word; the specific one has to win.
    expect(suggestCategory('Amended and Restated Certificate of Incorporation.pdf')).toEqual({
      category: 'corporate_documents',
      matched: 'certificate of incorporation',
    });
    // A stock option plan mentions "plan" and is not a board resolution.
    expect(suggestCategory('2021 Stock Option Plan.pdf')?.category).toBe('stock_option_plan');
  });

  it('normalises separators and drops the extension before matching', () => {
    expect(normalizeFilename('Board_Consent-2024.03.pdf')).toBe('board consent 2024 03');
    // The extension must not contribute: an ".ip" file is not an IP schedule.
    expect(normalizeFilename('notes.pdf')).toBe('notes');
  });
});

describe('refileTarget', () => {
  it('leaves the kind alone where the bucket accepts it — the operator filed, not classified', () => {
    // Every corporate bucket accepts `other`, so a triage row keeps it.
    // Promoting a bylaw to `articles_of_incorporation` would be the platform
    // claiming the charter extractor can read it, which nobody claimed.
    expect(refileTarget('other', 'corporate_documents')).toEqual({
      category: 'corporate_documents',
      kind: 'other',
    });
    expect(refileTarget('other', 'stock_option_plan').kind).toBe('other');
    expect(refileTarget('other', 'board_resolutions').kind).toBe('other');
  });

  it('falls back to the bucket’s default only where the kind cannot fit', () => {
    // The finance buckets do not accept `other` — a pair that contradicts
    // itself is the confusion 0105 exists to prevent and cannot be written.
    expect(refileTarget('other', 'captable_documents')).toEqual({
      category: 'captable_documents',
      kind: 'cap_table',
    });
    expect(refileTarget('other', 'balance_sheets').kind).toBe('balance_sheet');
    expect(refileTarget('other', 'monthly_income_statements').kind).toBe('income_statement');
  });

  it('keeps a kind that already fits, rather than demoting it', () => {
    // A prior_valuation moved out of `uploads` into `prior_valuations` must
    // not lose the kind that decides which extractor reads it.
    expect(refileTarget('prior_valuation', 'prior_valuations')).toEqual({
      category: 'prior_valuations',
      kind: 'prior_valuation',
    });
    expect(refileTarget('pitch_deck', 'pitch_deck').kind).toBe('pitch_deck');
  });

  it('refuses a category that does not exist rather than inventing a filing', () => {
    expect(() => refileTarget('other', 'not_a_bucket' as never)).toThrow(/Unknown document category/);
  });
});
