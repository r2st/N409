/**
 * Central help content for the N409 valuation platform.
 *
 * All user-facing documentation lives here as plain Markdown so copy can be
 * edited without touching components. The Help Center (`/help`), contextual
 * `HelpIcon`s, the Getting Started checklist and the Features page all read
 * from this file.
 *
 * Structure:
 *   HELP_CATEGORIES — the 26 top-level areas, each with an id, label and blurb.
 *   HELP_ARTICLES   — the article *metadata*; each belongs to one category and
 *                     may link to related articles by id.
 *
 * The Markdown bodies are not here. They are ~48 kB — two thirds of what this
 * module used to weigh — and every caller that only needs a title or a
 * category was paying for all of them: `HelpIcon` alone put the corpus in the
 * graph of 51 of the 121 built chunks. They live in `helpBodies.ts` and are
 * fetched on demand by `loadHelpBodies()`; import that module statically only
 * if you are the Help Center itself.
 *
 * Writing style: plain language for startup founders, CFOs and accountants.
 * Explain 409A / ASC 718 concepts briefly rather than assuming expertise.
 */

export interface HelpCategoryMeta {
  /** Stable id, also used in URLs and as the anchor for HelpIcons. */
  id: string;
  /** Human label shown in the sidebar and breadcrumbs. */
  label: string;
  /** One-line description for the category (Features page, sidebar tooltip). */
  blurb: string;
}

export interface HelpArticleContent {
  /** Stable id — used as the `/help/:slug` URL segment. */
  id: string;
  title: string;
  /** Category id (see HELP_CATEGORIES). */
  category: string;
  /** One-sentence summary shown in search results and cards. */
  summary: string;
  /** Search keywords (lowercased on read). */
  keywords: string[];
  /** Ids of related articles shown at the foot of the article. */
  related?: string[];
  /**
   * In-app destination for the feature this article documents (e.g. `/debt`).
   * When present, the Help Center renders a "Go to the feature" link so readers
   * can jump straight from the docs to the tool.
   */
  route?: string;
}

export const HELP_CATEGORIES: HelpCategoryMeta[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    blurb: 'Your home base: portfolio stats, recent work and analytics.',
  },
  {
    id: 'valuations',
    label: 'Valuations',
    blurb: 'Create, track and manage each valuation engagement end to end.',
  },
  { id: 'methodology', label: 'Methodology', blurb: 'How value is allocated: OPM, PWERM, Hybrid and CVM.' },
  {
    id: 'cap-table',
    label: 'Cap Table',
    blurb: 'Share classes, options and the ownership structure we value.',
  },
  {
    id: 'comparables',
    label: 'Comparable Companies',
    blurb: 'Public and transaction comps that anchor the market approach.',
  },
  {
    id: 'financials',
    label: 'Financial Data',
    blurb: 'The financial model and statements that feed the engine.',
  },
  {
    id: 'assumptions',
    label: 'Assumptions',
    blurb: 'DLOM, volatility, discount rate and the other key inputs.',
  },
  {
    id: 'ai-agents',
    label: 'AI Agents',
    blurb: 'Automated data extraction, checks and drafting assistance.',
  },
  {
    id: 'reports',
    label: 'Report Generation',
    blurb: 'Draft, version and publish the audit-ready valuation report.',
  },
  {
    id: 'board-approval',
    label: 'Board Approval',
    blurb: 'Route the final value to the board and capture signatures.',
  },
  { id: 'grants', label: 'Grant Management', blurb: 'ASC 718 stock-comp expense from your option grants.' },
  {
    id: 'health-checks',
    label: 'Health Checks',
    blurb: 'Automated QA that catches issues before the report ships.',
  },
  { id: 'sensitivity', label: 'Sensitivity Analysis', blurb: 'See how the FMV moves as key inputs change.' },
  { id: 'pwerm', label: 'PWERM', blurb: 'Probability-weighted exit scenarios in depth.' },
  { id: 'value-bridge', label: 'Value Bridge', blurb: 'Explain what changed between two valuation dates.' },
  {
    id: 'client-portal',
    label: 'Client Portal',
    blurb: 'What clients and partners see, and how to collaborate.',
  },
  {
    id: 'engagement',
    label: 'Engagement Lifecycle',
    blurb: 'The 14-state workflow from request to published.',
  },
  { id: 'mfa', label: 'MFA / 2FA', blurb: 'Protect your account with a second authentication factor.' },
  { id: 'monitoring', label: 'Monitoring', blurb: 'Watch for events that may trigger a fresh valuation.' },
  { id: 'organizations', label: 'Organizations', blurb: 'Multi-entity and fund-portfolio structures.' },
  { id: 'billing', label: 'Billing', blurb: 'Subscriptions, retainers, invoices and payments.' },
  {
    id: 'auditor-portal',
    label: 'Auditor Portal',
    blurb: 'Give external auditors scoped, read-only access.',
  },
  { id: 'sso', label: 'SSO (SAML / SCIM)', blurb: 'Enterprise single sign-on and directory provisioning.' },
  {
    id: 'data-retention',
    label: 'Data Retention',
    blurb: 'Retention policies and legal holds for your records.',
  },
  { id: 'hris', label: 'HRIS Integration', blurb: 'Sync headcount and grants from your payroll system.' },
  { id: 'settings', label: 'Settings', blurb: 'Profile, notifications and system-wide preferences.' },
  {
    id: 'asc718-public',
    label: 'ASC 718 (Public Company)',
    blurb: 'Measure options, ESPPs, RSUs and relative-TSR awards off market data.',
  },
  {
    id: 'fund-holdings',
    label: 'Fund Holdings (ASC 820)',
    blurb: 'Mark a fund portfolio to fair value, build NAV and run the LP waterfall.',
  },
  {
    id: 'debt-valuation',
    label: 'Debt Valuation',
    blurb: 'Value bonds, term loans, convertible notes and SAFEs.',
  },
];

export const HELP_ARTICLES: HelpArticleContent[] = [
  // ── Getting started ──────────────────────────────────────────────────────
  {
    id: 'what-is-409a',
    title: 'What is a 409A valuation?',
    category: 'valuations',
    summary: 'A plain-language primer on 409A valuations and why your company needs one.',
    keywords: ['409a', 'fmv', 'fair market value', 'irs', 'strike price', 'basics', 'intro'],
    related: ['creating-a-valuation', 'methodology-overview', 'getting-started-guide'],
  },
  {
    id: 'getting-started-guide',
    title: 'Getting started: your first valuation',
    category: 'valuations',
    summary: 'The end-to-end path from company setup to a board-approved report.',
    keywords: ['getting started', 'onboarding', 'first', 'begin', 'checklist', 'setup', 'guide'],
    related: ['what-is-409a', 'creating-a-valuation', 'engagement-overview'],
  },

  // ── Dashboard ────────────────────────────────────────────────────────────
  {
    id: 'dashboard-overview',
    title: 'Using the dashboard',
    category: 'dashboard',
    summary: 'Read your portfolio at a glance — stats, recent valuations and analytics.',
    keywords: ['dashboard', 'home', 'stats', 'overview', 'analytics', 'pivot'],
    related: ['getting-started-guide', 'valuations-overview'],
  },

  // ── Valuations ───────────────────────────────────────────────────────────
  {
    id: 'valuations-overview',
    title: 'Managing valuations',
    category: 'valuations',
    summary: 'The valuations list, filters and how each engagement is organized.',
    keywords: ['valuations', 'list', 'filter', 'workspace', 'tabs', 'manage'],
    related: ['creating-a-valuation', 'engagement-overview', 'client-portal-overview'],
  },
  {
    id: 'creating-a-valuation',
    title: 'Creating a valuation',
    category: 'valuations',
    summary: 'Start a new engagement and what to have ready before you do.',
    keywords: ['create', 'new', 'start', 'request', 'onboarding', 'company'],
    related: ['getting-started-guide', 'cap-table-basics', 'financial-data-overview'],
  },

  // ── Methodology ──────────────────────────────────────────────────────────
  {
    id: 'methodology-overview',
    title: 'Valuation methodology overview',
    category: 'methodology',
    summary: 'How total equity value is estimated and then allocated to common stock.',
    keywords: ['methodology', 'approach', 'asset', 'income', 'market', 'allocation', 'weights'],
    related: [
      'methodology-opm',
      'pwerm-overview',
      'methodology-hybrid',
      'methodology-cvm',
      'assumptions-overview',
    ],
  },
  {
    id: 'methodology-opm',
    title: 'Option Pricing Method (OPM)',
    category: 'methodology',
    summary: 'The Black-Scholes backsolve that allocates equity value across share classes.',
    keywords: ['opm', 'option pricing', 'black-scholes', 'backsolve', 'breakpoints'],
    related: ['methodology-overview', 'pwerm-overview', 'methodology-hybrid', 'assumptions-volatility'],
  },
  {
    id: 'methodology-hybrid',
    title: 'Hybrid method (OPM + PWERM)',
    category: 'methodology',
    summary: 'Blend near-term discrete exits with a long-run option model.',
    keywords: ['hybrid', 'opm', 'pwerm', 'blend', 'weight'],
    related: ['methodology-opm', 'pwerm-overview', 'methodology-overview'],
  },
  {
    id: 'methodology-cvm',
    title: 'Current Value Method (CVM)',
    category: 'methodology',
    summary: "Allocate today's equity value straight down the liquidation waterfall.",
    keywords: ['cvm', 'current value', 'waterfall', 'liquidation', 'early stage'],
    related: ['methodology-overview', 'methodology-opm', 'cap-table-basics'],
  },

  // ── Cap Table ────────────────────────────────────────────────────────────
  {
    id: 'cap-table-basics',
    title: 'Cap table basics',
    category: 'cap-table',
    summary: 'Share classes, options and preferences — the ownership structure we value.',
    keywords: [
      'cap table',
      'shares',
      'classes',
      'preferred',
      'common',
      'options',
      'preferences',
      'waterfall',
    ],
    related: ['cap-table-sync', 'methodology-opm', 'methodology-cvm'],
  },
  {
    id: 'cap-table-sync',
    title: 'Syncing your cap table (Carta / Pulley)',
    category: 'cap-table',
    summary: 'Pull share classes and grants straight from your equity-management tool.',
    keywords: ['carta', 'pulley', 'sync', 'api', 'cap table', 'import', 'live'],
    related: ['cap-table-basics', 'hris-overview'],
  },

  // ── Comparable Companies ────────────────────────────────────────────────
  {
    id: 'comparables-overview',
    title: 'Comparable companies',
    category: 'comparables',
    summary: 'How public and transaction comps anchor the market approach.',
    keywords: ['comparables', 'comps', 'public', 'multiples', 'revenue', 'ebitda', 'market approach'],
    related: ['methodology-overview', 'ai-agents-overview', 'financial-data-overview'],
  },

  // ── Financial Data ───────────────────────────────────────────────────────
  {
    id: 'financial-data-overview',
    title: 'Financial data and the model',
    category: 'financials',
    summary: 'The statements and model inputs that feed the compute engine.',
    keywords: ['financials', 'model', 'income statement', 'balance sheet', 'projections', 'cash', 'debt'],
    related: ['assumptions-overview', 'ai-agents-overview', 'cap-table-basics'],
  },

  // ── Assumptions ──────────────────────────────────────────────────────────
  {
    id: 'assumptions-overview',
    title: 'Valuation assumptions',
    category: 'assumptions',
    summary: 'The key inputs — volatility, discount rate, DLOM and weights — and what they mean.',
    keywords: ['assumptions', 'dlom', 'dloc', 'volatility', 'discount rate', 'risk-free', 'weights'],
    related: [
      'assumptions-volatility',
      'assumptions-discount-rate',
      'assumptions-dlom',
      'sensitivity-overview',
    ],
  },
  {
    id: 'assumptions-volatility',
    title: 'Volatility',
    category: 'assumptions',
    summary: "What volatility is, how it's estimated, and why it matters for the OPM.",
    keywords: ['volatility', 'sigma', 'opm', 'black-scholes', 'standard deviation'],
    related: ['methodology-opm', 'assumptions-overview', 'sensitivity-overview', 'comparables-overview'],
  },
  {
    id: 'assumptions-discount-rate',
    title: 'Discount rate',
    category: 'assumptions',
    summary: 'The required return used to bring future exit value back to present value.',
    keywords: ['discount rate', 'wacc', 'required return', 'dcf', 'pwerm', 'present value'],
    related: ['pwerm-overview', 'assumptions-overview', 'methodology-overview'],
  },
  {
    id: 'assumptions-dlom',
    title: 'DLOM and DLOC',
    category: 'assumptions',
    summary: "Discounts for lack of marketability and control, and how they're computed.",
    keywords: ['dlom', 'dloc', 'marketability', 'control', 'chaffee', 'finnerty', 'discount'],
    related: ['assumptions-overview', 'assumptions-volatility', 'methodology-overview'],
  },

  // ── AI Agents ────────────────────────────────────────────────────────────
  {
    id: 'ai-agents-overview',
    title: 'AI agents',
    category: 'ai-agents',
    summary: 'How automated agents extract data, run checks and draft content.',
    keywords: ['ai', 'agents', 'extraction', 'missing data', 'automation', 'assistant'],
    related: ['financial-data-overview', 'comparables-overview', 'health-checks-overview'],
  },

  // ── Report Generation ────────────────────────────────────────────────────
  {
    id: 'report-overview',
    title: 'Generating the report',
    category: 'reports',
    summary: 'Draft, version and publish the audit-ready valuation report.',
    keywords: ['report', 'pdf', 'draft', 'publish', 'version', 'sections', 'template'],
    related: ['board-approval-overview', 'engagement-overview', 'ai-agents-overview'],
  },

  // ── Board Approval ───────────────────────────────────────────────────────
  {
    id: 'board-approval-overview',
    title: 'Board approval',
    category: 'board-approval',
    summary: 'Route the final valuation to your board and capture signatures.',
    keywords: ['board', 'approval', 'signature', 'resolution', 'sign', 'consent'],
    related: ['report-overview', 'engagement-overview', 'auditor-portal-overview'],
  },

  // ── Grant Management ─────────────────────────────────────────────────────
  {
    id: 'grants-overview',
    title: 'Grant management & ASC 718 (private company)',
    category: 'grants',
    summary: 'Turn a private company’s option grants into ASC 718 stock-comp expense off the 409A FMV.',
    keywords: [
      'grants',
      'asc 718',
      'private company',
      'stock compensation',
      'expense',
      'vesting',
      'black-scholes',
      'esop',
    ],
    related: ['asc718-public-overview', 'hris-overview', 'cap-table-sync', 'what-is-409a'],
  },

  // ── Health Checks ────────────────────────────────────────────────────────
  {
    id: 'health-checks-overview',
    title: 'Health checks',
    category: 'health-checks',
    summary: 'Automated QA that catches issues before the report ships.',
    keywords: ['health', 'checks', 'qa', 'validation', 'quality', 'warnings', 'errors'],
    related: ['report-overview', 'sensitivity-overview', 'assumptions-overview'],
  },

  // ── Sensitivity Analysis ─────────────────────────────────────────────────
  {
    id: 'sensitivity-overview',
    title: 'Sensitivity analysis',
    category: 'sensitivity',
    summary: 'See how the common-stock FMV moves as key inputs change.',
    keywords: ['sensitivity', 'what-if', 'scenario', 'volatility', 'tornado', 'inputs'],
    related: ['assumptions-overview', 'health-checks-overview', 'value-bridge-overview'],
  },

  // ── PWERM ────────────────────────────────────────────────────────────────
  {
    id: 'pwerm-overview',
    title: 'PWERM: probability-weighted scenarios',
    category: 'pwerm',
    summary: 'Value common stock by weighting concrete exit outcomes by probability.',
    keywords: ['pwerm', 'scenarios', 'ipo', 'acquisition', 'probability', 'exit', 'expected return'],
    related: ['methodology-hybrid', 'methodology-opm', 'assumptions-discount-rate', 'methodology-overview'],
  },

  // ── Value Bridge ─────────────────────────────────────────────────────────
  {
    id: 'value-bridge-overview',
    title: 'Value bridge',
    category: 'value-bridge',
    summary: 'Explain what drove the change between two valuation dates.',
    keywords: ['value bridge', 'bridge', 'change', 'waterfall', 'period', 'comparison', 'drivers'],
    related: ['sensitivity-overview', 'monitoring-overview', 'report-overview'],
  },

  // ── Client Portal ────────────────────────────────────────────────────────
  {
    id: 'client-portal-overview',
    title: 'The client & partner portal',
    category: 'client-portal',
    summary: 'What clients and partners see, and how to collaborate on an engagement.',
    keywords: ['client', 'portal', 'partner', 'collaborate', 'chat', 'access', 'white-label'],
    related: ['settings-overview', 'organizations-overview', 'engagement-overview'],
  },

  // ── Engagement Lifecycle ─────────────────────────────────────────────────
  {
    id: 'engagement-overview',
    title: 'The engagement lifecycle',
    category: 'engagement',
    summary: 'The 14-state workflow every valuation moves through.',
    keywords: ['engagement', 'lifecycle', 'states', 'workflow', 'status', 'pending', 'published', 'waiting'],
    related: ['client-portal-overview', 'valuations-overview', 'monitoring-overview'],
  },

  // ── MFA / 2FA ────────────────────────────────────────────────────────────
  {
    id: 'mfa-overview',
    title: 'Multi-factor authentication (MFA)',
    category: 'mfa',
    summary: 'Add a second factor with an authenticator app to protect your account.',
    keywords: ['mfa', '2fa', 'two-factor', 'totp', 'authenticator', 'security', 'otp'],
    related: ['sso-overview', 'settings-overview'],
  },

  // ── Monitoring ───────────────────────────────────────────────────────────
  {
    id: 'monitoring-overview',
    title: 'Valuation monitoring',
    category: 'monitoring',
    summary: "Watch for events that may mean it's time for a fresh valuation.",
    keywords: ['monitoring', 'monitor', 'alerts', 'material event', 'expiry', '12 months', 'refresh'],
    related: ['value-bridge-overview', 'engagement-overview', 'what-is-409a'],
  },

  // ── Organizations ────────────────────────────────────────────────────────
  {
    id: 'organizations-overview',
    title: 'Organizations & multi-entity',
    category: 'organizations',
    summary: 'Manage multiple entities or a fund portfolio under one account.',
    keywords: ['organizations', 'multi-entity', 'fund', 'portfolio', 'entities', 'group', 'subsidiary'],
    related: ['client-portal-overview', 'billing-overview', 'settings-overview'],
  },

  // ── Billing ──────────────────────────────────────────────────────────────
  {
    id: 'billing-overview',
    title: 'Billing & payments',
    category: 'billing',
    summary: 'Subscriptions, retainers, invoices and how to pay.',
    keywords: ['billing', 'payment', 'invoice', 'subscription', 'retainer', 'stripe', 'card'],
    related: ['organizations-overview', 'settings-overview'],
  },

  // ── Auditor Portal ───────────────────────────────────────────────────────
  {
    id: 'auditor-portal-overview',
    title: 'The external auditor portal',
    category: 'auditor-portal',
    summary: 'Give your auditors scoped, read-only access to the evidence they need.',
    keywords: ['auditor', 'audit', 'external', 'read-only', 'evidence', 'access', 'review'],
    related: ['board-approval-overview', 'data-retention-overview', 'report-overview'],
  },

  // ── SSO ──────────────────────────────────────────────────────────────────
  {
    id: 'sso-overview',
    title: 'Enterprise SSO (SAML & SCIM)',
    category: 'sso',
    summary: 'Sign in with your identity provider and provision users automatically.',
    keywords: ['sso', 'saml', 'scim', 'okta', 'azure', 'identity provider', 'provisioning', 'enterprise'],
    related: ['mfa-overview', 'settings-overview', 'organizations-overview'],
  },

  // ── Data Retention ───────────────────────────────────────────────────────
  {
    id: 'data-retention-overview',
    title: 'Data retention & legal holds',
    category: 'data-retention',
    summary: 'Control how long records are kept and place holds when needed.',
    keywords: ['retention', 'legal hold', 'delete', 'policy', 'compliance', 'archive', 'gdpr'],
    related: ['auditor-portal-overview', 'settings-overview', 'sso-overview'],
  },

  // ── HRIS Integration ─────────────────────────────────────────────────────
  {
    id: 'hris-overview',
    title: 'HRIS & payroll integration',
    category: 'hris',
    summary: 'Sync headcount and grant data from your payroll/HR system for ASC 718.',
    keywords: [
      'hris',
      'payroll',
      'integration',
      'sync',
      'headcount',
      'grants',
      'asc 718',
      'employees',
      'rippling',
      'gusto',
      'deel',
    ],
    related: ['grants-overview', 'cap-table-sync', 'organizations-overview'],
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  {
    id: 'settings-overview',
    title: 'Settings, profile & roles',
    category: 'settings',
    summary: 'Manage your profile, notifications, roles and system preferences.',
    keywords: ['settings', 'profile', 'notifications', 'roles', 'permissions', 'preferences', 'account'],
    related: ['mfa-overview', 'sso-overview', 'organizations-overview', 'client-portal-overview'],
  },

  // ── ASC 718 (Public Company) ─────────────────────────────────────────────
  {
    id: 'asc718-public-overview',
    title: 'ASC 718 for public companies',
    category: 'asc718-public',
    summary: 'Measure stock-based compensation for a public issuer off its own market price.',
    keywords: [
      'asc 718',
      'public company',
      'stock compensation',
      'stock-based comp',
      'market price',
      'ticker',
      'espp',
      'rsu',
      'tsr',
      'expected term',
      'sab 107',
      'lattice',
    ],
    route: '/valuations',
    related: ['asc718-expected-term', 'asc718-espp', 'asc718-tsr', 'grants-overview'],
  },
  {
    id: 'asc718-expected-term',
    title: 'Expected term & exercise behaviour',
    category: 'asc718-public',
    summary: 'SAB 107 simplified term, the binomial lattice and historical exercise data.',
    keywords: [
      'expected term',
      'sab 107',
      'simplified method',
      'binomial lattice',
      'exercise behaviour',
      'exercise multiple',
      'suboptimal exercise',
      'contractual term',
      'vesting',
    ],
    route: '/valuations',
    related: ['asc718-public-overview', 'assumptions-volatility', 'grants-overview'],
  },
  {
    id: 'asc718-espp',
    title: 'ESPP valuation with lookback',
    category: 'asc718-public',
    summary: 'Value an employee stock purchase plan, including its lookback and discount.',
    keywords: [
      'espp',
      'employee stock purchase plan',
      'lookback',
      'lookback period',
      'purchase discount',
      'call component',
      'put component',
      'section 423',
    ],
    route: '/valuations',
    related: ['asc718-public-overview', 'asc718-expected-term'],
  },
  {
    id: 'asc718-tsr',
    title: 'Relative TSR (market conditions)',
    category: 'asc718-public',
    summary: 'Monte Carlo valuation of relative total-shareholder-return awards.',
    keywords: [
      'tsr',
      'total shareholder return',
      'relative tsr',
      'market condition',
      'monte carlo',
      'peer group',
      'percentile',
      'payout ratio',
      'psu',
    ],
    route: '/valuations',
    related: ['asc718-public-overview', 'assumptions-volatility', 'comparables-overview'],
  },

  // ── Fund Holdings (ASC 820) ──────────────────────────────────────────────
  {
    id: 'fund-holdings-overview',
    title: 'Fund holdings & ASC 820',
    category: 'fund-holdings',
    summary: 'Mark a fund portfolio to fair value, roll it into NAV and run the LP waterfall.',
    keywords: [
      'asc 820',
      'fair value',
      'fund',
      'portfolio',
      'holdings',
      'nav',
      'net asset value',
      'marks',
      'venture',
      'private equity',
      'lp',
      'waterfall',
    ],
    route: '/funds',
    related: ['fund-fair-value-hierarchy', 'fund-calibrated-opm', 'fund-nav', 'fund-waterfall'],
  },
  {
    id: 'fund-fair-value-hierarchy',
    title: 'ASC 820 fair-value hierarchy (Levels 1–3)',
    category: 'fund-holdings',
    summary: 'How each position is classified Level 1, 2 or 3 by the observability of its inputs.',
    keywords: [
      'asc 820',
      'fair value hierarchy',
      'level 1',
      'level 2',
      'level 3',
      'observable',
      'unobservable',
      'quoted price',
      'mark method',
      'disclosure',
    ],
    route: '/funds',
    related: ['fund-holdings-overview', 'fund-calibrated-opm', 'fund-nav'],
  },
  {
    id: 'fund-calibrated-opm',
    title: 'Calibrated-OPM backsolve for illiquid positions',
    category: 'fund-holdings',
    summary: 'Mark hard-to-value positions with an OPM calibrated to the last round.',
    keywords: [
      'calibrated opm',
      'backsolve',
      'calibration',
      'calibration date',
      'illiquid',
      'level 3',
      'option pricing',
      'last round',
      'fair value mark',
    ],
    route: '/funds',
    related: ['fund-fair-value-hierarchy', 'methodology-opm', 'fund-holdings-overview'],
  },
  {
    id: 'fund-nav',
    title: 'Net asset value (NAV)',
    category: 'fund-holdings',
    summary: 'How position marks roll up into the fund’s net asset value.',
    keywords: [
      'nav',
      'net asset value',
      'gross asset value',
      'unrealized gain',
      'liabilities',
      'cost basis',
      'level breakdown',
      'fund',
    ],
    route: '/funds',
    related: ['fund-holdings-overview', 'fund-fair-value-hierarchy', 'fund-waterfall'],
  },
  {
    id: 'fund-waterfall',
    title: 'LP waterfall & carried interest',
    category: 'fund-holdings',
    summary: 'Distribute proceeds through preferred return, GP catch-up, carry and clawback.',
    keywords: [
      'waterfall',
      'lp',
      'gp',
      'carried interest',
      'carry',
      'carry percentage',
      'preferred return',
      'hurdle',
      'catch-up',
      'clawback',
      'distribution',
      'tiers',
    ],
    route: '/funds',
    related: ['fund-holdings-overview', 'fund-nav', 'methodology-cvm'],
  },

  // ── Debt Valuation ───────────────────────────────────────────────────────
  {
    id: 'debt-valuation-overview',
    title: 'Debt valuation engine',
    category: 'debt-valuation',
    summary: 'Fair-value bonds, term loans, convertible notes and SAFEs.',
    keywords: [
      'debt',
      'bond',
      'term loan',
      'convertible',
      'safe',
      'credit spread',
      'yield',
      'dcf',
      'fair value',
      'fixed income',
      'instrument',
    ],
    route: '/debt',
    related: ['debt-yield-dcf', 'debt-credit-spread', 'debt-convertible', 'debt-safe'],
  },
  {
    id: 'debt-yield-dcf',
    title: 'Yield DCF, duration & convexity',
    category: 'debt-valuation',
    summary: 'Discount a bond or loan’s cash flows at its market yield, with rate analytics.',
    keywords: [
      'yield to maturity',
      'ytm',
      'dcf',
      'discounted cash flow',
      'duration',
      'modified duration',
      'convexity',
      'clean price',
      'dirty price',
      'accrued interest',
      'amortizing',
    ],
    route: '/debt',
    related: ['debt-valuation-overview', 'debt-credit-spread'],
  },
  {
    id: 'debt-credit-spread',
    title: 'Credit-spread pricing',
    category: 'debt-valuation',
    summary: 'Build the discount yield from a benchmark plus a rating-driven credit spread.',
    keywords: [
      'credit spread',
      'benchmark yield',
      'rating',
      'seniority',
      'secured',
      'all-in yield',
      'risk premium',
      'spread',
      'treasury',
    ],
    route: '/debt',
    related: ['debt-valuation-overview', 'debt-yield-dcf'],
  },
  {
    id: 'debt-convertible',
    title: 'Convertible notes (Tsiveriotis-Fernandes)',
    category: 'debt-valuation',
    summary: 'Split a convertible into its debt and equity components on a binomial tree.',
    keywords: [
      'convertible',
      'convertible note',
      'tsiveriotis-fernandes',
      'binomial tree',
      'conversion ratio',
      'parity',
      'straight debt value',
      'option value',
      'credit spread',
    ],
    route: '/debt',
    related: ['debt-valuation-overview', 'debt-credit-spread', 'methodology-opm'],
  },
  {
    id: 'debt-safe',
    title: 'SAFE valuation (cap & discount)',
    category: 'debt-valuation',
    summary: 'Value a SAFE by modelling its conversion into the next priced round.',
    keywords: [
      'safe',
      'simple agreement for future equity',
      'valuation cap',
      'cap amount',
      'discount rate',
      'discount',
      'conversion price',
      'ownership',
      'moic',
      'pre-money',
    ],
    route: '/debt',
    related: ['debt-valuation-overview', 'methodology-opm'],
  },
];

/** The primary "learn more" article id for each category (first match wins). */
export function primaryArticleForCategory(categoryId: string): HelpArticleContent | undefined {
  return HELP_ARTICLES.find((a) => a.category === categoryId);
}

/** Look up a category's metadata by id. */
export function categoryMeta(categoryId: string): HelpCategoryMeta | undefined {
  return HELP_CATEGORIES.find((c) => c.id === categoryId);
}

/** Look up an article by id. */
export function articleById(id: string): HelpArticleContent | undefined {
  return HELP_ARTICLES.find((a) => a.id === id);
}

/**
 * The Markdown bodies, fetched on demand.
 *
 * A dynamic import so the corpus is its own chunk: callers that only label an
 * article (`HelpIcon`, the Features page) never download it, and the ones that
 * render an article pay for it once, at the moment somebody asks to read.
 * Resolves to the same object every time — the module registry caches it, so a
 * second reader is not a second download.
 */
export async function loadHelpBodies(): Promise<Record<string, string>> {
  return (await import('./helpBodies')).HELP_BODIES;
}

/**
 * Case-insensitive search across title, summary and keywords, plus the body of
 * any article whose text the caller has already loaded.
 *
 * `bodies` is a parameter rather than an import because this module no longer
 * holds the prose: a caller that has not loaded it gets a metadata-only match,
 * which is the honest answer for a search running before the corpus arrives.
 * Pass the map from `loadHelpBodies()` to search the full text.
 */
export function searchArticles(query: string, bodies: Record<string, string> = {}): HelpArticleContent[] {
  const q = query.trim().toLowerCase();
  if (!q) return HELP_ARTICLES;
  return HELP_ARTICLES.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      (bodies[a.id] ?? '').toLowerCase().includes(q) ||
      a.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}
