import { matchRoutes } from 'react-router-dom';

/**
 * What each route calls itself in the browser's `<title>`.
 *
 * The marketing site has had per-page titles since §24: `pageMeta.ts` carries
 * one per published URL and `<Seo>` applies it. Nothing ever did the same for
 * the application, so every one of the ~90 routes behind the login — every
 * admin console, every valuation, all thirty tabs of the workspace — served the
 * `<title>` baked into `index.html`, and the answer to "which page is this" was
 * `DoAide 409A · Valuations` on all of them.
 *
 * That is invisible in a screenshot and lands in four places that matter:
 *
 *  - **Tabs.** An analyst with six valuations open has six identical tabs. The
 *    favicon is identical too, so there is nothing to pick from at all.
 *  - **History and bookmarks.** Every entry the browser records for a session
 *    reads the same, which makes back-navigation by history menu useless and a
 *    bookmark unidentifiable a week later.
 *  - **Screen readers.** The document title is what a screen reader announces
 *    when a page is presented, and — because this is a single-page app, where
 *    no document load happens — it is the string `RouteAnnouncer` reads out on
 *    every navigation. One title means the announcement carries no information.
 *  - **WCAG 2.4.2 Page Titled (Level A)**, which asks for a title that
 *    "describes topic or purpose". A brand name on ninety pages does not.
 *
 * A registry keyed by route pattern rather than a `<Seo>` per page component:
 * the coverage question ("does every route have one?") is then a property of
 * one file that a test can check exhaustively, instead of ninety files where a
 * missing call is a silent omission. `pageTitles.test.ts` holds App.tsx's route
 * table against these keys in both directions.
 *
 * A `null` value is a route that manages its own head tags — the marketing
 * pages, which need a description, a canonical and Open Graph besides the
 * title, and get all of it from `<Seo>`. They are listed rather than omitted so
 * that "not covered" is a decision in the file and not an oversight.
 */
export const ROUTE_TITLES: Readonly<Record<string, string | null>> = {
  // ── Marketing: titled by `<Seo>` from `pageMeta.ts` ────────────────────────
  '/': null,
  '/pricing': null,
  '/which-valuation': null,
  '/409a-valuation-guide': null,
  '/when-do-you-need-a-409a': null,
  '/how-much-does-a-409a-cost': null,
  '/409a-valuation-methods': null,
  '/409a-valuation-cost-comparison': null,
  '/tools/409a-valuation-calculator': null,
  '/tools/stock-option-tax-calculator': null,
  '/tools/409a-compliance-checker': null,
  '/tools/startup-valuation-estimator': null,
  '/tools/readiness-checker': null,
  '/tools/cost-comparison': null,
  '/tools/deadline-widget': null,
  '/tools/deadline-widget/embed': null,
  '/free-tools': null,
  '/resources': null,
  '/sample-report': null,
  '/products/:slug': null,
  '/409a-valuation/:stage': null,
  '/compare/409a-valuation-providers': null,
  '/compare/:slug': null,
  '/partners': null,
  '/partners/:segment': null,
  '/developers': null,
  '/blog': null,
  '/blog/:slug': null,
  '/about': null,
  '/contact': null,
  '/terms-of-service': null,
  '/privacy-policy': null,
  '/referral': null,
  '/share/:token': null,

  // ── Unauthenticated application surfaces ──────────────────────────────────
  '/login': 'Sign in',
  '/register': 'Create an account',
  '/forgot-password': 'Reset your password',
  '/reset-password': 'Choose a new password',
  '/verify-email': 'Verify your email',
  '/accept-invite': 'Accept invitation',
  '/auth/google/complete': 'Signing in',
  '/board-sign': 'Board resolution',
  '/auditor': 'Auditor portal',
  '/intake': 'Client intake',
  '/partner/:slug/login': 'Partner sign in',

  // ── The workspace shell ───────────────────────────────────────────────────
  '/dashboard': 'Dashboard',
  '/valuations': 'Valuations',
  '/portfolio': 'Portfolio',
  '/valuations/new': 'New valuation',
  '/valuations/compare': 'Side-by-side comparison',
  '/onboarding': 'Getting started',
  '/payment/success': 'Payment received',
  '/payment/cancel': 'Payment cancelled',
  '/order': 'Order',

  /*
   * One valuation, thirty tabs. These strings are the tab strip's own labels,
   * verbatim — see `ValuationWorkspace`. A title that paraphrases the control
   * the user just clicked is a second vocabulary to learn for no gain, and the
   * test holds the two together.
   */
  '/valuations/:id': 'Overview',
  '/valuations/:id/progress': 'Progress',
  '/valuations/:id/intake': 'Intake',
  '/valuations/:id/company': 'Company',
  '/valuations/:id/documents': 'Documents',
  '/valuations/:id/cap-table': 'Cap Table',
  '/valuations/:id/model': 'Financial Model',
  '/valuations/:id/params': 'Params',
  '/valuations/:id/workbook': 'Workbook',
  '/valuations/:id/overwrites': 'Overwrites',
  '/valuations/:id/ai': 'AI',
  '/valuations/:id/engagement': 'Engagement',
  '/valuations/:id/tasks': 'Tasks',
  '/valuations/:id/calculations': 'Calculations',
  '/valuations/:id/specialty': 'Specialty Engine',
  '/valuations/:id/research': 'Market Research',
  '/valuations/:id/comparables': 'Comparables',
  '/valuations/:id/qa': 'QA',
  '/valuations/:id/health': 'Health',
  '/valuations/:id/completeness': 'Completeness',
  '/valuations/:id/decisions': 'Decisions',
  '/valuations/:id/scenarios': 'What-If Scenarios',
  '/valuations/:id/sensitivity': 'Sensitivity',
  '/valuations/:id/bridge': 'Value Bridge',
  '/valuations/:id/analytics': 'Analytics',
  '/valuations/:id/report': 'Report',
  '/valuations/:id/grants': 'Grants',
  '/valuations/:id/asc718': 'ASC 718',
  '/valuations/:id/monitoring': 'Monitoring',
  '/valuations/:id/package': 'Package',
  '/valuations/:id/network': 'Network Log',
  '/valuations/:id/audit-trail': 'Change History',

  // ── Operations ────────────────────────────────────────────────────────────
  '/funds': 'Fund Portfolios',
  '/debt': 'Debt Instruments',
  '/engagements': 'Engagement pipeline',
  '/monitors': 'Monitored valuations',
  '/tasks': 'Review tasks',
  '/templates': 'Report templates',
  '/schema/overwrites': 'Overwrites schema',
  '/admin/prompts': 'Bot prompts',
  '/admin/narrative-prompts': 'Narrative library',
  '/admin/data-remediation': 'Data remediation',
  '/admin/documents': 'Document triage',
  '/admin/support': 'Support inbox',
  '/admin/outbox': 'Email outbox',
  '/admin/jobs': 'Background jobs',
  '/admin/operations': 'System health',
  '/admin/communications': 'Communications',
  '/admin/activity': 'Activity log',
  '/admin/help': 'Help articles',
  '/admin/blog': 'Blog',
  '/admin/settings': 'System settings',

  // ── Administration ────────────────────────────────────────────────────────
  '/admin/users': 'Users & roles',
  '/admin/sso': 'Enterprise SSO',
  '/admin/retention': 'Data retention',
  '/admin/partners': 'Partners',
  '/admin/partners/:id': 'Partner',
  '/admin/api-tokens': 'API tokens',

  // ── Everything else behind the login ──────────────────────────────────────
  '/partner': 'Partner portal',
  '/partner/api-docs': 'API reference',
  '/settings/branding': 'Branding',
  '/firm': 'Firm console',
  '/search': 'Search',
  '/notifications': 'Notifications',
  '/inbox': 'Inbox',
  '/help': 'Help Center',
  '/help/:slug': 'Help Center',
  '/features': 'Features',
  '/billing': 'Billing',
  '/settings': 'Settings',

  /*
   * The catch-all. Listed here rather than left to fall off the end so that an
   * unrouted URL gets the same treatment as a routed one — `Page not found`
   * is exactly what the page it renders says, and it is more use in a history
   * menu than the brand alone.
   */
  '*': 'Page not found',
};

/**
 * The registry as route objects, for `matchRoutes`.
 *
 * Matching is React Router's own rather than a hand-rolled loop because the
 * ranking is the whole problem: `/valuations/new` and `/valuations/:id` both
 * match `/valuations/new`, and the static segment has to win. `matchRoutes`
 * applies the same scoring the router itself uses to pick the route, so the
 * title cannot disagree with the page that rendered.
 */
const ROUTE_OBJECTS = Object.keys(ROUTE_TITLES).map((path) => ({ path }));

/**
 * The title for a pathname, or `null` where the route titles itself.
 *
 * Unknown paths fall through to the splat entry, which is the same route the
 * router sends them to.
 */
export function titleForPath(pathname: string): string | null {
  const matches = matchRoutes(ROUTE_OBJECTS, pathname);
  const best = matches?.[matches.length - 1]?.route.path;
  if (best === undefined) return ROUTE_TITLES['*'] ?? null;
  return ROUTE_TITLES[best] ?? null;
}
