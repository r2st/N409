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
    slug: 'portfolio-valuation',
    kind: 'fund',
    name: 'Portfolio Valuation',
    short: 'Portfolio',
    tagline: 'Mark the whole fund, not one holding at a time.',
    description:
      'Fair value across an entire VC, PE or credit portfolio — every position marked and classified in the ASC 820 hierarchy, rolled up to NAV, and distributed through your LP waterfall.',
    bullets: [
      'Position-level marks with Level 1 / 2 / 3 classification',
      'Level 3 holdings calibrated to the last financing round',
      'Roll-forward of a prior mark to a new measurement date',
      'NAV and an LP waterfall with preferred return, catch-up, carry and clawback',
    ],
    audience: 'Fund managers, fund admins, and LPs',
    // The fallback price the checkout charges for the `fund` kind. Quoted here
    // rather than assumed: a marketing figure the checkout does not honour is
    // the one place on the site it is most expensive to be wrong.
    priceCents: P(99_000),
    deliveryDays: 10,
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
    bullets: ['UMV and AMV determinations', 'HMRC VAL231 support', 'UK market comparables and methodology'],
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

// ── Product-page long-form content (gap #17) ──────────────────────────────────
// The 8-section product template mirrors 409.ai: Hero, Problem (with a cross-link
// to a related product), Solution cards, Process, Included checklist, FAQ, and a
// bottom CTA with a legal disclaimer. Kept separate from the pricing-focused
// PRODUCTS array above so page copy and price data evolve independently.

/** Audit-defence hourly rate shown on the 409A FAQ and the pricing page (gap #33). */
export const AUDIT_DEFENCE_RATE_USD = 175;

export interface FaqItem {
  q: string;
  a: string;
}

export interface ProductProblem {
  headline: string;
  body: string;
  bullets: string[];
  /** Slug of a related product the Problem section cross-links to. */
  relatedSlug: string;
}

export interface ProductSolutionCard {
  title: string;
  body: string;
}

export interface ProductContent {
  /** Short supporting line under the hero headline. */
  heroSubhead: string;
  /** Label for the primary CTA — QSBS uses "Request attestation". */
  ctaLabel: string;
  problem: ProductProblem;
  solution: ProductSolutionCard[];
  included: string[];
  faq: FaqItem[];
  ctaHeadline: string;
  disclaimer: string;
}

/** The three-step pipeline, identical across every product (409.ai §9.1). */
export const PROCESS_STEPS: Array<{ step: string; title: string; body: string }> = [
  {
    step: '01',
    title: 'Intake',
    body: 'Answer a short online questionnaire, upload your key documents, and connect your accounting software. About 15 minutes — no long email threads.',
  },
  {
    step: '02',
    title: 'AI analysis',
    body: 'Our pipeline extracts your financials, builds the cap table, runs every approach, and drafts the narrative — then a credentialed analyst reviews every number.',
  },
  {
    step: '03',
    title: 'Final report',
    body: 'Receive an analyst-reviewed, dual-signed, audit-defensible report — a first draft in 24 hours and the final in days, not weeks.',
  },
];

const DEFAULT_DISCLAIMER =
  'N409 provides independent, third-party valuation services. Reports are prepared for the specific purpose stated in the engagement and are not legal, tax, or investment advice. Consult your own advisors for how a valuation applies to your situation.';

const CTA_START = 'Start my valuation';

export const PRODUCT_CONTENT: Record<string, ProductContent> = {
  '409a-valuation': {
    heroSubhead: 'A safe-harbor 409A valuation your board, your investors, and your auditor can all rely on.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'Priced options wrong, and the tax falls on your team',
      body: 'You need a defensible fair market value before you can grant stock options. Skip it — or lowball it — and the IRS can treat every grant as immediate taxable income under §409A, with penalties landing on your employees.',
      bullets: [
        'A stale or missing 409A stalls option grants and new hires',
        'An indefensible strike price creates 409A penalties for optionees',
        'Auditors and acquirers reject valuations without documented methodology',
      ],
      relatedSlug: 'asc-718-valuation',
    },
    solution: [
      {
        title: 'Safe-harbor qualified',
        body: 'Prepared by credentialed analysts using a repeatable, documented methodology that qualifies for the §409A safe harbor.',
      },
      {
        title: 'OPM backsolve',
        body: 'We backsolve your common value from your most recent priced round, then cross-check with income and market approaches.',
      },
      {
        title: 'DLOM support',
        body: 'Marketability discounts backed by the Chaffee and Finnerty put-option models, fully shown in the report.',
      },
      {
        title: 'Board-ready report',
        body: 'A clean PDF with a complete methodology appendix your board can adopt and your auditor will accept.',
      },
    ],
    included: [
      'Fair market value of common stock under IRC §409A',
      'OPM backsolve plus income and market cross-checks',
      'DLOM analysis (Chaffee and Finnerty models)',
      'Full methodology appendix and calculation history',
      'Audit-defense evidence bundle on request',
    ],
    faq: [
      {
        q: 'What is a 409A valuation?',
        a: 'An independent appraisal of the fair market value of your company’s common stock, used to set the strike price of stock options in compliance with Section 409A of the Internal Revenue Code.',
      },
      {
        q: 'Why do I need one?',
        a: 'You need a defensible fair market value before granting stock options. A valuation that meets the safe-harbor standard shifts the burden to the IRS to prove it unreasonable.',
      },
      {
        q: 'How much does it cost?',
        a: `Our 409A valuations start at ${formatUsd(119_000)} per report, with no subscription or platform lock-in. Express delivery and add-ons are priced transparently in our calculator.`,
      },
      {
        q: 'How long does it take?',
        a: 'You’ll see a first draft within 24 hours and the final report in 7 business days — or 1 business day with Express delivery.',
      },
      {
        q: 'How long is a 409A valuation valid?',
        a: 'Up to 12 months, or until a material event (a new priced round, an acquisition offer, or a significant change in the business) — whichever comes first.',
      },
      {
        q: 'How often do I need a new one?',
        a: 'At least once every 12 months, and again after any material event that could change your common stock’s value.',
      },
      {
        q: 'What methodology do you use?',
        a: 'We apply the option-pricing model (OPM) backsolve against your latest round, cross-checked with income and market approaches, and apply a DLOM using the Finnerty and Chaffee put-option models.',
      },
      {
        q: 'What’s the difference between a 409A and an ASC 718 valuation?',
        a: 'A 409A sets the fair market value for tax and strike-price purposes; ASC 718 measures the fair value of share-based compensation for your financial statements. They use related inputs but serve different rules.',
      },
      {
        q: 'Do you handle companies that have raised a priced round?',
        a: 'Yes. A recent priced round is the strongest input we have — we backsolve your common value directly from it.',
      },
      {
        q: 'What if I already have a prior valuation?',
        a: 'We can roll it forward, reusing prior approaches and updating for what’s changed, which is faster and keeps your history consistent.',
      },
      {
        q: 'How accurate is the data you use?',
        a: 'We build from your real financials — connected accounting software or uploaded statements — with every figure traced to its source document in the report.',
      },
      {
        q: 'Is the valuation audit-defensible?',
        a: 'Yes. Every report ships with a complete methodology appendix and calculation history, and we provide an audit-defense evidence bundle on request.',
      },
      {
        q: 'Do you offer audit defence?',
        a: `Yes. If your auditor or the IRS has questions, our analysts support the valuation at an hourly rate of USD $${AUDIT_DEFENCE_RATE_USD}/hr — well below the $300–$500+/hr typical of accounting firms.`,
      },
      {
        q: 'Who prepares and signs the report?',
        a: 'Credentialed valuation analysts prepare every report, and each is reviewed and dual-signed before delivery.',
      },
    ],
    ctaHeadline: 'Get your 409A valuation started today',
    disclaimer:
      'N409 provides independent, third-party 409A valuation services. A safe-harbor valuation shifts the burden of proof to the IRS but does not guarantee any particular tax outcome. This is not legal or tax advice.',
  },

  'smb-valuation': {
    heroSubhead: 'An independent fair-market-value opinion for your small or medium business.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'You can’t make the deal without a number you can defend',
      body: 'A bank, a buyer, or a departing partner wants to know what the business is worth. A rule-of-thumb multiple off the back of an envelope won’t survive their scrutiny — or yours.',
      bullets: [
        'Lenders and buyers discount valuations they can’t trace',
        'Partner buy-ins and buy-outs turn contentious without an independent number',
        'DIY multiples ignore your real earnings quality and asset base',
      ],
      relatedSlug: 'gift-estate-tax-valuation',
    },
    solution: [
      {
        title: 'Three approaches, weighted',
        body: 'Income, market, and asset approaches weighted to your situation — not a single blunt multiple.',
      },
      {
        title: 'Built from real financials',
        body: 'Connect your accounting software or upload statements; we work from your actual numbers.',
      },
      {
        title: 'Plain-English report',
        body: 'A clear write-up you can hand to a bank, a buyer, or a partner without a translator.',
      },
      {
        title: 'Independent and fast',
        body: 'A credentialed, third-party opinion delivered in days, so your deal keeps moving.',
      },
    ],
    included: [
      'Fair market value opinion for the business',
      'Income, market, and asset approaches with weighting rationale',
      'Normalization of owner add-backs and one-time items',
      'Supporting schedules and methodology',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is an SMB valuation used for?',
        a: 'Financing, a sale or acquisition, buying out or bringing in a partner, succession planning, or simply understanding what your business is worth.',
      },
      {
        q: 'What information do you need?',
        a: 'Two to three years of financial statements or accounting-software access, plus context on the business and any recent transactions.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final report in 7 business days, with a 1-day Express option.',
      },
      {
        q: 'How do you handle owner add-backs?',
        a: 'We normalize earnings for owner compensation, one-time items, and discretionary expenses so the value reflects the business’s true earning power.',
      },
      {
        q: 'Is this a certified appraisal?',
        a: 'It is an independent valuation opinion prepared by credentialed analysts. For IRS gift or estate purposes, see our Gift & Estate Tax product for a qualified appraisal.',
      },
      {
        q: 'How much does it cost?',
        a: `SMB valuations start at ${formatUsd(99_000)} per report, priced per engagement with no subscription.`,
      },
    ],
    ctaHeadline: 'Find out what your business is worth',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'asc-718-valuation': {
    heroSubhead: 'Grant-date fair value for share-based compensation your auditor will accept.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'Stock-comp expense your auditor won’t sign off on',
      body: 'Every option and RSU you grant hits your income statement under ASC 718. Get the grant-date fair value or its inputs wrong and your audit stalls on a restatement risk.',
      bullets: [
        'Auditors reject volatility and expected-term assumptions without support',
        'Manual spreadsheets don’t document how the fair value was built',
        'Restatements are expensive and shake investor confidence',
      ],
      relatedSlug: '409a-valuation',
    },
    solution: [
      {
        title: 'Grant-date fair value',
        body: 'Fair value for options, RSUs, and other awards, computed and documented per ASC 718.',
      },
      {
        title: 'Documented assumptions',
        body: 'Volatility, expected term, and risk-free rate each supported and shown in the report.',
      },
      {
        title: 'Big-4 ready',
        body: 'Built to withstand review by any Big-4 audit team, with a full methodology appendix.',
      },
      {
        title: 'Ties to your 409A',
        body: 'Consistent with your 409A inputs so the two valuations tell one coherent story.',
      },
    ],
    included: [
      'Grant-date fair value of share-based awards',
      'Volatility, expected-term, and rate support',
      'Black-Scholes or lattice modeling as appropriate',
      'Methodology appendix ready for audit',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is ASC 718?',
        a: 'The US GAAP standard governing how companies measure and expense share-based compensation on their financial statements.',
      },
      {
        q: 'How is it different from a 409A?',
        a: 'A 409A sets fair market value for setting strike prices and tax compliance; ASC 718 measures the fair value of awards for financial reporting. We keep the two consistent.',
      },
      {
        q: 'What awards can you value?',
        a: 'Stock options, RSUs, RSAs, ESPPs, SARs, and performance awards with market or service conditions.',
      },
      {
        q: 'How do you support the volatility assumption?',
        a: 'We derive volatility from a peer set of guideline public companies over a term matched to the award’s expected life, documented in the report.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 7 business days, with Express available.',
      },
      {
        q: 'How much does it cost?',
        a: `ASC 718 valuations start at ${formatUsd(149_000)} per report.`,
      },
    ],
    ctaHeadline: 'Get audit-ready stock-comp expense',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'asc-820-valuation': {
    heroSubhead: 'Independent fair-value measurement of investments and financial instruments.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'Level 3 marks your auditor keeps pushing back on',
      body: 'Funds and corporates carrying investments at fair value need defensible marks under ASC 820. Thinly-traded, Level 3 positions are exactly where auditors dig in.',
      bullets: [
        'Level 3 inputs draw the most audit scrutiny',
        'Portfolio marks without documentation invite restatement',
        'Quarter-close timelines leave no room for slow turnarounds',
      ],
      relatedSlug: 'impairment-testing',
    },
    solution: [
      {
        title: 'Level 3 valuations',
        body: 'Fair value of hard-to-value assets with fully documented, defensible inputs.',
      },
      {
        title: 'Instrument-level support',
        body: 'Portfolio-company and instrument-level analysis, not a single blended number.',
      },
      {
        title: 'Audit-ready schedules',
        body: 'Schedules and methodology packaged the way your auditor expects to review them.',
      },
      {
        title: 'Quarter-close speed',
        body: 'Turnarounds that fit a reporting calendar, with Express when the close is tight.',
      },
    ],
    included: [
      'Fair-value measurement under ASC 820',
      'Level 3 asset valuations with documented inputs',
      'Portfolio-company and instrument-level detail',
      'Audit-ready schedules and methodology',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is ASC 820?',
        a: 'The US GAAP standard that defines fair value and sets the framework for measuring and disclosing it, including the Level 1–3 input hierarchy.',
      },
      {
        q: 'Who needs an ASC 820 valuation?',
        a: 'Investment funds, BDCs, and corporates that carry investments or financial instruments at fair value on their financial statements.',
      },
      {
        q: 'What are Level 3 inputs?',
        a: 'Unobservable inputs used when market prices aren’t available — the assets that need the most rigorous, best-documented support.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 7 business days, with Express available for tight closes.',
      },
      {
        q: 'How much does it cost?',
        a: `ASC 820 valuations start at ${formatUsd(149_000)} per report.`,
      },
    ],
    ctaHeadline: 'Get defensible fair-value marks',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'portfolio-valuation': {
    heroSubhead: 'Every position marked, rolled up to NAV, and run through your LP waterfall.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'A portfolio marked one spreadsheet at a time',
      body: 'ASC 820 asks for fair value position by position, but LPs and auditors read the fund: a NAV, a hierarchy split, and a distribution that ties. Assembling that from per-company workbooks each quarter is where the errors and the weeks go.',
      bullets: [
        'Level 3 holdings need calibration to a real financing, not a cost carry',
        'A quarter-on-quarter roll-forward has to explain what moved and why',
        'Carried interest and clawback are arithmetic nobody wants to redo by hand',
      ],
      relatedSlug: 'asc-820-valuation',
    },
    solution: [
      {
        title: 'Position-level marks',
        body: 'Each holding fair-valued by its own method — market, last round, calibrated OPM, or cost — and classified Level 1, 2 or 3.',
      },
      {
        title: 'Calibrated to the last round',
        body: 'A Level 3 mark solved so the model reproduces the price of the most recent financing, the technique the AICPA PE/VC guide describes.',
      },
      {
        title: 'Roll-forward',
        body: 'Carry a prior mark to a new measurement date by re-calibration, accretion, or a public-market-equivalent index movement.',
      },
      {
        title: 'NAV and LP waterfall',
        body: 'Net asset value after fund liabilities, distributed through return of capital, preferred return, GP catch-up, carry, and an end-of-life clawback test.',
      },
    ],
    included: [
      'Fair value for every position, with its method and hierarchy level',
      'Calibration of Level 3 holdings to the latest financing round',
      'Roll-forward from the prior measurement date',
      'Net asset value after fund liabilities',
      'LP waterfall with preferred return, catch-up, carried interest and clawback',
      'Audit-ready schedules, analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'How is this different from an ASC 820 valuation?',
        a: 'ASC 820 here means one instrument or one holding measured at fair value. A portfolio valuation is the whole fund: every position marked, rolled up to NAV, and distributed through the waterfall your LPA specifies.',
      },
      {
        q: 'What does “calibrated to the last round” mean?',
        a: 'The option-pricing model for a holding is solved so that it reproduces the price investors actually paid in its most recent financing. The calibrated model is then used at the measurement date, which is what makes a Level 3 mark supportable rather than asserted.',
      },
      {
        q: 'Can you roll forward marks we already have?',
        a: 'Yes. A prior mark can be carried to a new date by re-calibration, by accretion, or by a public-market-equivalent index movement — whichever the position and the evidence support.',
      },
      {
        q: 'Does the waterfall handle clawback?',
        a: 'Yes, including an end-of-life clawback test, alongside return of capital, the preferred return, the GP catch-up, and carried interest.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 10 business days, depending on the number of positions.',
      },
      {
        q: 'How much does it cost?',
        a: `Portfolio valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Mark your portfolio for this quarter',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'gift-estate-tax-valuation': {
    heroSubhead: 'Qualified appraisals for gifting or bequeathing closely-held shares.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'The IRS can challenge a transfer years after you make it',
      body: 'Gift and estate transfers of closely-held stock hinge on a value the IRS may examine long after filing. A weak appraisal invites adjustment, interest, and penalties.',
      bullets: [
        'Form 709 and 706 filings require a qualified appraisal',
        'Undocumented discounts get disallowed on examination',
        'Penalties and interest compound over the years until an audit',
      ],
      relatedSlug: 'smb-valuation',
    },
    solution: [
      {
        title: 'Qualified appraisal',
        body: 'Meets IRS requirements for gift and estate filings, prepared by credentialed analysts.',
      },
      {
        title: 'Documented discounts',
        body: 'Minority-interest and marketability discounts supported and clearly explained.',
      },
      {
        title: 'Examination support',
        body: 'We stand behind the appraisal if the IRS asks questions during examination.',
      },
      {
        title: 'Planning-friendly',
        body: 'Turnarounds and documentation that fit your estate-planning timeline.',
      },
    ],
    included: [
      'Qualified appraisal for IRS Form 709/706',
      'Minority-interest and marketability discount analysis',
      'Documented valuation approaches and conclusions',
      'Support through IRS examination',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is a qualified appraisal?',
        a: 'An appraisal that meets the IRS’s specific requirements for supporting the value of property reported on a gift or estate tax return.',
      },
      {
        q: 'What discounts apply to closely-held shares?',
        a: 'Typically a discount for lack of control (minority interest) and a discount for lack of marketability (DLOM), each documented and supported.',
      },
      {
        q: 'When do I need this?',
        a: 'Before filing IRS Form 709 (gifts) or Form 706 (estates) that include closely-held business interests.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 7 business days.',
      },
      {
        q: 'How much does it cost?',
        a: `Gift and estate tax valuations start at ${formatUsd(99_000)} per report.`,
      },
    ],
    ctaHeadline: 'Transfer shares with the IRS in mind',
    disclaimer:
      'N409 provides independent, third-party valuation services. Our appraisals are prepared to meet IRS qualified-appraisal requirements but do not constitute legal or tax advice; consult your estate-planning counsel.',
  },

  'qsbs-attestation': {
    heroSubhead: 'Document your Qualified Small Business Stock status under IRC §1202.',
    ctaLabel: 'Request attestation',
    problem: {
      headline: 'A 100% gains exclusion you can’t prove you qualified for',
      body: 'QSBS can exempt up to 100% of the gain on your stock — but only if you can document eligibility at issuance. Years later, at exit, the paperwork is what stands between you and the exclusion.',
      bullets: [
        'The gross-asset test must be met at the time of issuance',
        'Active-business requirements are easy to fail without records',
        'Investors’ tax advisors demand contemporaneous documentation',
      ],
      relatedSlug: '409a-valuation',
    },
    solution: [
      {
        title: 'Gross-asset test',
        body: 'Documentation that your company met the $50M gross-asset threshold at issuance.',
      },
      {
        title: 'Active-business analysis',
        body: 'Analysis confirming the active-business requirement of §1202 is satisfied.',
      },
      {
        title: 'Investor-ready letter',
        body: 'An attestation letter in the format your investors’ tax advisors expect.',
      },
      {
        title: 'Contemporaneous record',
        body: 'A dated, defensible record you can produce years later at exit.',
      },
    ],
    included: [
      'Gross-asset test documentation at issuance',
      'Active-business requirement analysis',
      'QSBS eligibility attestation letter',
      'Supporting schedules and references to §1202',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is QSBS?',
        a: 'Qualified Small Business Stock under IRC §1202 — stock that, if it meets the requirements, can exclude up to 100% of the gain on a later sale from federal tax.',
      },
      {
        q: 'What does the attestation cover?',
        a: 'It documents that your company met the gross-asset and active-business tests at the time the stock was issued.',
      },
      {
        q: 'When should I get one?',
        a: 'Ideally close to issuance, while the records are fresh — but any time before an exit is better than reconstructing it later.',
      },
      {
        q: 'How did the OBBBA changes affect QSBS?',
        a: 'Recent legislation adjusted the thresholds and holding-period tiers; our analysis reflects the current §1202 rules that apply to your issuance date.',
      },
      {
        q: 'How much does it cost?',
        a: `QSBS attestations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Document your §1202 eligibility',
    disclaimer:
      'N409 provides independent, third-party attestation services. A QSBS attestation documents eligibility but does not guarantee any tax outcome and is not legal or tax advice; consult your tax advisor.',
  },

  'csop-valuation': {
    heroSubhead: 'HMRC-ready share values for UK Company Share Option Plans.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'A CSOP grant priced without an agreed value',
      body: 'UK CSOP options must be granted at a market value HMRC will accept. Grant against a number you can’t defend and you risk the plan’s tax advantages.',
      bullets: [
        'Options must be granted at no less than market value',
        'An unsupported value jeopardises CSOP tax relief',
        'Grant windows are tight and can’t wait weeks for a valuation',
      ],
      relatedSlug: 'emi-valuation',
    },
    solution: [
      {
        title: 'UMV and AMV',
        body: 'Unrestricted and actual market value determinations prepared for HMRC agreement.',
      },
      {
        title: 'VAL231 support',
        body: 'Documentation to support your HMRC VAL231 submission.',
      },
      {
        title: 'UK comparables',
        body: 'UK market comparables and methodology appropriate to your company.',
      },
      {
        title: 'Fast turnaround',
        body: 'Delivered in time to hit your grant window.',
      },
    ],
    included: [
      'UMV and AMV determinations for CSOP',
      'HMRC VAL231 supporting documentation',
      'UK market comparables and methodology',
      'Grant-ready valuation report',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is a CSOP?',
        a: 'A UK Company Share Option Plan — a tax-advantaged share option scheme with a statutory limit on the value of options an employee can hold.',
      },
      {
        q: 'What is the difference between UMV and AMV?',
        a: 'Unrestricted market value ignores restrictions on the shares; actual market value reflects them. Both are relevant to CSOP grants and HMRC agreement.',
      },
      {
        q: 'Do you liaise with HMRC?',
        a: 'We prepare the VAL231 supporting documentation you need for your submission to HMRC.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 7 business days, with Express to meet a grant window.',
      },
      {
        q: 'How much does it cost?',
        a: `CSOP valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Value your CSOP for HMRC',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'emi-valuation': {
    heroSubhead: 'Enterprise Management Incentive share values, agreed with HMRC.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'EMI options that lose their tax advantage at grant',
      body: 'EMI is the UK’s most generous share scheme — but only if the grant value is agreed with HMRC. Miss that and your team loses the tax treatment that made the options worth offering.',
      bullets: [
        'EMI relief depends on an HMRC-agreed market value',
        'A wrong value at grant can’t be fixed after the fact',
        'Grant windows and funding rounds create hard deadlines',
      ],
      relatedSlug: 'csop-valuation',
    },
    solution: [
      {
        title: 'UMV and AMV',
        body: 'Both market-value measures, with discount support appropriate to your shares.',
      },
      {
        title: 'VAL231 preparation',
        body: 'We prepare the VAL231 and support your HMRC correspondence.',
      },
      {
        title: 'Discount support',
        body: 'Minority and marketability discounts documented for HMRC scrutiny.',
      },
      {
        title: 'Hit your window',
        body: 'Fast turnaround so you can grant inside your intended window.',
      },
    ],
    included: [
      'UMV and AMV with discount support',
      'HMRC VAL231 preparation',
      'HMRC correspondence support',
      'Grant-ready valuation report',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is EMI?',
        a: 'Enterprise Management Incentives — a UK tax-advantaged share option scheme for qualifying smaller companies, with generous treatment for employees.',
      },
      {
        q: 'Why agree the value with HMRC?',
        a: 'Agreeing the market value at grant fixes your employees’ tax position and removes uncertainty later.',
      },
      {
        q: 'How long does an agreed value last?',
        a: 'An HMRC agreement is typically valid for 90 days, so timing the grant matters — we help you plan around it.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 7 business days, with Express available.',
      },
      {
        q: 'How much does it cost?',
        a: `EMI valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Value your EMI options for HMRC',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'ifrs-2-valuation': {
    heroSubhead: 'Share-based payment values under international accounting standards.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'Equity comp your IFRS auditor won’t accept',
      body: 'If you report under IFRS rather than US GAAP, share-based payments fall under IFRS 2. The measurement is unforgiving, and multi-jurisdiction awards multiply the complexity.',
      bullets: [
        'IFRS 2 measurement differs from US GAAP in key details',
        'Multi-jurisdiction awards need consistent, defensible inputs',
        'Auditors reject assumptions without documented support',
      ],
      relatedSlug: 'asc-718-valuation',
    },
    solution: [
      {
        title: 'Grant-date fair value',
        body: 'Fair value of equity-settled awards measured per IFRS 2.',
      },
      {
        title: 'Multi-jurisdiction',
        body: 'Support across UK, CA, AU, and SG with consistent methodology.',
      },
      {
        title: 'Documented inputs',
        body: 'Volatility, term, and rate assumptions each supported in the report.',
      },
      {
        title: 'Audit-ready',
        body: 'Methodology documentation prepared for international audit review.',
      },
    ],
    included: [
      'Grant-date fair value under IFRS 2',
      'Equity-settled award modeling',
      'Multi-jurisdiction support (UK, CA, AU, SG)',
      'Audit-ready methodology documentation',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is IFRS 2?',
        a: 'The international financial reporting standard governing the measurement and recognition of share-based payment transactions.',
      },
      {
        q: 'How is it different from ASC 718?',
        a: 'IFRS 2 and ASC 718 address the same economic events but differ in some measurement and classification details; we apply the standard your reporting requires.',
      },
      {
        q: 'Which jurisdictions do you support?',
        a: 'We regularly prepare IFRS 2 valuations for companies reporting in the UK, Canada, Australia, and Singapore.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 7 business days.',
      },
      {
        q: 'How much does it cost?',
        a: `IFRS 2 valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Value share-based payments under IFRS 2',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'purchase-price-allocation': {
    heroSubhead: 'Allocate your acquisition across intangibles, goodwill, and the rest.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'An acquisition your auditor won’t let you book',
      body: 'After a deal closes, ASC 805 requires you to identify and value what you bought — customer relationships, technology, trade names, goodwill. Get it wrong and your post-close financials don’t clear audit.',
      bullets: [
        'Intangibles must be identified and valued separately from goodwill',
        'Auditors scrutinise PPA assumptions closely',
        'A late or weak PPA delays your post-close reporting',
      ],
      relatedSlug: 'impairment-testing',
    },
    solution: [
      {
        title: 'Intangible valuation',
        body: 'Customer lists, technology, and trade names valued with appropriate methods.',
      },
      {
        title: 'Goodwill determination',
        body: 'Residual goodwill calculated and supported with clear schedules.',
      },
      {
        title: 'Auditor coordination',
        body: 'We work with your auditor’s review so the allocation clears the first time.',
      },
      {
        title: 'ASC 805 compliant',
        body: 'Methodology aligned to the standard your auditor applies.',
      },
    ],
    included: [
      'Identified intangible asset valuations',
      'Goodwill determination and schedules',
      'ASC 805 methodology and support',
      'Coordination with your audit team',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is a purchase price allocation?',
        a: 'The process, required under ASC 805, of allocating the price you paid in an acquisition across the identifiable assets acquired, including intangibles and goodwill.',
      },
      {
        q: 'What intangibles do you value?',
        a: 'Commonly customer relationships, developed technology, trade names, non-compete agreements, and backlog, depending on the business.',
      },
      {
        q: 'Do you coordinate with our auditor?',
        a: 'Yes. We work directly with your audit team’s review comments so the allocation clears the first time rather than bouncing back for rework.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 10 business days, given the additional analysis a PPA involves.',
      },
      {
        q: 'How much does it cost?',
        a: `Purchase price allocations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Allocate your acquisition, asset by asset',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'impairment-testing': {
    heroSubhead: 'Test goodwill and long-lived assets, defensibly, under ASC 350/360.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'Goodwill you may be carrying too high',
      body: 'When indicators point to impairment, ASC 350/360 requires a quantitative test. Skip it or run it loosely and your auditor — or the market — questions your balance sheet.',
      bullets: [
        'Triggering events force a quantitative impairment test',
        'Reporting-unit fair value needs documented assumptions',
        'A weak test invites restatement and investor doubt',
      ],
      relatedSlug: 'asc-820-valuation',
    },
    solution: [
      {
        title: 'Reporting-unit value',
        body: 'Fair value of the reporting unit, built from documented assumptions.',
      },
      {
        title: 'Step-one testing',
        body: 'Quantitative step-one testing with sensitivity analysis.',
      },
      {
        title: 'Clear documentation',
        body: 'Support packaged the way audit review expects to see it.',
      },
      {
        title: 'Defensible conclusions',
        body: 'Impairment conclusions you can stand behind under scrutiny.',
      },
    ],
    included: [
      'Reporting-unit fair value determination',
      'Step-one quantitative impairment testing',
      'Sensitivity analysis on key assumptions',
      'Audit-ready documentation',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'When is impairment testing required?',
        a: 'When triggering events or circumstances indicate that goodwill or long-lived assets may be carried above their recoverable value.',
      },
      {
        q: 'What standards apply?',
        a: 'ASC 350 for goodwill and indefinite-lived intangibles, and ASC 360 for long-lived assets to be held and used.',
      },
      {
        q: 'How is the reporting unit’s fair value determined?',
        a: 'We build the reporting-unit fair value from documented income and market assumptions, then run a sensitivity analysis so you can see how the conclusion holds up under different inputs.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 10 business days.',
      },
      {
        q: 'How much does it cost?',
        a: `Impairment testing valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Test your goodwill, defensibly',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'esop-valuation': {
    heroSubhead: 'Annual and transaction values for employee-owned companies.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'An ESOP the DOL could second-guess',
      body: 'ESOP transactions and their annual updates sit under a DOL-aware fiduciary lens. A valuation your trustee can’t defend is a compliance problem waiting to surface.',
      bullets: [
        'Annual updates are required for ESOP-owned shares',
        'DOL scrutiny of ESOP transactions is real and rising',
        'Trustees need independent, defensible support',
      ],
      relatedSlug: '409a-valuation',
    },
    solution: [
      {
        title: 'Annual updates',
        body: 'Trustee-ready annual valuation updates on a reliable cadence.',
      },
      {
        title: 'Transaction support',
        body: 'Independent support for new ESOP transactions.',
      },
      {
        title: 'DOL-aware',
        body: 'Methodology and documentation prepared with DOL expectations in mind.',
      },
      {
        title: 'Independent opinion',
        body: 'A credentialed, third-party opinion your trustee can rely on.',
      },
    ],
    included: [
      'Annual ESOP valuation update',
      'Transaction support for new ESOPs',
      'DOL-aware methodology and documentation',
      'Supporting schedules and conclusions',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What is an ESOP valuation?',
        a: 'An independent valuation of the shares held by an Employee Stock Ownership Plan, required for the initial transaction and updated annually thereafter.',
      },
      {
        q: 'Why does the DOL care?',
        a: 'The Department of Labor oversees ESOP fiduciary duties, and the price paid for shares is central to whether the plan acted for the benefit of participants.',
      },
      {
        q: 'How often is a valuation needed?',
        a: 'At least annually for an ongoing ESOP, plus at the time of any transaction.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 10 business days.',
      },
      {
        q: 'How much does it cost?',
        a: `ESOP valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Value your ESOP with confidence',
    disclaimer: DEFAULT_DISCLAIMER,
  },

  'ip-valuation': {
    heroSubhead: 'Value a patent, trademark, or software asset for a real decision.',
    ctaLabel: CTA_START,
    problem: {
      headline: 'An intangible asset you can’t put a number on',
      body: 'Licensing, transfer pricing, litigation, or a sale — each needs a defensible value for a specific piece of IP. General business valuations don’t answer the asset-level question.',
      bullets: [
        'Licensing and transfer pricing hinge on a supportable royalty',
        'Litigation demands a methodology that survives cross-examination',
        'A sale stalls without an independent asset-level value',
      ],
      relatedSlug: 'purchase-price-allocation',
    },
    solution: [
      {
        title: 'Relief-from-royalty',
        body: 'Relief-from-royalty and income approaches suited to the asset.',
      },
      {
        title: 'Royalty benchmarking',
        body: 'Market royalty-rate benchmarking to support the analysis.',
      },
      {
        title: 'Asset-level report',
        body: 'A focused report on the specific IP, not the whole business.',
      },
      {
        title: 'Purpose-fit',
        body: 'Tailored to licensing, transfer pricing, litigation, or a sale.',
      },
    ],
    included: [
      'Valuation of the specific IP asset',
      'Relief-from-royalty and income approaches',
      'Market royalty-rate benchmarking',
      'Asset-level report and methodology',
      'Analyst review and dual signatures',
    ],
    faq: [
      {
        q: 'What kinds of IP do you value?',
        a: 'Patents, trademarks, copyrights, developed software, and other identifiable intangible assets.',
      },
      {
        q: 'What methods do you use?',
        a: 'Most often the relief-from-royalty method and other income approaches, supported by market royalty-rate benchmarking.',
      },
      {
        q: 'Can this support litigation or transfer pricing?',
        a: 'Yes — we tailor the analysis and documentation to the specific purpose, including licensing, transfer pricing, and litigation support.',
      },
      {
        q: 'How long does it take?',
        a: 'A first draft in 24 hours and the final in 10 business days.',
      },
      {
        q: 'How much does it cost?',
        a: `IP valuations start at ${formatUsd(99_000)}.`,
      },
    ],
    ctaHeadline: 'Value your IP asset',
    disclaimer: DEFAULT_DISCLAIMER,
  },
};

export function productContent(slug: string): ProductContent | undefined {
  return PRODUCT_CONTENT[slug];
}

// ── Pricing calculator ────────────────────────────────────────────────────────

export const EXPRESS_DELIVERY_CENTS = 50_000;
export const QSBS_ADDON_CENTS = 50_000;
export const EXPRESS_DELIVERY_DAYS = 1;

/**
 * Capital-raised bands — the public mirror of the valuation service's
 * `domain/pricing.ts` RAISE_BANDS. Keep the uplifts identical: this is the
 * quote a prospect reads before signing up, and the checkout recomputes it
 * server-side from the same ladder. A drift here is a customer configuring
 * one price on /pricing and being charged another at the Stripe page.
 */
export const RAISE_BANDS: Array<{ label: string; upliftCents: number }> = [
  { label: 'Under $1M', upliftCents: 0 },
  { label: '$1M – $5M', upliftCents: 50_000 },
  { label: '$5M – $10M', upliftCents: 110_000 },
  { label: '$10M – $20M', upliftCents: 170_000 },
  { label: '$20M+', upliftCents: 230_900 },
];

export function quote(
  product: Product,
  opts: { express: boolean; qsbsLetter: boolean; raiseBand?: number },
): {
  totalCents: number;
  deliveryDays: number;
  bandUpliftCents: number;
} {
  // Clamped rather than trusted: the slider is the only caller today, but an
  // out-of-range index would otherwise quote NaN on the page a prospect reads.
  const index = Math.min(Math.max(Math.trunc(opts.raiseBand ?? 0), 0), RAISE_BANDS.length - 1);
  const bandUpliftCents = RAISE_BANDS[index]!.upliftCents;
  let totalCents = product.priceCents + bandUpliftCents;
  if (opts.express) totalCents += EXPRESS_DELIVERY_CENTS;
  if (opts.qsbsLetter && product.kind !== 'qsbs') totalCents += QSBS_ADDON_CENTS;
  return {
    totalCents,
    deliveryDays: opts.express ? EXPRESS_DELIVERY_DAYS : product.deliveryDays,
    bandUpliftCents,
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
    subtitle: 'A single position or instrument',
    productSlug: 'asc-820-valuation',
  },
  {
    label: 'I need to mark a whole fund portfolio and report NAV to my LPs',
    subtitle: 'Every position, rolled up through the waterfall',
    productSlug: 'portfolio-valuation',
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

// ── Compare provider hub (gap #30) ────────────────────────────────────────────
// The overview page at /compare/409a-valuation-providers categorises the market
// into model types and links out to each individual comparison page above.

/** A named provider; `slug` links to an individual /compare/:slug page when one exists. */
export interface HubProvider {
  name: string;
  slug?: string;
}

export interface ProviderCategory {
  title: string;
  description: string;
  /** One-line summary of the trade-off founders make with this model. */
  tradeoff: string;
  providers: HubProvider[];
}

export const PROVIDER_CATEGORIES: ProviderCategory[] = [
  {
    title: 'AI-native valuation platforms',
    description:
      'Purpose-built valuation shops that use AI to extract your data and draft the report, then have credentialed analysts review and sign it. Fast, transparent, and priced per report.',
    tradeoff: 'Newest model — choose one that exposes its methodology and backs it with real analysts.',
    providers: [{ name: 'N409' }],
  },
  {
    title: 'Cap-table & equity platforms',
    description:
      'Equity-management products that offer a 409A as an add-on to a cap-table subscription. Convenient if you already live in the platform, but the valuation is a side feature.',
    tradeoff: 'Bundled with a subscription; methodology internals are rarely exposed.',
    providers: [
      { name: 'Carta', slug: 'carta' },
      { name: 'Pulley', slug: 'pulley' },
      { name: 'Eqvista', slug: 'eqvista' },
    ],
  },
  {
    title: 'Bundled valuation providers',
    description:
      'Platforms that productise valuations for funds and startups with an online intake and standardised reports, sitting between a pure software product and a traditional firm.',
    tradeoff: 'Product experience varies; confirm you get analyst review and audit support.',
    providers: [{ name: 'Scalar', slug: 'scalar' }],
  },
  {
    title: 'Startup CPA & accounting firms',
    description:
      'Accounting firms that deliver a 409A as part of a broader bookkeeping or tax engagement. Good if you want one relationship for everything, at a firm’s pace and price.',
    tradeoff: 'Priced per relationship, not per report; turnaround is measured in weeks.',
    providers: [{ name: 'Kruze Consulting', slug: 'kruze' }],
  },
  {
    title: 'Independent valuation firms',
    description:
      'Traditional, analyst-led valuation practices. Deep rigor and a human relationship, but slower onboarding and longer turnarounds than a modern pipeline.',
    tradeoff: 'Highest-touch and often highest-cost; email-and-calls onboarding.',
    providers: [
      { name: 'Eton Venture Services', slug: 'eton' },
      { name: 'Aranca', slug: 'aranca' },
    ],
  },
];

/** "What founders should ask" — questions to put to any 409A provider. */
export interface FounderQuestion {
  q: string;
  why: string;
}

export const FOUNDER_QUESTIONS: FounderQuestion[] = [
  {
    q: 'Is the valuation prepared under the §409A safe harbor?',
    why: 'A safe-harbor valuation shifts the burden of proof to the IRS. Anything less leaves you exposed.',
  },
  {
    q: 'Who reviews and signs the report?',
    why: 'Credentialed analyst review and a signature are what make a report defensible in an audit.',
  },
  {
    q: 'Can I see the methodology and the underlying calculations?',
    why: 'A transparent, auditable workbook means you can answer questions later; a black box can’t.',
  },
  {
    q: 'How fast is the first draft, and the final report?',
    why: 'Grant windows and board dates are real deadlines — weeks-long turnarounds can cost you hires.',
  },
  {
    q: 'What does audit defence cost if my auditor has questions?',
    why: `Rates range widely — N409 supports the valuation at $${AUDIT_DEFENCE_RATE_USD}/hr versus $300–$500+/hr at many firms.`,
  },
  {
    q: 'Is the valuation tied to a subscription or platform?',
    why: 'Per-report pricing with no lock-in keeps you free to move; a bundled model may not.',
  },
];

// ── Landing page content ──────────────────────────────────────────────────────

export const HERO_KINDS = ['409A', 'ASC 820', 'Gift & Estate', 'EMI', 'QSBS', 'ESOP'];

/**
 * Landing-page stat strip. Every figure here is a *verifiable product fact* —
 * the catalogue's own floor price, our published draft SLA, the number of
 * report types we actually ship. Comparative claims ("2× faster than a
 * traditional firm") are deliberately absent: they sit directly above our
 * competitor comparison pages, and an unsubstantiated advertising comparison is
 * exactly the kind of claim we would have to withdraw. Substantiate first, then
 * add. `MIN_PRODUCT_PRICE_CENTS` derives from PRODUCTS so the headline number
 * can never drift from the price the checkout charges.
 */
export const MIN_PRODUCT_PRICE_CENTS = Math.min(...PRODUCTS.map((p) => p.priceCents));

export const STATS = [
  { value: '24h', label: 'to your first draft' },
  { value: String(PRODUCTS.length), label: 'report types, one platform' },
  { value: `$${(MIN_PRODUCT_PRICE_CENTS / 100).toLocaleString('en-US')}`, label: 'flat, from' },
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

export const ACCOUNTING_PROVIDERS = ['QuickBooks', 'Xero', 'FreshBooks', 'Oracle NetSuite', 'Sage', 'Wave'];

// ── Customer testimonials (409.ai gap #20) ────────────────────────────────────

export interface Testimonial {
  quote: string;
  name: string;
  role: string;
  company: string;
  /** Two-letter monogram rendered in the logo placeholder. */
  monogram: string;
}

/**
 * Real, permissioned customer quotes only — and therefore empty until we have
 * some. This list previously held three invented quotes attributed to named
 * people at invented companies under the heading "Hear it from our customers".
 * On a live site that is a fabricated endorsement (FTC 16 CFR §255), and it is
 * the single fastest way to lose a finance buyer who checks whether the
 * companies exist. `TestimonialsSection` renders nothing while this is empty,
 * and the landing page shows verifiable product proof instead.
 *
 * To add one: get written permission covering the quote, the person's name and
 * role, and the company name, then append it here.
 */
export const TESTIMONIALS: Testimonial[] = [];

// ── Accounting integrations strip (409.ai gap #21) ────────────────────────────
// These are the accounting packages we *connect to*, not customers or partners
// — the strip is labelled accordingly. Real vendor logos are trademarked, so we
// render neutral text badges rather than shipping third-party marks.

export interface PartnerLogo {
  name: string;
  /** Tailwind text colour class for the badge wordmark. */
  accent: string;
}

export const PARTNER_LOGOS: PartnerLogo[] = [
  { name: 'Xero', accent: 'text-sky-600' },
  { name: 'QuickBooks', accent: 'text-bond-600' },
  { name: 'FreshBooks', accent: 'text-emerald-600' },
  { name: 'NetSuite', accent: 'text-indigo-600' },
  { name: 'Sage', accent: 'text-teal-600' },
  { name: 'Wave', accent: 'text-cyan-600' },
];

/**
 * Verifiable proof points shown in place of testimonials. Each one describes
 * something the delivered report actually contains, so it needs no third-party
 * attestation to stand behind.
 */
export const PROOF_POINTS: Array<{ title: string; body: string }> = [
  {
    title: 'Dual analyst sign-off',
    body: 'Every report is prepared and independently reviewed by credentialed analysts, then signed by both. No report leaves the platform on a model alone.',
  },
  {
    title: 'Every number traces to a source',
    body: 'The workbook ships with the report: each figure links back to the document, connected ledger, or model assumption it came from — the trail an auditor asks for.',
  },
  {
    title: 'Methodology in the open',
    body: 'Income, market, and asset approaches, the OPM backsolve, and the DLOM models are all documented in the appendix with their inputs. Nothing is a black box.',
  },
];

export const DEMO_VIDEO_TITLE = 'N409 product demo';

// ── Pricing FAQ (409.ai §24 — FAQ structured data) ────────────────────────────
// Source for the pricing page's FAQPage JSON-LD. Kept in the data module so the
// same content can back a visible accordion later (gap #31).

export interface FaqEntry {
  q: string;
  a: string;
}

export const PRICING_FAQ: FaqEntry[] = [
  {
    q: 'How much does a 409A valuation cost?',
    a: 'A standard 409A valuation starts at $1,190 with a 7-business-day turnaround. Express delivery (1 business day) is available as a $500 add-on. Other report types are priced per product on each product page.',
  },
  {
    q: 'How is pricing structured across report types?',
    a: 'Every report is a single flat price — no subscription, no per-seat fees, no platform lock-in. The price you configure in the calculator is exactly what checkout charges.',
  },
  {
    q: 'Do you offer express delivery?',
    a: 'Yes. Express delivery returns your final report in 1 business day instead of the standard 7, for a $500 add-on. Your first draft still arrives within 24 hours either way.',
  },
  {
    q: 'Do you offer bundles or discounts for multiple reports?',
    a: 'Companies that need several reports — for example a 409A alongside an ASC 718 valuation — or firms placing volume through our partner programme can contact us for bundled pricing.',
  },
  {
    q: 'What is a 409A valuation?',
    a: 'An independent appraisal of the fair market value of your common stock, used to set the strike price of employee stock options in compliance with Section 409A of the Internal Revenue Code.',
  },
  {
    q: 'How long does a valuation take?',
    a: 'You receive a draft within 24 hours and an analyst-reviewed, dual-signed final report in 7 business days on the standard plan, or 1 business day with Express delivery.',
  },
  {
    q: 'How long is a 409A valuation valid?',
    a: 'A 409A valuation is generally valid for 12 months, or until a material event such as a new financing round, whichever comes first.',
  },
  {
    q: 'How often do I need a new valuation?',
    a: 'At least once every 12 months, and again after any material event — a new priced round, an acquisition offer, or a significant change in the business — that could change your common stock’s value.',
  },
  {
    q: 'Do you value public as well as private companies?',
    a: 'Our valuations are built for privately held companies. Public-company share values come from the market; if you hold public securities as part of a portfolio, our ASC 820 product covers fair-value measurement.',
  },
  {
    q: 'What methodology do you use?',
    a: 'We apply the income, market, and asset approaches as appropriate, with an OPM backsolve against your latest round and DLOM support using the Chaffee and Finnerty put-option models — all documented in a transparent, auditable workbook.',
  },
  {
    q: 'What is the difference between a 409A and an ASC 718 valuation?',
    a: 'A 409A sets the fair market value used to price option grants for tax purposes; ASC 718 measures the fair value of share-based compensation for your financial statements. They use related inputs but serve different rules — we keep the two consistent.',
  },
  {
    q: 'Can you use my prior valuation?',
    a: 'Yes. If you have a prior valuation we can roll it forward, reusing prior approaches and updating for what has changed. It is faster and keeps your valuation history consistent.',
  },
  {
    q: 'How accurate is the data you use?',
    a: 'We build from your real financials — connected accounting software or uploaded statements — and every figure is traced to its source document in the report, so nothing is assumed.',
  },
  {
    q: 'Is the valuation audit-defensible?',
    a: 'Yes. Every report is prepared by credentialed analysts, dual-signed, and ships with a full methodology appendix and an evidence bundle so it withstands Big-4 audit review.',
  },
  {
    q: 'Do you offer audit defence support?',
    a: `Yes. If your auditor or the IRS has questions, our analysts support the valuation at an hourly rate of USD $${AUDIT_DEFENCE_RATE_USD}/hr — well below the $300–$500+/hr typical of accounting firms. Report revisions during the draft cycle are always included at no extra cost.`,
  },
  {
    q: 'What if I need help choosing the right report?',
    a: 'Take our 30-second “Which valuation?” quiz, or book a call with our team. We’ll point you to the right product before you pay for anything.',
  },
];

// ── Educational guides (409.ai parity: guide / when / cost) ───────────────────

/**
 * Content for the three long-form educational pages.
 *
 * These exist because a founder searching "how much does a 409A cost" is
 * pre-purchase and will not find the answer on /pricing, which is a
 * configurator rather than an explanation. 409.ai ranks on exactly these three
 * queries; we had the product pages and none of the teaching.
 *
 * Kept as data rather than JSX for the same reason `PRODUCTS` is: the pages
 * render it, `pageMeta` derives FAQ structured data from it, and the tests
 * assert on it without mounting a component. Every *price* referenced here is
 * derived from the constants above at render time — never a literal — so a
 * pricing change cannot leave a stale number in the prose.
 */
export interface GuideSection {
  heading: string;
  body: string;
  bullets?: string[];
}

/** `/409a-valuation-guide` — the long-form explainer. */
export const GUIDE_SECTIONS: GuideSection[] = [
  {
    heading: 'What a 409A valuation actually is',
    body: 'A 409A valuation is an independent appraisal of the fair market value of a private company’s common stock. Section 409A of the Internal Revenue Code governs deferred compensation, and a stock option granted with a strike price below fair market value is deferred compensation in the eyes of the IRS. The valuation is what establishes that your strike price was set correctly on the day you granted.',
  },
  {
    heading: 'Why the safe harbor is the whole point',
    body: 'The statute does not require a valuation — it requires that your strike price be reasonable. What an independent appraisal buys you is the safe harbor: a presumption of reasonableness that shifts the burden of proof onto the IRS. Without it, you carry the burden of showing your number was defensible, years later, with the company’s records as they exist then.',
    bullets: [
      'Independent appraisal performed no more than 12 months before the grant',
      'No material event since the valuation date',
      'Reasonable application of a reasonable valuation method',
    ],
  },
  {
    heading: 'How the value is actually derived',
    body: 'Three approaches are recognised, and a defensible report does not simply pick one. The enterprise value is established, then allocated across the capital structure, then discounted for the fact that common stock in a private company cannot readily be sold.',
    bullets: [
      'Market approach — guideline public companies and comparable transactions',
      'Income approach — discounted cash flow, with a WACC built from observable inputs',
      'Asset approach — net asset value, used where earnings do not yet carry the business',
      'Allocation — OPM, backsolve to the latest priced round, PWERM or a hybrid',
      'DLOM — a discount for lack of marketability, supported by put-option models (Chaffee, Finnerty)',
    ],
  },
  {
    heading: 'What you need to hand over',
    body: 'The inputs are ordinary company records. The work of a valuation is in the judgment applied to them, not in the difficulty of collecting them, and a good provider does most of the assembly for you.',
    bullets: [
      'Capitalisation table, including all option grants and any convertible instruments',
      'Historical financial statements and a forward forecast',
      'The most recent priced-round documents and term sheet',
      'Any material events since — a new round, an acquisition offer, a pivot, a large customer loss',
    ],
  },
  {
    heading: 'How long it lasts',
    body: 'A valuation supports grants for 12 months, or until a material event, whichever comes first. The 12-month rule is the one founders remember; the material-event rule is the one that catches them out, because closing a priced round invalidates the valuation immediately and every option granted after it is exposed until a new one is in place.',
  },
  {
    heading: 'What a finished report contains',
    body: 'A report that will survive an audit shows its work. Ours runs to a full methodology appendix with the exhibits that let a reviewer reconstruct the conclusion rather than take it on faith — the cap-table detail, the approach weighting, the DCF and its WACC build-up, the guideline company set, and the allocation waterfall.',
  },
];

/** `/when-do-you-need-a-409a` — the trigger list. */
export interface ValuationTrigger {
  title: string;
  body: string;
  /** 'required' triggers leave you exposed if ignored; 'recommended' are hygiene. */
  urgency: 'required' | 'recommended';
}

export const VALUATION_TRIGGERS: ValuationTrigger[] = [
  {
    title: 'Before you grant your first stock option',
    body: 'The first grant is the first moment a strike price exists, and it needs support on the day it is set — not retroactively once someone asks. This is the single most common gap: an early team is granted options on a number chosen at a board meeting, and the valuation is commissioned a year later.',
    urgency: 'required',
  },
  {
    title: 'Every 12 months, without exception',
    body: 'The safe harbor requires the appraisal be no more than 12 months old at the date of grant. A valuation that has aged past its window supports nothing, even if nothing about the business has changed.',
    urgency: 'required',
  },
  {
    title: 'After closing a priced round',
    body: 'A priced round is the clearest material event there is — the market has just told you what your preferred stock is worth. Any valuation predating the close is invalid from the moment it closes, and grants made in the gap are the ones that surface in diligence.',
    urgency: 'required',
  },
  {
    title: 'After any other material event',
    body: 'An acquisition offer, a significant pivot, the loss or win of a business-defining customer, a secondary transaction in your own stock, or a substantial miss against the forecast the last valuation relied on. The test is whether the event would change what a buyer would pay.',
    urgency: 'required',
  },
  {
    title: 'Before a fundraise or an exit process',
    body: 'Not a statutory trigger, but a practical one. Diligence will examine your grant history, and a clean, unbroken run of valuations covering every grant date is far cheaper to produce now than to reconstruct under a deal timeline.',
    urgency: 'recommended',
  },
  {
    title: 'Before an audit or a QSBS claim',
    body: 'Your auditor will test stock-based compensation expense against the valuation, and a Section 1202 QSBS position rests on facts a valuation is well placed to evidence. Both go more smoothly when the supporting work already exists.',
    urgency: 'recommended',
  },
];

/**
 * What non-compliance actually costs the *employee* — which is the part
 * founders consistently underestimate, because the penalty does not land on
 * the company that set the price.
 */
export const NONCOMPLIANCE_CONSEQUENCES: string[] = [
  'The discount is taxed as ordinary income as it vests — not at exercise, and not at sale',
  'A 20% additional federal tax on top of the ordinary income tax, levied on the option holder',
  'Premium interest charges accruing from the year of vesting',
  'Possible state-level additional tax on the same amount, depending on jurisdiction',
  'The company carries withholding and reporting exposure for the same grants',
];

/** `/how-much-does-a-409a-cost` — what moves the number. */
export interface CostDriver {
  factor: string;
  effect: string;
}

export const COST_DRIVERS: CostDriver[] = [
  {
    factor: 'Stage and capital raised',
    effect:
      'The dominant driver. A pre-seed company with one class of stock is a fundamentally smaller job than a Series D with participating preferred, multiple option pools and a secondary history.',
  },
  {
    factor: 'Capital structure complexity',
    effect:
      'Every additional preferred series, warrant, SAFE, convertible note and liquidation preference is another branch in the allocation waterfall.',
  },
  {
    factor: 'Turnaround time',
    effect:
      'Expedited delivery carries a premium almost everywhere, because it displaces other scheduled work.',
  },
  {
    factor: 'Audit support',
    effect:
      'The rate charged when your auditor has questions — often billed separately, and often the largest single line nobody budgeted for.',
  },
  {
    factor: 'Bundling and lock-in',
    effect:
      'A valuation included with a cap-table platform is rarely free; it is priced into a subscription you keep paying, and it ties your valuation history to that vendor.',
  },
];

/**
 * Observed market bands for a standalone 409A, for orientation. Deliberately
 * ranges rather than competitor-specific figures: published prices move, and a
 * page that names a rival's number is out of date the week they change it.
 */
export const MARKET_PRICE_BANDS: Array<{ tier: string; range: string; note: string }> = [
  {
    tier: 'Cap-table platform, bundled',
    range: '$0 – $3,000',
    note: 'Nominally included, recovered through the platform subscription and a multi-year commitment.',
  },
  {
    tier: 'Specialist valuation firm',
    range: '$1,000 – $5,000',
    note: 'Standalone and portable. The band is wide because stage and structure drive it.',
  },
  {
    tier: 'Accounting or advisory firm',
    range: '$5,000 – $15,000+',
    note: 'Typically the most thorough and the slowest, with audit support at partner rates.',
  },
];

// ── Funding-stage landing pages ───────────────────────────────────────────────
// `/409a-valuation/:stage`. A founder searching "series B 409A valuation" is
// asking a narrower question than the product page answers: what changes in the
// analysis at *my* stage, and what will it cost *me*. Six pages, one per stage,
// each naming the methodology that actually differs there.
//
// The price range is derived from the 409A's entry price and the raise bands
// rather than written, because a stage page quoting a figure the checkout does
// not charge is the worst place in the site to be wrong.

export interface FundingStage {
  /** URL segment under `/409a-valuation/`. */
  slug: string;
  /** "Series B". */
  name: string;
  /**
   * Search-result description, ~140 characters. Separate from `heroSubhead`
   * because a meta description has a hard budget Google truncates at and the
   * hero does not — writing one and reusing it for the other loses the end of
   * the sentence in the result.
   */
  searchBlurb: string;
  /** Sentence under the hero. */
  heroSubhead: string;
  /** Who is reading this page. */
  audience: string;
  /** Typical capital raised, as an index range into RAISE_BANDS (inclusive). */
  bandRange: [number, number];
  /** The two or three things that genuinely differ in the analysis here. */
  sections: Array<{ title: string; body: string }>;
  /** What the engine actually leans on at this stage — shown as chips. */
  methods: string[];
  faq: FaqItem[];
}

export const FUNDING_STAGES: FundingStage[] = [
  {
    slug: 'pre-seed',
    name: 'Pre-seed',
    searchBlurb:
      '409A valuations for pre-seed companies granting their first options: the asset approach, SAFE and note treatment, and a wide marketability discount.',
    heroSubhead:
      'You are granting your first options, usually before anyone has bought priced equity. The valuation has to be built rather than backed out.',
    audience: 'Founders making their first grants',
    bandRange: [0, 0],
    methods: ['Asset / cost-to-recreate', 'Backsolve (if a priced round exists)', 'High DLOM'],
    sections: [
      {
        title: 'There may be no round to back out of',
        body: 'A backsolve needs a priced round to solve against. On SAFEs and convertible notes alone there is no per-share price to calibrate to — the notes are a promise about a future round, not a purchase of common stock today. The analysis leans on the asset approach: what it would cost to recreate the technology, the team and the customer relationships that exist right now.',
      },
      {
        title: 'SAFEs and notes still change the answer',
        body: 'They are not equity yet, but they sit ahead of common on the way out and they dilute you on conversion. Discounts, valuation caps and most-favoured-nation terms all move the number, and a valuation that treats a $2M SAFE stack as though it were not there overstates what the common stock is worth.',
      },
      {
        title: 'The marketability discount is at its widest',
        body: 'Nobody is buying your common stock, an exit is years out, and the range of outcomes is enormous. That combination is exactly what the DLOM models price, and pre-seed sits at the top of the range they produce.',
      },
    ],
    faq: [
      {
        q: 'Do I need a 409A before I have raised a priced round?',
        a: 'If you are granting stock options, yes. The requirement attaches to the grant, not to the round — the strike price of your first grant needs support on the day it is set.',
      },
      {
        q: 'We have only raised on SAFEs. What do you value against?',
        a: 'Primarily the asset approach — the cost to recreate what the business has built — cross-checked against the terms of the SAFEs themselves, including any valuation cap, which is evidence of what investors thought the company was worth.',
      },
      {
        q: 'How long is the valuation good for?',
        a: 'Twelve months, or until a material event — most commonly your first priced round, which invalidates it the day it closes.',
      },
    ],
  },
  {
    slug: 'seed',
    name: 'Seed',
    searchBlurb:
      '409A valuations for seed-stage companies: an OPM backsolve to your priced round, a single preference layer, and converted SAFEs in the share count.',
    heroSubhead:
      'A first priced round gives the analysis something to calibrate against, and a preference stack to allocate through.',
    audience: 'Companies that have closed or are closing a seed round',
    bandRange: [1, 1],
    methods: ['OPM backsolve', 'Single-preference waterfall', 'Asset cross-check'],
    sections: [
      {
        title: 'The backsolve becomes the primary method',
        body: 'A priced seed round is an arm’s-length transaction in your own securities, which is the strongest evidence of value there is. The option-pricing model is solved so that the preferred issued in that round prices back to what investors actually paid, and the common stock falls out of the same allocation.',
      },
      {
        title: 'One preference layer, but it is not nothing',
        body: 'Seed preferred typically carries a 1× non-participating preference. In a modest exit that preference takes the first dollars out, and the common only participates above it — which is precisely why your common stock is worth materially less per share than the price the round was struck at.',
      },
      {
        title: 'Converting notes land here',
        body: 'SAFEs and notes written before the round usually convert into it, often at a discount or a cap. The converted shares are part of the capital structure the valuation allocates over, and getting the conversion mechanics right is the difference between a defensible fully-diluted share count and a plausible one.',
      },
    ],
    faq: [
      {
        q: 'Our round just closed. When do we need the valuation?',
        a: 'Before the next grant. Any valuation dated before the close is invalid from the day the round closes, and grants made in that gap are the ones that surface in diligence.',
      },
      {
        q: 'Why is our common worth so much less than the seed price?',
        a: 'Because the seed price buys preferred stock with a liquidation preference and, usually, other rights common stock does not have — plus common stock has no market to be sold into, which the marketability discount prices.',
      },
      {
        q: 'Does an extension or a bridge count as a new round?',
        a: 'If it is priced, yes. A bridge on notes is a material event to assess rather than an automatic revaluation trigger.',
      },
    ],
  },
  {
    slug: 'series-a',
    name: 'Series A',
    searchBlurb:
      '409A valuations for Series A companies: two preferred classes, waterfall breakpoints, an option pool that moves the number, and a DCF cross-check.',
    heroSubhead:
      'Two classes of preferred, a real option pool, and the first forecast anyone will hold you to.',
    audience: 'Series A companies granting across a growing team',
    bandRange: [2, 2],
    methods: ['OPM backsolve', 'Multi-class waterfall', 'Income approach cross-check'],
    sections: [
      {
        title: 'A second preferred class adds breakpoints',
        body: 'Seed and Series A preferred rarely have identical rights. Different preference amounts, different conversion ratios and sometimes different seniority mean the exit waterfall now has several points where the split between classes changes — and the option-pricing model has to be broken at each one rather than at a single aggregate preference.',
      },
      {
        title: 'The option pool is now large enough to matter',
        body: 'A 10–15% pool, partly granted and partly reserved, sits in the fully-diluted count. Whether unissued reserve is treated as outstanding, and how in-the-money options are handled, moves the per-share result — so the treatment gets stated in the report rather than buried in a spreadsheet.',
      },
      {
        title: 'A forecast that supports an income approach',
        body: 'Most Series A companies have a plan with revenue in it that someone underwrote. That makes a discounted cash flow a genuine cross-check on the backsolve rather than an exercise — and where the two disagree, the report says why and how they were weighted.',
      },
    ],
    faq: [
      {
        q: 'How often will we need a new valuation at Series A?',
        a: 'At least every 12 months, and again after any material event — a new round, an acquisition approach, a secondary sale, or a substantial miss against the forecast the valuation relied on.',
      },
      {
        q: 'Does the unissued option pool reduce our common share price?',
        a: 'It increases the fully-diluted share count, which reduces value per share. The treatment of unissued reserve is a documented judgement and is set out in the report.',
      },
      {
        q: 'Our plan changed after the round closed. Does that matter?',
        a: 'If the change is material to what a buyer would pay, yes — a substantially revised forecast is a material event.',
      },
    ],
  },
  {
    slug: 'series-b',
    name: 'Series B',
    searchBlurb:
      '409A valuations for Series B companies: a multi-class preference waterfall, participating preferred, and secondary sales weighed as real evidence.',
    heroSubhead: 'A deeper preference stack, and secondary transactions that start to count as evidence.',
    audience: 'Series B companies with several preferred classes',
    bandRange: [3, 3],
    methods: ['OPM backsolve', 'Full breakpoint waterfall', 'Secondary-transaction evidence'],
    sections: [
      {
        title: 'The waterfall is where the value goes',
        body: 'Three or more preferred classes, each with its own preference amount and participation rights, produce a schedule of breakpoints rather than a single hurdle. Participating preferred is the one to watch: it takes its preference and then shares in the upside, which compresses the common stock at every exit value below the participation cap.',
      },
      {
        title: 'Secondaries become real evidence',
        body: 'By Series B, employees and founders are selling. A tender offer or a negotiated secondary in your common stock is a transaction in the exact security being valued — the strongest evidence available, and one that has to be weighed against the backsolve rather than ignored. Whether it was arm’s length, and how large it was, determines how much weight it carries.',
      },
      {
        title: 'The exit horizon shortens',
        body: 'A shorter expected time to liquidity lowers both the option-model term and the marketability discount, which pushes the common stock price up relative to earlier rounds independently of any change in enterprise value.',
      },
    ],
    faq: [
      {
        q: 'Does a tender offer trigger a new 409A?',
        a: 'It can. A material secondary transaction in your common stock is evidence of fair market value, and if it is out of line with the current valuation it is a material event.',
      },
      {
        q: 'How is participating preferred handled?',
        a: 'As additional breakpoints in the allocation. The preference is taken first and the residual is shared, so the common stock only participates fully above the participation cap where one exists.',
      },
      {
        q: 'We changed our forecast materially. Do we need a revaluation?',
        a: 'If the revision would change what a buyer would pay, yes. That is the test, not the size of the spreadsheet edit.',
      },
    ],
  },
  {
    slug: 'series-c',
    name: 'Series C and later',
    searchBlurb:
      '409A valuations for Series C and later: hybrid PWERM/OPM scenarios, screened public comparables, and a preference stack with real structure in it.',
    heroSubhead:
      'Enough structure and enough visibility that a single option-pricing model stops being the whole answer.',
    audience: 'Late-stage private companies',
    bandRange: [4, 4],
    methods: ['Hybrid PWERM/OPM', 'Full waterfall', 'Market multiples'],
    sections: [
      {
        title: 'Scenarios you can actually describe',
        body: 'At Series C the plausible exits are nameable — an IPO in a defined window, a strategic sale, a downside recapitalisation — with different probabilities and different payoffs to each class. That is what a probability-weighted expected return method models, and where a hybrid that runs an option model inside each scenario earns its complexity over a single lognormal assumption.',
      },
      {
        title: 'Comparable companies get closer',
        body: 'With real revenue and a defined market, public comparables stop being a formality. Revenue and EBITDA multiples from a screened peer set become a genuine market approach, weighted against the backsolve rather than mentioned beside it.',
      },
      {
        title: 'Structure accumulates',
        body: 'Multiple liquidation preferences, participation caps, seniority stacks, warrants, and often a secondary market in your own shares. Every one of them is a branch in the allocation, and the report shows the schedule rather than asserting a result.',
      },
    ],
    faq: [
      {
        q: 'When does PWERM make more sense than an OPM backsolve?',
        a: 'When the exit outcomes are genuinely distinguishable and you can support probabilities for them — typically once an IPO or a sale process is a describable path rather than an abstraction.',
      },
      {
        q: 'Should we be valuing more often than annually?',
        a: 'Many late-stage companies move to a semi-annual or quarterly cadence, because material events arrive faster and grant volume is higher.',
      },
      {
        q: 'Do down rounds get handled differently?',
        a: 'The mechanics are the same, but anti-dilution adjustments and any recapitalisation terms change the share counts and the preference stack the allocation runs over.',
      },
    ],
  },
  {
    slug: 'pre-ipo',
    name: 'Pre-IPO',
    searchBlurb:
      '409A valuations on an IPO path: hybrid PWERM/OPM, cheap-stock scrutiny, a compressed marketability discount, and tender offers you must reconcile with.',
    heroSubhead:
      'Cheap-stock scrutiny is real, the liquidity horizon is short, and the auditors arrive before the regulator does.',
    audience: 'Companies on an IPO path',
    bandRange: [4, 4],
    methods: ['Hybrid PWERM/OPM', 'Cheap-stock analysis', 'Compressed DLOM'],
    sections: [
      {
        title: 'Cheap stock is examined in retrospect',
        body: 'In an IPO registration, the grants made in the run-up are looked at against the offer price, and a steep climb from the last 409A to the listing invites the question of whether the earlier grants were underpriced. The defence is a contemporaneous, well-supported valuation at each grant date — which is a thing you can only have built beforehand.',
      },
      {
        title: 'A short horizon compresses the discounts',
        body: 'A liquidity event months away rather than years shortens the option term and shrinks the marketability discount sharply. Both push the common stock price toward the preferred price, which is the mechanical reason late-stage 409A values rise steeply even without an operational change.',
      },
      {
        title: 'Tender offers and an active secondary market',
        body: 'Pre-IPO companies frequently run tender offers, and there is often a broker market in their shares. These are transactions in the security being valued, and at this stage they carry substantial weight — the analysis has to reconcile with them rather than around them.',
      },
    ],
    faq: [
      {
        q: 'How often should we revalue on an IPO path?',
        a: 'Quarterly is common, and more frequently around material events. Auditors expect a contemporaneous valuation supporting every grant date in the registration period.',
      },
      {
        q: 'What is a cheap-stock issue?',
        a: 'Where option grants in the run-up to a listing are judged to have been priced below fair value in hindsight, producing additional stock-compensation expense and questions in the registration process.',
      },
      {
        q: 'Does an active secondary market set our 409A price?',
        a: 'It does not set it, but it is strong evidence and it has to be reconciled with. A valuation that ignores a liquid market in its own common stock is not defensible.',
      },
    ],
  },
];

export function fundingStageBySlug(slug: string): FundingStage | undefined {
  return FUNDING_STAGES.find((s) => s.slug === slug);
}

/**
 * The 409A price range a stage typically pays, in cents — the product's entry
 * price plus the raise-band uplifts at either end of the stage's band range.
 *
 * Derived rather than written: this is the number a prospect reads before they
 * sign up, and the checkout recomputes it from the same ladder.
 */
export function stagePriceRangeCents(stage: FundingStage): { fromCents: number; toCents: number } {
  const base = productBySlug('409a-valuation')!.priceCents;
  const clamp = (i: number) => Math.min(Math.max(i, 0), RAISE_BANDS.length - 1);
  const [lo, hi] = stage.bandRange;
  return {
    fromCents: base + RAISE_BANDS[clamp(lo)]!.upliftCents,
    toCents: base + RAISE_BANDS[clamp(hi)]!.upliftCents,
  };
}

// ── Partner programme ─────────────────────────────────────────────────────────
// `/partners` and `/partners/:segment`. The platform has had a partner channel
// since M3 — scoped portals, white-label branding, subdomains, an API with
// signed webhooks — and no public page saying so, which meant the only way to
// discover it was to already be a partner. 409.ai runs a hub plus four segment
// pages; this is the same shape, over what we actually ship.
//
// Nothing here quotes a referral fee or a wholesale discount. Those are
// commercial terms nobody has set, and a number invented to fill the column
// would be a price we could not honour — the pages route that question to the
// partnerships team instead.

export interface PartnerModel {
  key: 'referral' | 'co_branded' | 'api';
  name: string;
  summary: string;
  /** What the partner does. */
  youDo: string;
  /** What we do. */
  weDo: string;
  /** Platform capabilities this model is built on — all shipped, all nameable. */
  capabilities: string[];
  /** Whose brand the client sees. */
  brand: string;
}

export const PARTNER_MODELS: PartnerModel[] = [
  {
    key: 'referral',
    name: 'Referral',
    summary:
      'Send us the client and step back. They buy at our published prices, and you keep the relationship without carrying the engagement.',
    youDo: 'Introduce the client with a tracked link.',
    weDo: 'Intake, valuation, review, signature, delivery, and support.',
    capabilities: [
      'Tracked referral attribution on every engagement you send',
      'A partner-scoped worklist showing the status of each one',
      'Published per-report pricing, with no subscription for the client',
    ],
    brand: 'Ours. The client knows they were referred to N409.',
  },
  {
    key: 'co_branded',
    name: 'Co-branded',
    summary:
      'Your firm’s name and colours on the intake, the app and the report cover, on your own subdomain. The client stays inside your brand.',
    youDo: 'Own the client relationship and the price you charge them.',
    weDo: 'The analysis, the review, the signature, and the deliverable — under your identity.',
    capabilities: [
      'A subdomain of your own, with reserved names refused rather than repaired',
      'White-label branding resolved once and applied to the app, the report PDF and every workflow email',
      'A partner portal scoped to your clients, with per-user roles',
      'Partner-settled billing, so the client never sees an invoice from us',
    ],
    brand: 'Yours, from the intake form to the report cover.',
  },
  {
    key: 'api',
    name: 'API',
    summary:
      'Submit engagements from your own product and pull the finished report back. We are a service you call, not a site your users visit.',
    youDo: 'Build against the partner API; keep your users where they are.',
    weDo: 'Run the engagement and push you an event the moment the report is ready.',
    capabilities: [
      'A versioned REST API with an OpenAPI 3.1 document you can generate a client from',
      'Bearer API keys, issued once and revocable, scoped to your organisation',
      'Idempotency keys, so a retried submission replays instead of duplicating',
      'Signed webhooks (HMAC-SHA256) on state changes and report-ready, with delivery retries',
    ],
    brand: 'Invisible. Your users never see us.',
  },
];

export interface PartnerSegment {
  slug: string;
  name: string;
  /** Search-result description, ~140 characters. */
  searchBlurb: string;
  heroSubhead: string;
  /** The problem this segment actually has. */
  problem: string;
  /** Why they are the ones asked for a valuation in the first place. */
  bullets: string[];
  /** The model that usually fits, by key. */
  recommendedModel: PartnerModel['key'];
  /** Report types this segment's clients ask for most. */
  productSlugs: string[];
  faq: FaqItem[];
}

export const PARTNER_SEGMENTS: PartnerSegment[] = [
  {
    slug: 'cap-table-platforms',
    name: 'Cap-table & equity platforms',
    searchBlurb:
      'Add 409A valuations to your cap-table product through an API with signed webhooks, or co-branded on your own subdomain — without building a valuation team.',
    heroSubhead:
      'Your users already keep their cap table with you. The 409A is the next thing they ask you for.',
    problem:
      'A cap-table platform holds the exact data a valuation needs and gets asked for the valuation constantly — but building the practice means analysts, review, signatures and audit support, which is a different company. The usual answer is a referral out of the product, and the user does not come back for a week.',
    bullets: [
      'You already hold the securities, the rounds and the option ledger',
      'A strike price your users cannot set is a workflow that stops inside your product',
      'Sending them elsewhere hands the next relationship to someone else',
    ],
    recommendedModel: 'api',
    productSlugs: ['409a-valuation', 'asc-718-valuation', 'qsbs-attestation'],
    faq: [
      {
        q: 'Can we submit and retrieve entirely over the API?',
        a: 'Yes. Create the engagement, upload documents, poll status or subscribe to webhooks, and download the finished PDF — all from your own systems, with no user visit to us.',
      },
      {
        q: 'Do our users see N409 at all?',
        a: 'Only if you want them to. Under the API model we are invisible; under the co-branded model the intake and the report carry your brand on your subdomain.',
      },
      {
        q: 'How do we know a report is ready?',
        a: 'A signed webhook on report-ready, delivered with retries, alongside a status you can poll. The signature is HMAC-SHA256 over the exact request body.',
      },
    ],
  },
  {
    slug: 'accounting-law-firms',
    name: 'Accounting, advisory & law firms',
    searchBlurb:
      'Offer 409A, ASC 718 and gift-and-estate valuations under your own firm’s brand, with analyst review and audit support behind them.',
    heroSubhead: 'Your clients ask you first. Answer without subcontracting the relationship away.',
    problem:
      'A firm that does the tax work, the audit or the equity plan is the first call when a valuation is needed — and referring it out means introducing a client to a provider who now has their own relationship. Doing it in-house means staffing a specialism that only some clients need.',
    bullets: [
      'The engagement arrives through work you are already doing',
      'Independence rules may stop you valuing an audit client yourself',
      'The deliverable has to survive your own review, not just the client’s',
    ],
    recommendedModel: 'co_branded',
    productSlugs: ['409a-valuation', 'asc-718-valuation', 'gift-estate-tax-valuation'],
    faq: [
      {
        q: 'Can the report carry our firm’s branding?',
        a: 'Yes. Under the co-branded model your name, colours and logo appear on the intake, in the app, and on the report cover, served from your own subdomain.',
      },
      {
        q: 'Who signs the valuation?',
        a: 'Our analysts review and sign it. That independence is often the point — it is what lets you offer the valuation to a client you could not value yourself.',
      },
      {
        q: 'What happens when the auditor asks questions?',
        a: `We support the valuation directly, at $${AUDIT_DEFENCE_RATE_USD} an hour, working with you or with the client as you prefer.`,
      },
    ],
  },
  {
    slug: 'funds-accelerators',
    name: 'VC, PE, fund admins & accelerators',
    searchBlurb:
      'ASC 820 portfolio marks and 409A valuations for every company you back, in one place, with roll-forward from the prior measurement date.',
    heroSubhead: 'One provider for the portfolio marks you report and the 409As your companies need.',
    problem:
      'A fund needs its own marks for LP reporting and its companies need their own valuations, and the two are usually bought from different places on different calendars. Nothing ties the mark on a position to the valuation of the company underneath it, so every quarter is a re-collection exercise.',
    bullets: [
      'Quarter-close is a deadline, not a preference',
      'Level 3 marks are where the auditor spends their time',
      'Every portfolio company needs its own 409A, on its own schedule',
    ],
    recommendedModel: 'referral',
    productSlugs: ['portfolio-valuation', 'asc-820-valuation', '409a-valuation'],
    faq: [
      {
        q: 'Can you mark the whole portfolio, not just one holding?',
        a: 'Yes — that is the Portfolio Valuation product: every position marked and classified, rolled up to NAV, and distributed through your LP waterfall.',
      },
      {
        q: 'Can you roll forward the marks we already have?',
        a: 'Yes, by re-calibration, accretion, or a public-market-equivalent index movement, depending on what the position supports.',
      },
      {
        q: 'Do our portfolio companies get their own accounts?',
        a: 'Yes. Each company runs its own engagement; you see the ones you referred in a partner-scoped worklist.',
      },
    ],
  },
  {
    slug: 'fintech-hr-platforms',
    name: 'Fintech & HR/comp platforms',
    searchBlurb:
      'Compensation and HR platforms need a defensible strike price to show equity properly. Add one over an API, or co-branded inside your product.',
    heroSubhead:
      'Equity is half of the offer. Without a current strike price you cannot show what it is worth.',
    problem:
      'A compensation or HR platform models equity in offers, in total-rewards statements and in retention analysis — all of which need a fair market value that is current and defensible. Without one, the equity number is either stale or made up, and both are worse than absent.',
    bullets: [
      'Offer and total-rewards modelling needs a current, supportable FMV',
      'A stale valuation makes every downstream equity figure wrong at once',
      'Grant workflows stall on a strike price your product cannot produce',
    ],
    recommendedModel: 'api',
    productSlugs: ['409a-valuation', 'asc-718-valuation'],
    faq: [
      {
        q: 'How current can the valuation be?',
        a: 'A first draft in 24 hours and a final report in 7 business days, with express delivery available. Valuations are refreshed annually and on any material event.',
      },
      {
        q: 'Can we trigger a valuation from our own workflow?',
        a: 'Yes — a single API call creates the engagement, and a webhook tells you when the report is ready.',
      },
      {
        q: 'Do you also handle the accounting side?',
        a: 'Yes. ASC 718 stock-compensation expense and IFRS 2 are separate report types on the same platform and the same intake.',
      },
    ],
  },
];

export function partnerSegmentBySlug(slug: string): PartnerSegment | undefined {
  return PARTNER_SEGMENTS.find((s) => s.slug === slug);
}

export function partnerModelByKey(key: PartnerModel['key']): PartnerModel {
  return PARTNER_MODELS.find((m) => m.key === key)!;
}

export const PARTNER_FAQ: FaqItem[] = [
  {
    q: 'What does it cost to become a partner?',
    a: 'Nothing to join, and no volume commitment. Referral terms and co-branded or API rates are agreed with the partnerships team, because they depend on the model and the volume rather than on a published list.',
  },
  {
    q: 'How fast are reports delivered?',
    a: 'A first draft in 24 hours and a final report in 7 business days for every report type, with express delivery available as an add-on.',
  },
  {
    q: 'Who reviews and signs the valuation?',
    a: 'Our analysts. Every report is reviewed and dual-signed before it is published, whichever brand it carries.',
  },
  {
    q: 'Which report types can partners submit?',
    a: `All ${PRODUCTS.length} of them — 409A, ASC 718, ASC 820, portfolio, gift and estate, QSBS, EMI, CSOP, IFRS 2, purchase price allocation, impairment, ESOP, IP and SMB.`,
  },
  {
    q: 'What happens if a client’s auditor has questions?',
    a: `We support the valuation directly at $${AUDIT_DEFENCE_RATE_USD} an hour, working with whichever of you is fielding the question.`,
  },
  {
    q: 'Is client data shared between partners?',
    a: 'No. Every read is scoped to the organisation that owns it, and an out-of-scope id is not found rather than forbidden — a partner cannot even confirm another partner’s engagement exists.',
  },
];

// ── Partner API facts, for the public /developers page ────────────────────────
// The endpoint table on that page is fetched live from GET /api/partner/v1/docs
// so it cannot drift. These are the surrounding facts a crawler and a
// first-time reader both need without running JavaScript, so they are static —
// which means they are a second copy, and the only defence against a second
// copy is naming where the first one lives.
//
// Source of truth, all in the valuation service:
//   prefix, key prefix        → routes/partnerApi.ts (PARTNER_API_PREFIX)
//   signature/event/delivery  → domain/partnerWebhooks.ts (SIGNATURE_HEADER, …)
//   webhook secret prefix     → domain/partnerWebhooks.ts (newWebhookSecret)
//   retry ladder              → domain/partnerWebhooks.ts
//                               (WEBHOOK_RETRY_BACKOFF_MINUTES)
// test/integration/partnerApiDocs.test.ts pins each of them against this file.

export const PARTNER_API = {
  prefix: '/api/partner/v1',
  openApiUrl: '/api/partner/v1/openapi.json',
  keyPrefix: 'n409_pat_',
  webhookSecretPrefix: 'n409_whsec_',
  signatureHeader: 'x-n409-signature',
  eventHeader: 'x-n409-event',
  deliveryHeader: 'x-n409-delivery',
  /** Backoff after each failed delivery, in the order it is walked. */
  retryLadder: ['1 min', '5 min', '30 min', '2 h', '6 h'],
} as const;

export const WEBHOOK_EVENTS: Array<{ name: string; description: string }> = [
  {
    name: 'valuation.state_changed',
    description: 'Any lifecycle transition, for every report type.',
  },
  {
    name: 'valuation.report_ready',
    description: 'The transition that first makes the deliverable downloadable.',
  },
  {
    name: 'valuation.retired',
    description:
      'The engagement has been withdrawn — it will not transition again and every write to it is ' +
      'refused. The only terminal event: without it an integration waiting on a report it will never ' +
      'receive cannot tell that from work still in progress.',
  },
  {
    name: 'webhook.test',
    description: 'A signed ping you can trigger yourself while building the receiver.',
  },
];
