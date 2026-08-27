import { DOCUMENT_KINDS, type DocumentKind } from './pipeline.js';

/**
 * The thirteen document categories a client is asked to fill (migrations 0105
 * and 0112).
 *
 * Two axes, deliberately:
 *
 *   * `kind` answers "what will the extractor do with this file" — it is the
 *     engine's vocabulary and it does not change.
 *   * `category` answers "which thing we asked for does this satisfy" — it is
 *     the client's vocabulary and it is what the intake checklist counts.
 *
 * They are the same axis everywhere except income statements. A company's
 * twelve monthly P&Ls and its one audited annual are both `income_statement`,
 * and a checklist that cannot tell them apart marks "annual statements: done"
 * because someone uploaded a January P&L. That single ambiguity is why the two
 * axes exist at all — which is also why the period cannot be inferred from the
 * kind and has to be stated at upload.
 *
 * 0112's seven corporate buckets widen the gap between the axes rather than
 * closing it: the bylaws, the option plan, the board consents and the IP
 * schedule are all `other` to the extractor and four different answers to
 * "which thing we asked for is this". A category whose `kinds` is `['other']`
 * is not a modelling gap — it is the axis doing exactly what it is for.
 */

export const DOCUMENT_CATEGORIES = [
  // The finance buckets (0105) — what the intake checklist counts, and what a
  // model is blocked on.
  'captable_documents',
  'monthly_income_statements',
  'annual_income_statements',
  'balance_sheets',
  'projections',
  // The corporate record (0112). None of these block a model; they exist so a
  // file has somewhere to be filed that an analyst can find it in, and so the
  // deliverable's evidence list reads as something other than a filename dump.
  'corporate_documents',
  'shareholder_agreements',
  'stock_option_plan',
  'board_resolutions',
  'pitch_deck',
  'intellectual_property',
  'prior_valuations',
  // Still last, still the default, still means "genuinely uncategorised".
  'uploads',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export interface DocumentCategoryDef {
  key: DocumentCategory;
  label: string;
  /** What the client is being asked for, in their words. */
  description: string;
  /**
   * Whether an engagement can be modelled without it. Only the cap table is
   * genuinely required — everything else has a fallback (an asset approach for
   * a pre-revenue company, management estimates for a company with no audited
   * annuals), and marking optional things "required" trains clients to ignore
   * the checklist.
   */
  required: boolean;
  /** Kinds an upload in this category may carry. */
  kinds: readonly DocumentKind[];
  /** What an upload here is recorded as when the client does not say. */
  defaultKind: DocumentKind;
}

export const DOCUMENT_CATEGORY_DEFS: readonly DocumentCategoryDef[] = [
  {
    key: 'captable_documents',
    label: 'Cap table',
    description:
      'Current capitalization: every share class, its liquidation preference and participation ' +
      'terms, the option pool, and any convertible instruments outstanding.',
    required: true,
    kinds: ['cap_table', 'option_grants', 'term_sheet', 'articles_of_incorporation'],
    defaultKind: 'cap_table',
  },
  {
    key: 'monthly_income_statements',
    label: 'Monthly income statements',
    description:
      'Month-by-month P&L for the trailing twelve months. This is what the burn rate, the runway ' +
      'and the LTM figures are built from.',
    required: false,
    kinds: ['income_statement'],
    defaultKind: 'income_statement',
  },
  {
    key: 'annual_income_statements',
    label: 'Annual income statements',
    description: 'Full-year P&L for each completed fiscal year, audited or reviewed where available.',
    required: false,
    kinds: ['income_statement'],
    defaultKind: 'income_statement',
  },
  {
    key: 'balance_sheets',
    label: 'Balance sheets',
    description:
      'Period-end balance sheets. The asset approach and the enterprise-to-equity bridge both ' +
      'read from these.',
    required: false,
    kinds: ['balance_sheet'],
    defaultKind: 'balance_sheet',
  },
  {
    key: 'projections',
    label: 'Projections',
    description:
      'Management forecast — revenue, EBITDA and cash by period. Required for an income approach; ' +
      'without it the valuation leans on market and asset methods.',
    required: false,
    kinds: ['projections', 'cash_flow'],
    defaultKind: 'projections',
  },
  {
    key: 'corporate_documents',
    label: 'Corporate documents',
    description:
      'The charter and the governing documents: certificate of incorporation and its amendments, ' +
      'bylaws, operating agreement, certificate of good standing.',
    required: false,
    // The charter is where the share classes and their preferences are legally
    // defined, so it belongs here as well as in the cap-table evidence set —
    // this is the same file answering two different questions.
    kinds: ['articles_of_incorporation', 'other'],
    defaultKind: 'articles_of_incorporation',
  },
  {
    key: 'shareholder_agreements',
    label: 'Shareholder agreements',
    description:
      'Shareholder, voting and investor-rights agreements, and any side letters. These carry the ' +
      'transfer restrictions and drag/tag terms a marketability discount is argued from.',
    required: false,
    kinds: ['term_sheet', 'other'],
    defaultKind: 'other',
  },
  {
    key: 'stock_option_plan',
    label: 'Stock option plan',
    description:
      'The equity incentive plan document, its amendments, and the grant agreements issued under ' +
      'it. The plan states the authorised pool; the grants state what is actually outstanding.',
    required: false,
    kinds: ['option_grants', 'other'],
    defaultKind: 'option_grants',
  },
  {
    key: 'board_resolutions',
    label: 'Board resolutions',
    description:
      'Board consents and minutes — in particular the resolutions approving option grants and ' +
      'adopting a prior fair market value.',
    required: false,
    kinds: ['other'],
    defaultKind: 'other',
  },
  {
    key: 'pitch_deck',
    label: 'Pitch deck',
    description:
      'The current investor deck. Read for the business description, the market framing and the ' +
      'stage narrative, never for figures — those come from the statements.',
    required: false,
    kinds: ['pitch_deck'],
    defaultKind: 'pitch_deck',
  },
  {
    key: 'intellectual_property',
    label: 'Intellectual property',
    description:
      'Patents, applications, trademarks, and IP assignment or licence agreements. The asset ' +
      'approach and any IP-specific engagement are built from these.',
    required: false,
    kinds: ['other'],
    defaultKind: 'other',
  },
  {
    key: 'prior_valuations',
    label: 'Prior valuations',
    description:
      'Earlier 409A or fair-value reports for this company. The roll-forward compares against the ' +
      'most recent one, and a material change from it has to be explained.',
    required: false,
    kinds: ['prior_valuation', 'other'],
    defaultKind: 'prior_valuation',
  },
  {
    key: 'uploads',
    label: 'Other documents',
    description: 'Anything that bears on value and does not belong in one of the buckets above.',
    required: false,
    // Every kind, deliberately: this is where a file goes when the uploader
    // does not want to choose, and refusing a kind here would leave them with
    // nowhere to put it.
    kinds: DOCUMENT_KINDS,
    defaultKind: 'other',
  },
];

export const DOCUMENT_CATEGORY_DEFS_BY_KEY: ReadonlyMap<DocumentCategory, DocumentCategoryDef> = new Map(
  DOCUMENT_CATEGORY_DEFS.map((d) => [d.key, d]),
);

export function isDocumentCategory(value: string): value is DocumentCategory {
  return (DOCUMENT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Where a document lands when the client picked a kind but not a category.
 *
 * `income_statement` resolves to annual, matching the 0105 backfill: an
 * unstated period is not evidence of a monthly statement, and guessing monthly
 * would mark the monthly bucket satisfied on a single upload.
 */
export function categoryForKind(kind: DocumentKind): DocumentCategory {
  switch (kind) {
    // The cap-table evidence set, not just the cap table itself: grants are the
    // pool detail, and the charter and term sheets are where the share classes
    // and their preferences are actually defined. All three are also accepted
    // under 'uploads', so a client who considers one incidental can still file
    // it there deliberately — this is only where they land by default.
    case 'cap_table':
    case 'option_grants':
    case 'term_sheet':
    case 'articles_of_incorporation':
      return 'captable_documents';
    case 'income_statement':
      return 'annual_income_statements';
    case 'balance_sheet':
      return 'balance_sheets';
    case 'projections':
    case 'cash_flow':
      return 'projections';
    // 0112's two kinds that name their own bucket. Before it they defaulted to
    // 'uploads', which is where they still land if the uploader says so.
    case 'pitch_deck':
      return 'pitch_deck';
    case 'prior_valuation':
      return 'prior_valuations';
    // 'other' stays uncategorised. The five remaining 0112 buckets are all
    // reachable only from a kind of 'other', so inferring any one of them from
    // it would be a coin flip between five — this is the case where the
    // uploader has to choose.
    default:
      return 'uploads';
  }
}

/** Whether a kind may be filed under a category. */
export function kindFitsCategory(kind: DocumentKind, category: DocumentCategory): boolean {
  return DOCUMENT_CATEGORY_DEFS_BY_KEY.get(category)?.kinds.includes(kind) ?? false;
}

/**
 * Resolves the (kind, category) pair from whatever the uploader supplied.
 *
 * Both optional, because both clients exist: the API caller who thinks in
 * kinds, and the person clicking "Monthly income statements" in the intake UI
 * who has never heard of one. A pair that contradicts itself is refused rather
 * than silently corrected — filing an annual statement under "monthly" is the
 * exact confusion 0105 exists to prevent, and quietly moving it would just
 * reintroduce it one layer up.
 */
export function resolveDocumentFiling(input: {
  kind?: string | null;
  category?: string | null;
}): { kind: DocumentKind; category: DocumentCategory } | { error: string } {
  const kindGiven = input.kind ?? null;
  const categoryGiven = input.category ?? null;

  if (kindGiven !== null && !(DOCUMENT_KINDS as readonly string[]).includes(kindGiven)) {
    return { error: `Unknown document kind "${kindGiven}"` };
  }
  if (categoryGiven !== null && !isDocumentCategory(categoryGiven)) {
    return { error: `Unknown document category "${categoryGiven}"` };
  }

  const kind = (kindGiven as DocumentKind | null) ?? null;
  const category = (categoryGiven as DocumentCategory | null) ?? null;

  if (kind !== null && category !== null) {
    if (!kindFitsCategory(kind, category)) {
      return { error: `A "${kind}" document does not belong in "${category}"` };
    }
    return { kind, category };
  }
  if (kind !== null) return { kind, category: categoryForKind(kind) };
  if (category !== null) {
    return { kind: DOCUMENT_CATEGORY_DEFS_BY_KEY.get(category)!.defaultKind, category };
  }
  return { kind: 'other', category: 'uploads' };
}

export interface CategorySummary extends DocumentCategoryDef {
  count: number;
  /** A required category with nothing in it is what blocks the engagement. */
  satisfied: boolean;
}

/**
 * The intake checklist: all thirteen buckets, always, in a fixed order, with
 * what has arrived in each. Every bucket is returned even when empty — an empty
 * bucket is the thing the client needs to see.
 *
 * The order is DOCUMENT_CATEGORY_DEFS and not the enum's: the five buckets a
 * model is blocked on come first, then the corporate record, then the
 * catch-all. A checklist that opened on "board resolutions" would bury the one
 * required bucket in it.
 */
export function summarizeCategories(counts: ReadonlyMap<DocumentCategory, number>): CategorySummary[] {
  return DOCUMENT_CATEGORY_DEFS.map((def) => {
    const count = counts.get(def.key) ?? 0;
    return { ...def, count, satisfied: !def.required || count > 0 };
  });
}
