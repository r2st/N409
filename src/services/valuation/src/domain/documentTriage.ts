import {
  DOCUMENT_CATEGORY_DEFS_BY_KEY,
  kindFitsCategory,
  type DocumentCategory,
} from './documentCategories.js';
import type { DocumentKind } from './pipeline.js';

/**
 * Legacy re-filing (design §9.2, P2-16).
 *
 * Migration 0112 added seven corporate buckets and deliberately backfilled
 * nothing into them: every charter, bylaw, option plan, board consent and IP
 * schedule uploaded before it is still in `uploads`, because re-filing from a
 * filename is exactly the silent reclassification 0105 exists to prevent.
 *
 * So this is a queue and not a migration. The one thing a machine may
 * contribute is a *suggestion* an operator either accepts or ignores — which
 * is a different thing from a reclassification, because a wrong suggestion
 * costs a glance and a wrong sweep costs an evidence list that says a document
 * is something it is not.
 *
 * The suggester is a filename heuristic and nothing more. It is deliberately
 * not the AI summariser: an operator reading a suggestion needs to know how it
 * was reached, and "the filename contains 'bylaws'" is a claim they can check
 * in the same glance they read the row. It is also why every suggestion ships
 * with the matched term rather than a confidence score — a score invites
 * trusting it, and a matched term invites reading the filename.
 *
 * The heuristic is intentionally conservative: no match returns null, and the
 * row then simply has no suggestion. Guessing under uncertainty is the whole
 * failure mode being avoided.
 */

export interface CategorySuggestion {
  category: DocumentCategory;
  /** The term in the filename this was matched on — shown, never hidden. */
  matched: string;
}

/**
 * Terms → bucket, most specific first. Order matters: an "amended and restated
 * certificate of incorporation" hits `certificate of incorporation` before it
 * can hit the bare `certificate`, and a "2024 stock option plan" must not be
 * read as a board resolution because it mentions "plan".
 *
 * Only the seven corporate buckets 0112 added, plus prior valuations, appear
 * here. The five finance buckets are not guessable from a filename — "Q3.xlsx"
 * is a monthly or an annual or a balance sheet with equal likelihood, and that
 * ambiguity is the reason the category axis exists at all.
 */
const FILENAME_RULES: ReadonlyArray<{ term: string; category: DocumentCategory }> = [
  { term: 'certificate of incorporation', category: 'corporate_documents' },
  { term: 'articles of incorporation', category: 'corporate_documents' },
  { term: 'certificate of good standing', category: 'corporate_documents' },
  { term: 'operating agreement', category: 'corporate_documents' },
  { term: 'bylaws', category: 'corporate_documents' },
  { term: 'by-laws', category: 'corporate_documents' },
  { term: 'charter', category: 'corporate_documents' },
  { term: 'incorporation', category: 'corporate_documents' },

  { term: 'stock option plan', category: 'stock_option_plan' },
  { term: 'equity incentive plan', category: 'stock_option_plan' },
  { term: 'option plan', category: 'stock_option_plan' },
  { term: 'grant agreement', category: 'stock_option_plan' },

  { term: 'shareholders agreement', category: 'shareholder_agreements' },
  { term: 'shareholder agreement', category: 'shareholder_agreements' },
  { term: 'investor rights', category: 'shareholder_agreements' },
  { term: 'voting agreement', category: 'shareholder_agreements' },
  { term: 'side letter', category: 'shareholder_agreements' },

  { term: 'board resolution', category: 'board_resolutions' },
  { term: 'board consent', category: 'board_resolutions' },
  { term: 'board minutes', category: 'board_resolutions' },
  { term: 'written consent', category: 'board_resolutions' },
  { term: 'unanimous consent', category: 'board_resolutions' },

  { term: 'pitch deck', category: 'pitch_deck' },
  { term: 'investor deck', category: 'pitch_deck' },
  { term: 'pitchdeck', category: 'pitch_deck' },

  { term: 'patent', category: 'intellectual_property' },
  { term: 'trademark', category: 'intellectual_property' },
  { term: 'ip assignment', category: 'intellectual_property' },
  { term: 'licence agreement', category: 'intellectual_property' },
  { term: 'license agreement', category: 'intellectual_property' },

  { term: '409a', category: 'prior_valuations' },
  { term: 'valuation report', category: 'prior_valuations' },
  { term: 'prior valuation', category: 'prior_valuations' },
];

/**
 * Normalise the way a filename is actually written before matching it.
 *
 * Real uploads are `Bylaws_Amended_2023.pdf` and `board-consent-2024-03.pdf`,
 * not `bylaws amended 2023.pdf`. Separators become spaces so one rule covers
 * every spelling of the same word, and the extension goes so `.pdf` cannot
 * contribute to a match.
 */
export function normalizeFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A suggestion for an uncategorised upload, or null when nothing matches.
 *
 * Never auto-applied anywhere. The only caller is the triage listing, which
 * shows it beside a dropdown an operator has to actually choose from.
 */
export function suggestCategory(filename: string): CategorySuggestion | null {
  const normalized = normalizeFilename(filename);
  for (const rule of FILENAME_RULES) {
    if (normalized.includes(rule.term)) return { category: rule.category, matched: rule.term };
  }
  return null;
}

export interface RefileTarget {
  category: DocumentCategory;
  kind: DocumentKind;
}

/**
 * What a re-file into `category` should write.
 *
 * The category is the operator's decision and the kind is not: `kind` is the
 * extractor's vocabulary, and an operator answering "which thing we asked for
 * is this" has expressed no opinion about which extractor should read the file.
 *
 * So the existing kind is kept whenever the target bucket accepts it — which,
 * for the six corporate buckets, includes `other`. A bylaw filed under
 * "Corporate documents" stays `other`: promoting it to
 * `articles_of_incorporation` would be the platform claiming the charter
 * extractor can read it, which is a claim nobody made.
 *
 * The bucket's default kind is used only where the current one does not fit at
 * all, because a (kind, category) pair that contradicts itself is the exact
 * confusion 0105 exists to prevent and cannot be written.
 */
export function refileTarget(current: DocumentKind, category: DocumentCategory): RefileTarget {
  const def = DOCUMENT_CATEGORY_DEFS_BY_KEY.get(category);
  if (!def) throw new Error(`Unknown document category "${category}"`);
  return { category, kind: kindFitsCategory(current, category) ? current : def.defaultKind };
}
