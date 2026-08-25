import type { ValuationKind } from './valuation.js';

/**
 * "Which valuation do I need?" — the selector behind the marketing quiz and
 * the onboarding fork (remaining-gaps §selector). Pure scoring over a small
 * situation questionnaire; every recommendation carries the reasons that
 * earned its score, because "you need a 409A" is only useful to a founder
 * when it says why.
 *
 * Scores are additive across rules. The ranking, not the absolute number, is
 * the product — ties are broken by the kind list order below, which is the
 * order of commercial likelihood.
 */

export const SELECTOR_PURPOSES = [
  'issue_options',
  'financial_reporting',
  'tax_planning',
  'acquisition',
  'sale_or_loan',
  'fund_reporting',
  'employee_ownership',
  'other',
] as const;
export type SelectorPurpose = (typeof SELECTOR_PURPOSES)[number];

export const SELECTOR_JURISDICTIONS = ['us', 'uk', 'other'] as const;
export type SelectorJurisdiction = (typeof SELECTOR_JURISDICTIONS)[number];

export const SELECTOR_STANDARDS = ['us_gaap', 'ifrs', 'none', 'unsure'] as const;
export type SelectorStandard = (typeof SELECTOR_STANDARDS)[number];

export const SELECTOR_SUBJECTS = [
  'company_equity',
  'small_business',
  'intangible_asset',
  'fund_positions',
  'debt_instrument',
  'transferred_interest',
] as const;
export type SelectorSubject = (typeof SELECTOR_SUBJECTS)[number];

export const SELECTOR_TRIGGERS = [
  'granting_equity',
  'closing_acquisition',
  'impairment_indicator',
  'gift_or_estate_transfer',
  'qsbs_exit_or_diligence',
  'audit_request',
  'none',
] as const;
export type SelectorTrigger = (typeof SELECTOR_TRIGGERS)[number];

export interface SelectorInput {
  purpose?: SelectorPurpose;
  jurisdiction?: SelectorJurisdiction;
  accounting_standard?: SelectorStandard;
  subject?: SelectorSubject;
  trigger?: SelectorTrigger;
  /** Employees on payroll — splits EMI from CSOP on the UK path. */
  employee_count?: number;
  /** The company grants (or plans to grant) stock options. */
  grants_options?: boolean;
  /** An employee stock ownership plan exists or is being set up. */
  has_esop?: boolean;
}

export interface SelectorRecommendation {
  kind: ValuationKind;
  label: string;
  score: number;
  reasons: string[];
}

export interface SelectorResult {
  recommendations: SelectorRecommendation[];
  /** The single best answer, when anything scored at all. */
  primary: SelectorRecommendation | null;
}

/** Display names, in tie-break (commercial likelihood) order. */
export const KIND_LABELS: ReadonlyArray<[ValuationKind, string]> = [
  ['409a', 'IRC 409A valuation'],
  ['718', 'ASC 718 stock-based compensation'],
  ['fmv', 'Small-business fair market value'],
  ['820', 'ASC 820 fair value measurement'],
  ['gifts', 'Gift & estate tax valuation'],
  ['qsbs', 'QSBS attestation (IRC §1202)'],
  ['ppa', 'Purchase price allocation (ASC 805)'],
  ['goodwill', 'Impairment testing (ASC 350/360)'],
  ['esop', 'ESOP valuation'],
  ['ip', 'IP / intangible asset valuation'],
  ['emi', 'EMI scheme valuation (UK)'],
  ['csop', 'CSOP scheme valuation (UK)'],
  ['ifrs2', 'IFRS 2 share-based payment'],
  ['fund', 'Fund portfolio valuation'],
  ['debt', 'Debt instrument valuation'],
];

/**
 * The product's own name for a kind, so anything that names one to a reader —
 * a refusal, a health-check scope note — says it the way the picker does.
 * Unknown keys echo, which is what a kind added to the enum but not to the map
 * should look like.
 */
export function kindLabel(kind: string): string {
  return KIND_LABELS.find(([k]) => k === kind)?.[1] ?? kind;
}

const TIE_ORDER = new Map(KIND_LABELS.map(([kind], i) => [kind, i]));

/** UK Schedule 5: EMI needs fewer than 250 full-time-equivalent employees. */
const EMI_EMPLOYEE_LIMIT = 250;

export function selectValuationKinds(input: SelectorInput): SelectorResult {
  const scores = new Map<ValuationKind, { score: number; reasons: string[] }>();
  const add = (kind: ValuationKind, points: number, reason: string) => {
    const entry = scores.get(kind) ?? { score: 0, reasons: [] };
    entry.score += points;
    entry.reasons.push(reason);
    scores.set(kind, entry);
  };

  const us = input.jurisdiction === 'us' || input.jurisdiction === undefined;
  const uk = input.jurisdiction === 'uk';
  const ifrs = input.accounting_standard === 'ifrs';

  // ── Purpose ────────────────────────────────────────────────────────────────
  if (input.purpose === 'issue_options' || input.trigger === 'granting_equity' || input.grants_options) {
    if (uk) {
      const small = input.employee_count === undefined || input.employee_count < EMI_EMPLOYEE_LIMIT;
      add(
        'emi',
        small ? 3 : 1,
        small
          ? 'UK option grants at a company under the Schedule 5 limits point to an EMI valuation.'
          : 'EMI is available only under the Schedule 5 limits; at this headcount CSOP is the likelier scheme.',
      );
      add(
        'csop',
        small ? 1 : 3,
        small
          ? 'CSOP is the fallback where EMI’s Schedule 5 limits are exceeded.'
          : 'At 250+ employees the EMI limits are exceeded — a CSOP valuation covers the grant.',
      );
    } else {
      add(
        '409a',
        3,
        'Options must be granted at fair market value to avoid IRC §409A penalties — a 409A valuation ' +
          'establishes the safe-harbor price.',
      );
      add(
        '718',
        1,
        'Once options are granted, the grant-date fair value drives the ASC 718 compensation expense.',
      );
    }
  }

  if (input.purpose === 'financial_reporting') {
    if (ifrs) {
      add('ifrs2', 3, 'Share-based awards under IFRS are measured and expensed under IFRS 2.');
    } else if (input.subject === 'fund_positions') {
      add('820', 3, 'Fund holdings are reported at fair value under ASC 820.');
    } else {
      add('718', 2, 'Equity compensation on US GAAP financial statements is measured under ASC 718.');
    }
    if (input.trigger === 'impairment_indicator') {
      add('goodwill', 2, 'An impairment indicator calls for ASC 350/360 testing before the next filing.');
    }
  }

  if (input.purpose === 'tax_planning') {
    if (us) {
      add('gifts', 2, 'Transfers of interests for gift or estate purposes need a Rev. Rul. 59-60 appraisal.');
      add('qsbs', 1, 'If the shares are founder stock in a C corporation, §1202 QSBS relief may apply.');
    }
  }

  if (input.purpose === 'acquisition' || input.trigger === 'closing_acquisition') {
    add(
      'ppa',
      3,
      'A closed business combination must allocate the consideration to identifiable assets under ASC 805.',
    );
    add('goodwill', 1, 'The goodwill recognized in the allocation is tested annually under ASC 350.');
  }

  if (input.purpose === 'sale_or_loan' || input.subject === 'small_business') {
    add(
      'fmv',
      input.purpose === 'sale_or_loan' ? 3 : 2,
      'Pricing a business for a sale, loan or buy-in is a fair-market-value opinion on the whole company.',
    );
  }

  if (input.purpose === 'fund_reporting' || input.subject === 'fund_positions') {
    add('820', 2, 'Fund holdings are measured at fair value under ASC 820 for reporting.');
    add('fund', 1, 'A whole-portfolio mark across positions is a fund portfolio valuation.');
  }

  if (input.purpose === 'employee_ownership' || input.has_esop) {
    add('esop', 3, 'An employee stock ownership plan needs an annual independent valuation for its trustee.');
  }

  // ── Subject & trigger ──────────────────────────────────────────────────────
  if (input.subject === 'intangible_asset') {
    add('ip', 3, 'A specific patent, trademark or software asset is valued on its own as an intangible.');
  }
  if (input.subject === 'debt_instrument') {
    add('debt', 3, 'Notes, loans, convertibles and SAFEs are valued as debt instruments.');
  }
  if (input.subject === 'transferred_interest' || input.trigger === 'gift_or_estate_transfer') {
    add('gifts', 3, 'A transferred interest for tax purposes needs a gift & estate appraisal.');
  }
  if (input.trigger === 'impairment_indicator') {
    add('goodwill', 3, 'Impairment indicators trigger ASC 350/360 testing of goodwill and asset groups.');
  }
  if (input.trigger === 'qsbs_exit_or_diligence') {
    add('qsbs', 3, 'A sale or diligence on §1202 eligibility calls for a QSBS attestation.');
  }
  if (input.trigger === 'audit_request' && input.subject === 'fund_positions') {
    add('820', 2, 'Auditors ask for ASC 820 support for fair-value marks.');
  }

  const recommendations: SelectorRecommendation[] = [...scores.entries()]
    .map(([kind, { score, reasons }]) => ({
      kind,
      label: KIND_LABELS.find(([k]) => k === kind)![1],
      score,
      // A reason can be earned twice via purpose + trigger overlap; say it once.
      reasons: [...new Set(reasons)],
    }))
    .sort((a, b) => b.score - a.score || (TIE_ORDER.get(a.kind) ?? 99) - (TIE_ORDER.get(b.kind) ?? 99))
    .slice(0, 5);

  return { recommendations, primary: recommendations[0] ?? null };
}
