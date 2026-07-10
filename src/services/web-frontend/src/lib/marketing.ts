import type { ValuationKind } from './types';

/**
 * Public marketing site content (409.ai §22). Static, data-driven: one
 * product page per valuation kind, competitor comparison pages, the pricing
 * calculator, and the "which valuation?" quiz all render from this module.
 *
 * Prices mirror the backend list prices (routes/payments.ts
 * DEFAULT_PRICE_CENTS / FALLBACK_PRICE_CENTS) — keep in sync.
 */

export interface Product {
  slug: string;
  kind: ValuationKind;
  name: string;
  short: string;
  tagline: string;
  description: string;
  bullets: string[];
  audience: string;
  priceCents: number;
  deliveryDays: number;
}

const P = (cents: number) => cents; // readability marker for cents literals

export const PRODUCTS: Product[] = [
  {
    slug: '409a-valuation',
    kind: '409a',
    name: '409A Valuation',
    short: '409A',
    tagline: 'Set your option strike price with confidence.',
    description:
      'An independent, audit-defensible fair market value of your common stock under IRC §409A — the valuation every venture-backed company needs before granting stock options.',
    bullets: [
      'Safe-harbor qualified, prepared by credentialed analysts',
      'OPM backsolve against your latest round, multi-approach cross-check',
      'DLOM support (Chaffee and Finnerty put-option models)',
      'Board-ready PDF report with full methodology appendix',
    ],
    audience: 'Venture-backed startups granting stock options',
    priceCents: P(119_000),
    deliveryDays: 7,
  },
  {
    slug: 'smb-valuation',
    kind: 'fmv',
    name: 'SMB Valuation',
    short: 'SMB / FMV',
    tagline: 'Know what your business is worth.',
    description:
      'A general fair-market-value opinion for small and medium businesses — for loans, a sale, buying out a partner, or bringing a new one in.',
    bullets: [
      'Income, market, and asset approaches, weighted to your situation',
      'Built from your real financials — connect accounting software or upload statements',
      'Clear, plain-English report you can hand to a bank or a buyer',
    ],
    audience: 'Business owners, lenders, and brokers',
    priceCents: P(99_000),
    deliveryDays: 7,
  },
  {
    slug: 'asc-718-valuation',
    kind: '718',
    name: 'ASC 718 Valuation',
    short: 'ASC 718',
    tagline: 'Stock-comp expense your auditor will accept.',
    description:
      'Fair-value measurement of share-based compensation under ASC 718, ready for your financial statements and your audit.',
    bullets: [
      'Grant-date fair value for options, RSUs, and other awards',
      'Volatility, expected-term, and rate support documented in the report',
      'Built to withstand Big-4 audit review',
    ],
    audience: 'Companies expensing equity compensation',
    priceCents: P(149_000),
    deliveryDays: 7,
  },
  {
    slug: 'asc-820-valuation',
    kind: '820',
    name: 'ASC 820 Valuation',
    short: 'ASC 820',
    tagline: 'Fair-value measurement for financial reporting.',
    description:
      'Independent fair-value measurement of investments and financial instruments under ASC 820 for funds and corporates.',
    bullets: [
      'Level 3 asset valuations with documented inputs',
      'Portfolio company and instrument-level support',
      'Audit-ready schedules and methodology',
    ],
    audience: 'Funds and companies reporting fair value',
    priceCents: P(149_000),
    deliveryDays: 7,
  },
  {
    slug: 'gift-estate-tax-valuation',
    kind: 'gifts',
    name: 'Gift & Estate Tax Valuation',
    short: 'Gift & Estate',
    tagline: 'Transfer shares with the IRS in mind.',
    description:
      'Qualified appraisals for gifting or bequeathing closely-held shares — built for IRS Form 709/706 filings and estate planning.',
    bullets: [
      'Qualified appraisal meeting IRS requirements',
      'Minority-interest and marketability discounts documented',
      'Support through examination if the IRS asks questions',
    ],
    audience: 'Founders and families planning share transfers',
    priceCents: P(99_000),
    deliveryDays: 7,
  },
  {
    slug: 'qsbs-attestation',
    kind: 'qsbs',
    name: 'QSBS Attestation',
    short: 'QSBS',
    tagline: 'Document your §1202 eligibility.',
    description:
      'An attestation letter documenting your company’s Qualified Small Business Stock status — the paperwork behind a potential 100% capital-gains exclusion.',
    bullets: [
      'Gross-asset test documentation at issuance',
      'Active-business requirement analysis',
      'Letter format your investors’ tax advisors expect',
    ],
    audience: 'Startups and their early shareholders',
    priceCents: P(99_000),
    deliveryDays: 7,
  },
  {
    slug: 'csop-valuation',
    kind: 'csop',
    name: 'CSOP Valuation',
    short: 'CSOP (UK)',
    tagline: 'HMRC-ready Company Share Option Plan values.',
    description:
      'Share valuations for UK Company Share Option Plans, prepared for HMRC agreement and grant documentation.',
    bullets: [
      'UMV and AMV determinations',
      'HMRC VAL231 support',
      'UK market comparables and methodology',
    ],
    audience: 'UK companies operating a CSOP',
    priceCents: P(99_000),
    deliveryDays: 7,
  },
  {
    slug: 'emi-valuation',
    kind: 'emi',
    name: 'EMI Valuation',
    short: 'EMI (UK)',
    tagline: 'Enterprise Management Incentive values, agreed with HMRC.',
    description:
      'Share valuations for UK EMI option schemes — the market-value agreement that fixes your employees’ tax treatment at grant.',
    bullets: [
      'UMV and AMV with discount support',
      'VAL231 preparation and HMRC correspondence support',
      'Fast turnaround to hit your grant window',
    ],
    audience: 'UK startups granting EMI options',
    priceCents: P(99_000),
    deliveryDays: 7,
  },
  {
    slug: 'ifrs-2-valuation',
    kind: 'ifrs2',
    name: 'IFRS 2 Valuation',
    short: 'IFRS 2',
    tagline: 'Share-based payment values under international standards.',
    description:
      'Fair-value measurement of share-based payments under IFRS 2 for companies reporting outside US GAAP.',
    bullets: [
      'Grant-date fair value for equity-settled awards',
      'Multi-jurisdiction support (UK, CA, AU, SG)',
      'Audit-ready methodology documentation',
    ],
    audience: 'IFRS reporters with equity compensation',
    priceCents: P(99_000),
    deliveryDays: 7,
  },
  {
    slug: 'purchase-price-allocation',
    kind: 'ppa',
    name: 'Purchase Price Allocation',
    short: 'PPA',
    tagline: 'Allocate your acquisition, asset by asset.',
    description:
      'ASC 805 purchase price allocations after an acquisition — identifying and valuing intangibles, goodwill, and everything in between.',
    bullets: [
      'Identified intangible valuation (customer lists, tech, trade names)',
      'Goodwill determination and schedules',
      'Coordinated with your auditor’s review',
    ],
    audience: 'Acquirers closing a transaction',
    priceCents: P(99_000),
    deliveryDays: 10,
  },
  {
    slug: 'impairment-testing',
    kind: 'goodwill',
    name: 'Impairment Testing Valuation',
    short: 'Goodwill',
    tagline: 'Test goodwill and long-lived assets, defensibly.',
    description:
      'Goodwill and asset impairment testing under ASC 350/360 — quantitative tests with documented assumptions.',
    bullets: [
      'Reporting-unit fair value determination',
      'Step-one quantitative testing with sensitivity support',
      'Clear documentation for audit review',
    ],
    audience: 'Companies carrying goodwill',
    priceCents: P(99_000),
    deliveryDays: 10,
  },
  {
    slug: 'esop-valuation',
    kind: 'esop',
    name: 'ESOP Valuation',
    short: 'ESOP',
    tagline: 'Annual values for employee-owned companies.',
    description:
      'Valuations for Employee Stock Ownership Plans — initial transactions and the annual updates your trustee requires.',
    bullets: [
      'Trustee-ready annual valuation updates',
      'Transaction support for new ESOPs',
      'DOL-aware methodology and documentation',
    ],
    audience: 'ESOP companies and trustees',
    priceCents: P(99_000),
    deliveryDays: 10,
  },
  {
    slug: 'ip-valuation',
    kind: 'ip',
    name: 'IP Valuation',
    short: 'IP',
    tagline: 'Value a patent, trademark, or software asset.',
    description:
      'Valuation of specific intellectual property — for licensing, transfer pricing, litigation support, or a sale.',
    bullets: [
      'Relief-from-royalty and income approaches',
      'Market royalty-rate benchmarking',
      'Asset-level report for the specific IP',
    ],
    audience: 'IP owners, licensors, and counsel',
    priceCents: P(99_000),
    deliveryDays: 10,
  },
];

export function productBySlug(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

// ── Pricing calculator ────────────────────────────────────────────────────────

export const EXPRESS_DELIVERY_CENTS = 50_000;
export const QSBS_ADDON_CENTS = 50_000;
export const EXPRESS_DELIVERY_DAYS = 1;

export function quote(product: Product, opts: { express: boolean; qsbsLetter: boolean }): {
  totalCents: number;
  deliveryDays: number;
} {
  let totalCents = product.priceCents;
  if (opts.express) totalCents += EXPRESS_DELIVERY_CENTS;
  if (opts.qsbsLetter && product.kind !== 'qsbs') totalCents += QSBS_ADDON_CENTS;
  return {
    totalCents,
    deliveryDays: opts.express ? EXPRESS_DELIVERY_DAYS : product.deliveryDays,
  };
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

// ── "Which valuation?" quiz ───────────────────────────────────────────────────

export interface QuizOption {
  label: string;
  subtitle?: string;
  productSlug: string;
}

export const QUIZ_OPTIONS: QuizOption[] = [
  {
    label: "I'm giving employees stock options and need a price to set them at",
    productSlug: '409a-valuation',
  },
  {
    label: 'I need to report equity compensation on my financial statements',
    productSlug: 'asc-718-valuation',
  },
  {
    label: 'I just acquired, or am acquiring, a company',
    subtitle: 'Allocating the purchase price',
    productSlug: 'purchase-price-allocation',
  },
  {
    label: 'I need to value my business for a loan, sale, or new partner',
    productSlug: 'smb-valuation',
  },
  {
    label: "I'm transferring or gifting company shares",
    subtitle: 'Tax or estate planning',
    productSlug: 'gift-estate-tax-valuation',
  },
  {
    label: 'I run an investment fund and need to value my holdings',
    productSlug: 'asc-820-valuation',
  },
  {
    label: 'I have, or am setting up, an employee stock ownership plan (ESOP)',
    productSlug: 'esop-valuation',
  },
  {
    label: 'I need to value a specific patent, trademark, or software asset',
    productSlug: 'ip-valuation',
  },
  {
    label: 'I need to document QSBS eligibility',
    productSlug: 'qsbs-attestation',
  },
];

// ── Competitor comparisons ────────────────────────────────────────────────────

export interface Comparison {
  slug: string;
  competitor: string;
  category: string;
  summary: string;
  rows: Array<{ dimension: string; us: string; them: string }>;
}

const STANDARD_ROWS = (them: {
  onboarding: string;
  draft: string;
  final: string;
  transparency: string;
}): Comparison['rows'] => [
  {
    dimension: 'Onboarding',
    us: 'Online form + accounting software connect, ~15 minutes',
    them: them.onboarding,
  },
  { dimension: 'First draft', us: '24 hours', them: them.draft },
  { dimension: 'Final report', us: '7 business days (1 day Express)', them: them.final },
  {
    dimension: 'Methodology transparency',
    us: 'Full workbook, overwrites log, and calculation history in-app',
    them: them.transparency,
  },
  {
    dimension: 'Expert sign-off',
    us: 'Credentialed analyst review + dual signatures',
    them: 'Varies',
  },
];

export const COMPARISONS: Comparison[] = [
  {
    slug: 'carta',
    competitor: 'Carta',
    category: 'Cap table & valuation platform',
    summary:
      'Carta bundles 409A valuations with its cap-table subscription. N409 is a dedicated valuation shop: transparent methodology, faster drafts, and no platform lock-in.',
    rows: STANDARD_ROWS({
      onboarding: 'Within their cap-table product; requires subscription',
      draft: 'Days to weeks',
      final: '1–2 weeks, tier-dependent',
      transparency: 'Report only; model internals not exposed',
    }),
  },
  {
    slug: 'pulley',
    competitor: 'Pulley',
    category: 'Cap table platform',
    summary:
      'Pulley offers 409A as an add-on to cap-table management. N409 focuses solely on defensible valuations across 13 product lines.',
    rows: STANDARD_ROWS({
      onboarding: 'Within their cap-table product',
      draft: 'About a week',
      final: '1–3 weeks',
      transparency: 'Report only',
    }),
  },
  {
    slug: 'eqvista',
    competitor: 'Eqvista',
    category: 'Valuation & cap table',
    summary:
      'Eqvista pairs software with valuation services. N409 adds AI-assisted intake, an auditable calculation engine, and client-visible scenario analysis.',
    rows: STANDARD_ROWS({
      onboarding: 'Forms + document upload',
      draft: 'Several days',
      final: '1–2 weeks',
      transparency: 'Report with summary schedules',
    }),
  },
  {
    slug: 'kruze',
    competitor: 'Kruze Consulting',
    category: 'Startup accounting firm',
    summary:
      'Kruze delivers valuations as part of a broader accounting engagement. N409 is self-serve, faster, and priced per report rather than per relationship.',
    rows: STANDARD_ROWS({
      onboarding: 'Email + document back-and-forth',
      draft: 'Weeks',
      final: '4–8 weeks',
      transparency: 'Analyst-prepared report',
    }),
  },
  {
    slug: 'eton',
    competitor: 'Eton Venture Services',
    category: 'Valuation firm',
    summary:
      'Eton is a traditional valuation practice. N409 delivers the same analyst rigor with a modern pipeline: AI extraction, live status, and 24-hour drafts.',
    rows: STANDARD_ROWS({
      onboarding: 'Email + calls',
      draft: '1–2 weeks',
      final: '2–4 weeks',
      transparency: 'Report only',
    }),
  },
  {
    slug: 'aranca',
    competitor: 'Aranca',
    category: 'Valuation & research firm',
    summary:
      'Aranca serves valuations through an offshore research model. N409 keeps everything in one platform with client-visible progress and audit-ready evidence bundles.',
    rows: STANDARD_ROWS({
      onboarding: 'Email + document requests',
      draft: '1–2 weeks',
      final: '2–4 weeks',
      transparency: 'Report only',
    }),
  },
  {
    slug: 'scalar',
    competitor: 'Scalar',
    category: 'Valuation platform',
    summary:
      'Scalar productizes valuations for funds and startups. N409 matches the product experience and adds a transparent engine plus 13 report types under one roof.',
    rows: STANDARD_ROWS({
      onboarding: 'Online forms',
      draft: 'About a week',
      final: '1–2 weeks',
      transparency: 'Summary schedules',
    }),
  },
];

export function comparisonBySlug(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

// ── Landing page content ──────────────────────────────────────────────────────

export const HERO_KINDS = ['409A', 'ASC 820', 'Gift & Estate', 'EMI', 'QSBS', 'ESOP'];

export const STATS = [
  { value: '2×', label: 'faster than a traditional firm' },
  { value: '24h', label: 'to your first draft' },
  { value: '13', label: 'report types, one platform' },
];

export const HOW_IT_WORKS = [
  {
    step: '01',
    title: 'Onboarding form',
    body: 'Answer a quick set of questions, upload select documents, and connect your accounting software — about 15 minutes.',
  },
  {
    step: '02',
    title: 'Draft report',
    body: 'Review a draft within 24 hours. Ask questions, request changes, and see exactly how the numbers were built.',
  },
  {
    step: '03',
    title: 'Final delivery',
    body: 'Analyst-reviewed, dual-signed, audit-defensible final report — standard in 7 business days, Express in 1.',
  },
];

export const ACCOUNTING_PROVIDERS = [
  'QuickBooks',
  'Xero',
  'FreshBooks',
  'Oracle NetSuite',
  'Sage',
  'Wave',
];
