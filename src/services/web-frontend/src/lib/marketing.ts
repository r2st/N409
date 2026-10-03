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

// ── Shared product-page furniture ─────────────────────────────────────────────
// The 8-section product template mirrors 409.ai: Hero, Problem (with a
// cross-link to a related product), Solution cards, Process, Included
// checklist, FAQ, and a bottom CTA with a legal disclaimer. The copy itself
// lives in `productContent.ts` — it is 40 kB read by one lazy route, and this
// module is on the first-paint path. What stays here is what more than that
// one route needs: the process strip, the FAQ shape, and the rate quoted on
// four different pages.

/** Audit-defence hourly rate shown on the 409A FAQ and the pricing page (gap #33). */
export const AUDIT_DEFENCE_RATE_USD = 175;

export interface FaqItem {
  q: string;
  a: string;
}
export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

// ── Self-serve pricing tiers ─────────────────────────────────────────────────
// The three tiers shown on /pricing. Mirrors plan_limits rows seeded in
// migration 0209 — keep tier slugs and prices in sync.

export interface PricingTier {
  tier: string;
  name: string;
  priceCents: number;
  interval: 'one_time' | 'month';
  tagline: string;
  features: string[];
  valuationLimit: number | null;
  highlight?: boolean;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    tier: 'starter',
    name: 'Starter',
    priceCents: 29_900,
    interval: 'one_time',
    tagline: 'One valuation, one price.',
    features: [
      'Single 409A valuation report',
      'AI-assisted intake',
      'Analyst-signed, audit-defensible report',
      'Draft review with revisions included',
      'Basic email support',
      '7-day delivery (Express available)',
    ],
    valuationLimit: 1,
  },
  {
    tier: 'growth',
    name: 'Growth',
    priceCents: 19_900,
    interval: 'month',
    tagline: 'For growing teams that need regular valuations.',
    features: [
      'Up to 3 valuations per year',
      'Priority support',
      'Compliance dashboard',
      'Draft review with revisions included',
      'Live status tracking',
      'Roll-forward from prior valuation',
    ],
    valuationLimit: 3,
    highlight: true,
  },
  {
    tier: 'enterprise_monthly',
    name: 'Enterprise',
    priceCents: 49_900,
    interval: 'month',
    tagline: 'For companies that never want to think about it.',
    features: [
      'Unlimited valuations',
      'Dedicated support',
      'Audit defense included',
      'Custom branding on reports',
      'Compliance dashboard',
      'Priority Express delivery',
      'Partner API access',
    ],
    valuationLimit: null,
  },
];

// ── "Which valuation?" quiz ───────────────────────────────────────────────────

/** A comparison page's identity — what a link to it needs, and nothing else. */
export interface ComparisonRef {
  /** URL segment under `/compare/`. */
  slug: string;
  /** Link text: "DoAide 409A vs Carta". */
  competitor: string;
}

/** Every published `/compare/:slug` page, in nav order. */
export const COMPARISONS: ComparisonRef[] = [
  { slug: 'carta', competitor: 'Carta' },
  { slug: 'pulley', competitor: 'Pulley' },
  { slug: 'eqvista', competitor: 'Eqvista' },
  { slug: 'kruze', competitor: 'Kruze Consulting' },
  { slug: 'eton', competitor: 'Eton Venture Services' },
  { slug: 'aranca', competitor: 'Aranca' },
  { slug: 'scalar', competitor: 'Scalar' },
];

// ── Compare provider hub (gap #30) ────────────────────────────────────────────
// The overview page at /compare/409a-valuation-providers categorises the market
// into model types and links out to each individual comparison page above.

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
    body: 'Questions, documents, and accounting sync — about 15 minutes.',
  },
  {
    step: '02',
    title: 'Draft report',
    body: 'Draft in 24 hours. Ask questions, see how every number was built.',
  },
  {
    step: '03',
    title: 'Final delivery',
    body: 'Dual-signed, audit-defensible report — 7 days standard, 1 day express.',
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
    body: 'Two credentialed analysts prepare and sign every report. No model-only output.',
  },
  {
    title: 'Every number traces to a source',
    body: 'Every figure links to its source document, ledger, or assumption — the audit trail auditors ask for.',
  },
  {
    title: 'Methodology in the open',
    body: 'Every approach and discount model documented with inputs. Nothing is a black box.',
  },
];

export const DEMO_VIDEO_TITLE = 'DoAide 409A product demo';

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
    a: 'From $1,190 with 7-day delivery. Express (1 day) is a $500 add-on. Other types priced on each product page.',
  },
  {
    q: 'How is pricing structured across report types?',
    a: 'One flat price per report — no subscriptions, no per-seat fees, no lock-in.',
  },
  {
    q: 'Do you offer express delivery?',
    a: 'Yes — 1 business day instead of 7, for $500. First draft still arrives within 24 hours either way.',
  },
  {
    q: 'Do you offer bundles or discounts for multiple reports?',
    a: 'Contact us for bundled pricing on multiple reports or partner-programme volume.',
  },
  {
    q: 'What is a 409A valuation?',
    a: 'An independent fair market value appraisal of your common stock for setting option strike prices under IRC §409A.',
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
    body: 'A strike price needs support on the day it is set — not retroactively.',
    urgency: 'required',
  },
  {
    title: 'Every 12 months, without exception',
    body: 'Safe harbor expires after 12 months — an aged valuation supports nothing.',
    urgency: 'required',
  },
  {
    title: 'After closing a priced round',
    body: 'A priced round invalidates prior valuations immediately. Grants in the gap surface in diligence.',
    urgency: 'required',
  },
  {
    title: 'After any other material event',
    body: 'Acquisitions, pivots, major customer changes, or secondary transactions — anything that would change what a buyer would pay.',
    urgency: 'required',
  },
  {
    title: 'Before a fundraise or an exit process',
    body: 'A clean valuation history is far cheaper to produce now than to reconstruct under a deal timeline.',
    urgency: 'recommended',
  },
  {
    title: 'Before an audit or a QSBS claim',
    body: 'Auditors test SBC expense and QSBS claims against the valuation — smoother when the work already exists.',
    urgency: 'recommended',
  },
];

/** A stage page's identity — what a link to it needs, and nothing else. */
export interface FundingStageRef {
  /** URL segment under `/409a-valuation/`. */
  slug: string;
  /** "Series B" — the link text. */
  name: string;
}

/** Every published `/409a-valuation/:stage` page, earliest stage first. */
export const FUNDING_STAGES: FundingStageRef[] = [
  { slug: 'pre-seed', name: 'Pre-seed' },
  { slug: 'seed', name: 'Seed' },
  { slug: 'series-a', name: 'Series A' },
  { slug: 'series-b', name: 'Series B' },
  { slug: 'series-c', name: 'Series C and later' },
  { slug: 'pre-ipo', name: 'Pre-IPO' },
];

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

/** A partner-segment page's identity — what a link to it needs, and nothing else. */
export interface PartnerSegmentRef {
  /** URL segment under `/partners/`. */
  slug: string;
  /** "Cap-table & equity platforms" — the link text. */
  name: string;
}

/**
 * Every published `/partners/:segment` page, in nav order.
 *
 * The light half; the problem statements, bullets and FAQ live in
 * `marketingContent.ts`. See the note above `COMPARISONS`.
 */
export const PARTNER_SEGMENTS: PartnerSegmentRef[] = [
  { slug: 'cap-table-platforms', name: 'Cap-table & equity platforms' },
  { slug: 'accounting-law-firms', name: 'Accounting, advisory & law firms' },
  { slug: 'funds-accelerators', name: 'VC, PE, fund admins & accelerators' },
  { slug: 'fintech-hr-platforms', name: 'Fintech & HR/comp platforms' },
];

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
