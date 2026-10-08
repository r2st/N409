import { AUDIT_DEFENCE_RATE_USD, productBySlug, type FaqItem, type Product } from './marketing';

/**
 * The bodies behind the marketing site's three slug-driven page families:
 * `/compare/:slug`, `/409a-valuation/:stage` and `/partners/:segment`.
 *
 * These used to sit in `marketing.ts` next to the lists of slugs. That module is
 * on the eager path — the header menu and the footer link to every one of these
 * pages, and `MarketingLayout` renders on first paint — so a single module
 * holding both the links and the prose put every comparison table, every stage
 * write-up and every partner FAQ into the entry chunk. A founder landing on the
 * home page downloaded the text of seventeen pages to render links to them.
 *
 * `marketing.ts` keeps the identities (slug + link text); this module keeps
 * everything a page actually renders, plus the by-slug lookups that return the
 * whole record. Nothing eager imports this file, so it is pulled in with the
 * page that needs it. `test/marketingContentRefs.test.ts` fails if the two
 * halves ever name a different set of pages, in a different order.
 */

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

export const COMPARISON_DETAILS: Comparison[] = [
  {
    slug: 'carta',
    competitor: 'Carta',
    category: 'Cap table & valuation platform',
    summary:
      'Carta bundles 409A valuations with its cap-table subscription. DoAide 409A is a dedicated valuation shop: transparent methodology, faster drafts, and no platform lock-in.',
    rows: STANDARD_ROWS({
      onboarding: 'Within their cap-table product; requires subscription',
      draft: 'Days to weeks',
      final: '1–2 weeks, tier-dependent',
      transparency: 'Report only; model internals not exposed',
    }),
  },
  {
    slug: 'eshares',
    competitor: 'eShares (Carta)',
    category: 'Cap table platform (now Carta)',
    summary:
      'eShares rebranded to Carta and bundles 409A with a cap-table subscription. DoAide 409A offers analyst sign-off without platform lock-in — from $49, transparent methodology, 24-hour drafts.',
    rows: STANDARD_ROWS({
      onboarding: 'Within their cap-table product; requires active subscription',
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
      'Pulley offers 409A as an add-on to cap-table management. DoAide 409A focuses solely on defensible valuations across 13 product lines.',
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
      'Eqvista pairs software with valuation services. DoAide 409A adds AI-assisted intake, an auditable calculation engine, and client-visible scenario analysis.',
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
      'Kruze delivers valuations as part of a broader accounting engagement. DoAide 409A is self-serve, faster, and priced per report rather than per relationship.',
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
      'Eton is a traditional valuation practice. DoAide 409A delivers the same analyst rigor with a modern pipeline: AI extraction, live status, and 24-hour drafts.',
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
      'Aranca serves valuations through an offshore research model. DoAide 409A keeps everything in one platform with client-visible progress and audit-ready evidence bundles.',
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
      'Scalar productizes valuations for funds and startups. DoAide 409A matches the product experience and adds a transparent engine plus 13 report types under one roof.',
    rows: STANDARD_ROWS({
      onboarding: 'Online forms',
      draft: 'About a week',
      final: '1–2 weeks',
      transparency: 'Summary schedules',
    }),
  },
];

export function comparisonBySlug(slug: string): Comparison | undefined {
  return COMPARISON_DETAILS.find((c) => c.slug === slug);
}

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

export const FUNDING_STAGE_DETAILS: FundingStage[] = [
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
  return FUNDING_STAGE_DETAILS.find((s) => s.slug === slug);
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

export const PARTNER_SEGMENT_DETAILS: PartnerSegment[] = [
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
        q: 'Do our users see DoAide 409A at all?',
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
  return PARTNER_SEGMENT_DETAILS.find((s) => s.slug === slug);
}

// ── Page content moved off the first-paint path ───────────────────────────────
//
// Everything below is read by exactly one lazy route — the pricing calculator,
// the "which valuation?" quiz, the provider hub, the guides, the partner
// programme, the developer page. It lived in `marketing.ts`, which the header,
// the footer and the landing page all import, and a module that the entry chunk
// holds carries every export any chunk uses: the quiz options and the webhook
// event table shipped to a visitor who only ever saw the home page.

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

// ── Pricing calculator ────────────────────────────────────────────────────────

export const EXPRESS_DELIVERY_CENTS = 2_900;
export const QSBS_ADDON_CENTS = 0;
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
  { label: '$1M – $5M', upliftCents: 0 },
  { label: '$5M – $10M', upliftCents: 0 },
  { label: '$10M – $20M', upliftCents: 0 },
  { label: '$20M+', upliftCents: 0 },
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
//
// Split in two, and this is the light half. The header menu and the footer link
// to every comparison page, so this list sits on the landing page's critical
// path; the comparison *tables* are only ever read on the page they describe.
// While both lived in one module the entry chunk carried every row of every
// table — `marketingContent.ts` holds the bodies and the by-slug lookups, and
// `test/marketingContentRefs.test.ts` fails if the two lists disagree.

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
    providers: [{ name: 'DoAide 409A' }],
  },
  {
    title: 'Cap-table & equity platforms',
    description:
      'Equity-management products that offer a 409A as an add-on to a cap-table subscription. Convenient if you already live in the platform, but the valuation is a side feature.',
    tradeoff: 'Bundled with a subscription; methodology internals are rarely exposed.',
    providers: [
      { name: 'Carta', slug: 'carta' },
      { name: 'eShares (Carta)', slug: 'eshares' },
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
    why: `Rates range widely — DoAide 409A supports the valuation at $${AUDIT_DEFENCE_RATE_USD}/hr versus $300–$500+/hr at many firms.`,
  },
  {
    q: 'Is the valuation tied to a subscription or platform?',
    why: 'Per-report pricing with no lock-in keeps you free to move; a bundled model may not.',
  },
];

// ── Landing page content ──────────────────────────────────────────────────────

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

// ── 409A methods guide (`/409a-valuation-methods`) ──────────────────────────
// Long-tail SEO page targeting "409A valuation methods", "market income asset
// approach valuation". Follows the same GuideSection structure as the main guide.

export const METHODS_SECTIONS: GuideSection[] = [
  {
    heading: 'The three standard valuation approaches',
    body: 'Every 409A valuation draws on one or more of three recognised approaches: the market approach, the income approach, and the asset approach. A defensible report applies the approaches that are appropriate to the company\'s stage and data, weights them with a stated rationale, and shows how they were reconciled — rather than picking one and ignoring the rest.',
  },
  {
    heading: 'Market approach — comparable company analysis',
    body: 'The market approach estimates value by reference to what similar companies are worth. The two common methods are Guideline Public Company (GPC) analysis, which applies multiples from a screened set of public peers, and Guideline Transaction Method (GTM), which draws on M&A transactions in the same sector. At early stages, the most directly comparable "transaction" is often the company\'s own most recent priced round.',
    bullets: [
      'Best suited when a meaningful set of public or private comparables exists',
      'Revenue and EBITDA multiples are the most common metrics, adjusted for growth and margin',
      'Peer selection must be documented and defensible — a hand-picked set draws audit scrutiny',
      'For pre-revenue companies, user-based or gross-merchandise-value multiples may substitute',
    ],
  },
  {
    heading: 'Income approach — discounted cash flow',
    body: 'The income approach values the business by discounting its expected future cash flows to today at a rate that reflects the risk of achieving them. The weighted average cost of capital (WACC) is built from observable inputs — risk-free rate, equity risk premium, size premium, and a company-specific premium — so the discount rate can be reconstructed by a reviewer rather than asserted.',
    bullets: [
      'Requires a credible financial forecast, typically three to five years',
      'Terminal value captures cash flows beyond the explicit forecast period',
      'Most useful from Series A onward, when a revenue plan someone has underwritten exists',
      'A DCF that agrees with the backsolve is strong corroboration; one that disagrees is worth explaining',
    ],
  },
  {
    heading: 'Asset approach — net asset value',
    body: 'The asset approach values the company at the fair value of its assets minus its liabilities. For operating businesses with significant tangible assets — real estate, equipment, inventory — this can be the primary method. For most startups it is a floor: the value of the intellectual property, the team, and the early-customer relationships the company has assembled, estimated as the cost to recreate them.',
    bullets: [
      'Primary method for pre-revenue companies where no round exists to backsolve against',
      'Serves as a floor or a cross-check for later-stage companies',
      'Cost-to-recreate is the most common form: what would it take to rebuild what exists today?',
      'Intangible assets — technology, trade secrets, assembled workforce — are included',
    ],
  },
  {
    heading: 'How approaches are allocated and reconciled',
    body: 'Enterprise value from the approaches above must be allocated across the capital structure to reach a per-share value for common stock. The option-pricing model (OPM) and the backsolve method are the workhorses: the OPM treats each class as a call option on equity value, and the backsolve calibrates the model so the most recent round reprices correctly. For later-stage companies, a probability-weighted expected return method (PWERM) models discrete exit scenarios — IPO, sale, continuation — each with its own probability and payoff.',
    bullets: [
      'OPM backsolve: the primary allocation method from seed onward',
      'PWERM: used when the exit scenarios are distinguishable and supportable',
      'Hybrid: an OPM run inside each PWERM scenario, for late-stage companies',
      'Approach weighting is a stated judgment, not a hidden average',
    ],
  },
  {
    heading: 'Discount for lack of marketability (DLOM)',
    body: 'Common stock in a private company cannot be freely sold, and that illiquidity is worth a discount. The DLOM is supported by put-option models — Chaffee (European protective put) and Finnerty (average-strike Asian put) are the most widely accepted — which produce a figure from the company\'s volatility, the expected time to a liquidity event, and the risk-free rate. Early-stage companies carry a wider discount; as an exit approaches, the discount narrows.',
  },
];

// ── Cost comparison guide (`/409a-valuation-cost-comparison`) ────────────────
// Long-tail SEO page targeting "409A cost Big 4 vs boutique vs automated" and
// "how much does a 409A valuation cost comparison". Distinct from the existing
// `/how-much-does-a-409a-cost` page, which covers what drives the price in
// general; this one directly compares the provider types.

export interface ProviderType {
  name: string;
  priceRange: string;
  turnaround: string;
  strengths: string[];
  tradeoffs: string[];
}

export const PROVIDER_TYPES: ProviderType[] = [
  {
    name: 'Big 4 and large advisory firms',
    priceRange: '$10,000 – $30,000+',
    turnaround: '4–8 weeks',
    strengths: [
      'Recognised brand that auditors and boards accept without question',
      'Deep bench of specialists across complex instrument types',
      'Integrated with the firm\'s broader audit and advisory practice',
    ],
    tradeoffs: [
      'Highest price point, typically billed by the hour rather than per report',
      'Longest turnaround, with limited visibility into progress',
      'Audit support billed at partner rates ($400–$600+/hr)',
      'Engagement overhead: MSA, annual renewal, minimum commitments',
    ],
  },
  {
    name: 'Boutique valuation firms',
    priceRange: '$3,000 – $10,000',
    turnaround: '2–4 weeks',
    strengths: [
      'Specialised in 409A work; deep familiarity with startup capital structures',
      'More accessible team — direct contact with the analyst on your report',
      'Competitive pricing on renewals and roll-forwards',
    ],
    tradeoffs: [
      'Quality varies: credentials, methodology transparency, and audit track record differ widely',
      'Most still rely on manual spreadsheet models with limited client visibility',
      'Turnaround can stretch during year-end valuation season',
    ],
  },
  {
    name: 'Cap-table platform add-ons',
    priceRange: '$0 – $3,000 (bundled)',
    turnaround: '1–3 weeks',
    strengths: [
      'Bundled with the cap-table product you may already use',
      'Data ingestion is streamlined because they hold the cap table',
      'Convenient for companies already on the platform',
    ],
    tradeoffs: [
      'Cost is recovered through the platform subscription, not actually free',
      'Methodology is typically opaque — a report without a workbook',
      'Valuation history is locked to the vendor; switching means starting over',
      'The provider\'s incentive is retention, not the valuation\'s quality',
    ],
  },
  {
    name: 'AI-native platforms (DoAide 409A)',
    priceRange: 'From $49 per report',
    turnaround: '24-hour draft, 7-day final (1-day Express)',
    strengths: [
      'Fastest turnaround: first draft in 24 hours, not weeks',
      'Transparent methodology: every number traces to its source in an auditable workbook',
      'Credentialed analyst review and dual sign-off on every report',
      'No subscription, no lock-in — pay per report',
      'Audit defence at a fraction of traditional rates',
    ],
    tradeoffs: [
      'Newer entrant; the brand is less recognised than established firms',
      'Best suited for standard 409A structures; highly bespoke instruments may require consultation',
    ],
  },
];

export const COST_COMPARISON_SECTIONS: GuideSection[] = [
  {
    heading: 'What actually drives the price of a 409A',
    body: 'The cost of a 409A valuation is not driven by the company\'s revenue or valuation — it is driven by the complexity of the capital structure and by who does the work. A pre-seed company with one class of stock is fundamentally less work than a Series D with four preference stacks, warrants, and a secondary market. The provider you choose determines whether that work is done by a team billing hours, a software platform, or a hybrid of both.',
  },
  {
    heading: 'Why the sticker price is not the whole cost',
    body: 'The quoted price gets you a report. But when your auditor asks questions, somebody has to answer them — and that time is usually billed separately, at rates that vary from $150/hr to $600+/hr depending on the provider. A $3,000 valuation with $5,000 in audit support is more expensive than a $5,000 one that includes it. Ask about audit defence before you compare headline prices.',
    bullets: [
      'Traditional firms: audit support at $300–$600/hr, billed by the hour',
      'Boutique firms: $150–$300/hr, sometimes included for a limited scope',
      'AI-native platforms: typically a fraction of traditional rates, with revisions included in the draft cycle',
    ],
  },
  {
    heading: 'When to choose which provider',
    body: 'There is no single right answer. A pre-IPO company going through a Big 4 audit may need a Big 4 valuation to match. A seed-stage startup granting its first options needs a defensible report, not a brand — and should not pay $10,000 for one. The right question is not "which is cheapest" but "what does my situation actually require?"',
    bullets: [
      'Pre-seed to Series A: an AI-native platform or a boutique firm delivers the same safe-harbor protection at a fraction of the cost',
      'Series B and beyond: evaluate whether your auditor has a preference, and whether the capital structure requires specialist attention',
      'Pre-IPO: brand recognition may matter for your S-1; talk to your underwriter',
      'Annual renewals and roll-forwards: the cheapest option is whichever provider can reuse prior work without starting over',
    ],
  },
];

// ── Funding-stage landing pages ───────────────────────────────────────────────
//
// The light half of `/409a-valuation/:stage` — see the note above `COMPARISONS`
// for why the bodies live in `marketingContent.ts`.

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
    brand: 'Ours. The client knows they were referred to DoAide 409A.',
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

export function partnerModelByKey(key: PartnerModel['key']): PartnerModel {
  return PARTNER_MODELS.find((m) => m.key === key)!;
}

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
    name: 'valuation.restored',
    description:
      'A withdrawn engagement is back in the product — writes are accepted again and it will go on ' +
      'transitioning. The undo of the event above, so an integration that closed the engagement out ' +
      'knows to reopen it.',
  },
  {
    name: 'webhook.test',
    description: 'A signed ping you can trigger yourself while building the receiver.',
  },
];
