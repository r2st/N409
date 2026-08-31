/**
 * Web analytics wiring (409.ai §23): Google Tag Manager, Google Analytics 4,
 * and the Facebook/Meta Pixel. All IDs come from build-time environment
 * variables (`GTM_ID` / `GA4_ID` / `FB_PIXEL_ID`, surfaced to the client as
 * `import.meta.env.VITE_*` — see vite.config.ts) so nothing is hardcoded and
 * each environment configures its own containers.
 *
 * Scripts are injected imperatively rather than baked into index.html so they
 * only run once the visitor has granted cookie consent (409.ai §25). Every
 * injector is idempotent and safe to call repeatedly.
 *
 * ## What these containers may see
 *
 * A page view carries the URL, and this SPA serves the marketing site and the
 * signed-in product out of one document. So a container loaded here reports
 * whatever the address bar holds — and inside the product that is an
 * engagement id, a client's company name in a filter, and, on the admin user
 * search, the address an operator typed to find somebody. Google and Meta are
 * third parties: sending them that is a disclosure, not a measurement.
 *
 * Two rules follow, and both are enforced rather than intended.
 *
 * 1. **Nothing loads once there is a session.** `<Analytics>` injects only
 *    while `useAuth()` reports `anonymous`, which is exactly "this browser is
 *    outside the product" — a signed-out visitor cannot reach a product route,
 *    and a signed-in one never gets a container at all. The predicate is the
 *    session rather than a copy of the router's path list, so a route added to
 *    the product tomorrow is covered without an edit.
 *
 *    The one case a mount-time predicate cannot cover on its own is signing in
 *    *within* a document that already loaded them: a script cannot be
 *    unloaded, and GA4's history-based page views are configured in the
 *    property, not here. `LoginPage` closes it by handing the product a fresh
 *    document when {@link analyticsLoadedIn} says this one is carrying
 *    containers.
 *
 * 2. **The URL a container is given is scrubbed.** The public surface holds
 *    the three credential-bearing routes — password reset, email verification,
 *    invitation acceptance — and each strips its token from the address bar on
 *    mount. That is a race this does not need to win: {@link scrubAnalyticsUrl}
 *    blanks the same query parameters the API blanks before writing a request
 *    line (`SENSITIVE_QUERY_PARAMS` in packages/shared/src/problem.ts), so the
 *    first page view cannot carry a live token even if it is measured first.
 */

export interface AnalyticsConfig {
  /** Google Tag Manager container id, e.g. `GTM-XXXXXXX`. */
  gtmId: string;
  /** Google Analytics 4 measurement id, e.g. `G-XXXXXXXXXX`. */
  ga4Id: string;
  /** Facebook/Meta Pixel id, e.g. `123456789012345`. */
  fbPixelId: string;
}

/** Shape of the subset of `import.meta.env` we read. */
export interface AnalyticsEnv {
  VITE_GTM_ID?: string;
  VITE_GA4_ID?: string;
  VITE_FB_PIXEL_ID?: string;
}

/** Pure config reader — trims values and treats blanks/undefined as "off". */
export function readAnalyticsConfig(env: AnalyticsEnv): AnalyticsConfig {
  return {
    gtmId: (env.VITE_GTM_ID ?? '').trim(),
    ga4Id: (env.VITE_GA4_ID ?? '').trim(),
    fbPixelId: (env.VITE_FB_PIXEL_ID ?? '').trim(),
  };
}

/** Read the config baked in at build time. */
export function analyticsConfigFromEnv(): AnalyticsConfig {
  return readAnalyticsConfig(import.meta.env as AnalyticsEnv);
}

/** True when at least one provider id is configured. */
export function hasAnyAnalytics(config: AnalyticsConfig): boolean {
  return Boolean(config.gtmId || config.ga4Id || config.fbPixelId);
}

/**
 * Query parameters whose value must never reach a third-party container.
 *
 * A duplicate of `SENSITIVE_QUERY_PARAMS` in packages/shared/src/problem.ts,
 * and duplicated by construction: web-frontend has no `@n409/shared`
 * dependency, which is why every rule this browser restates about the server's
 * vocabulary is pinned by a test rather than shared as code. `test/
 * analyticsUrl.test.ts` holds the two lists to each other.
 *
 * The server's list carries its own reasoning for each name; the two that make
 * this browser copy load-bearing are `token` — the reset, verification and
 * invitation links, all of which land on a public route with the credential in
 * the query — and `code`, the OAuth authorization code on the four callbacks.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'state',
  'signature',
  'sig',
  'secret',
  'client_secret',
  'key',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'session',
  'sid',
  'password',
  'passwd',
  'pwd',
  'email',
];

const SENSITIVE_QUERY_PARAM_SET = new Set(SENSITIVE_QUERY_PARAMS);

/**
 * `href` with every credential-bearing parameter blanked, for the one field a
 * container lets us set: GA4's `page_location`.
 *
 * Blanked rather than dropped, for the reason the server's scrub keeps the key:
 * "a reset link was opened" and "a reset link was opened with no token" are
 * different facts, and losing the parameter loses the first one.
 *
 * A URL the browser cannot parse is answered with the path alone. There is no
 * safe way to hand on a string this cannot read, and a page view with no query
 * is a measurement; a page view with an unparsed one could be a credential.
 */
export function scrubAnalyticsUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return '/';
  }
  let touched = false;
  for (const key of [...url.searchParams.keys()]) {
    if (!SENSITIVE_QUERY_PARAM_SET.has(key.toLowerCase())) continue;
    url.searchParams.set(key, 'REDACTED');
    touched = true;
  }
  if (!touched) return href;
  return url.toString();
}

interface DataLayerWindow extends Window {
  dataLayer?: unknown[];
  __n409AnalyticsLoaded?: Partial<Record<'gtm' | 'ga4' | 'fbq', boolean>>;
}

function loadedFlags(win: DataLayerWindow): NonNullable<DataLayerWindow['__n409AnalyticsLoaded']> {
  win.__n409AnalyticsLoaded ??= {};
  return win.__n409AnalyticsLoaded;
}

function appendScript(doc: Document, src: string, id: string): void {
  if (doc.getElementById(id)) return;
  const script = doc.createElement('script');
  script.id = id;
  script.async = true;
  script.src = src;
  doc.head.appendChild(script);
}

/** Inject the GTM loader and seed `dataLayer` with the `gtm.start` event. */
export function injectGtm(config: AnalyticsConfig, win: DataLayerWindow, doc: Document): void {
  if (!config.gtmId) return;
  const flags = loadedFlags(win);
  if (flags.gtm) return;
  flags.gtm = true;
  win.dataLayer = win.dataLayer ?? [];
  win.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  appendScript(
    doc,
    `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(config.gtmId)}`,
    'n409-gtm',
  );
}

/** Inject gtag.js and configure the GA4 measurement id. */
export function injectGa4(config: AnalyticsConfig, win: DataLayerWindow, doc: Document): void {
  if (!config.ga4Id) return;
  const flags = loadedFlags(win);
  if (flags.ga4) return;
  flags.ga4 = true;
  win.dataLayer = win.dataLayer ?? [];
  // gtag pushes its arguments object onto dataLayer verbatim.
  const gtag = (...args: unknown[]): void => {
    win.dataLayer!.push(args);
  };
  gtag('js', new Date());
  // `page_location` explicitly, rather than letting gtag.js read the address
  // bar: the three token routes are public and land with the credential still
  // in the query, and this is the only field the container lets us set. See
  // `scrubAnalyticsUrl`.
  // `win.location` is read defensively because this injector is called with a
  // stub window by its own tests and, in principle, before a document has one.
  // An absent location scrubs to `/`, which is the same answer an unparseable
  // one gets and for the same reason: a page view with no query is a
  // measurement, one with an unread query could be a credential.
  gtag('config', config.ga4Id, {
    page_location: scrubAnalyticsUrl(win.location?.href ?? ''),
  });
  appendScript(
    doc,
    `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.ga4Id)}`,
    'n409-ga4',
  );
}

interface FbqWindow extends Window {
  fbq?: FbqFn & {
    queue?: unknown[];
    loaded?: boolean;
    version?: string;
    callMethod?: (...a: unknown[]) => void;
  };
  _fbq?: unknown;
}
type FbqFn = (...args: unknown[]) => void;

/** Inject the Facebook/Meta Pixel base code, init the pixel, and track PageView. */
export function injectFbPixel(config: AnalyticsConfig, win: FbqWindow, doc: Document): void {
  if (!config.fbPixelId) return;
  const flags = loadedFlags(win as unknown as DataLayerWindow);
  if (flags.fbq) return;
  flags.fbq = true;
  if (!win.fbq) {
    const fbq = ((...args: unknown[]): void => {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue!.push(args);
    }) as NonNullable<FbqWindow['fbq']>;
    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = '2.0';
    win.fbq = fbq;
    win._fbq = win._fbq ?? fbq;
  }
  appendScript(doc, 'https://connect.facebook.net/en_US/fbevents.js', 'n409-fbq');
  win.fbq('init', config.fbPixelId);
  win.fbq('track', 'PageView');
}

/**
 * Whether this document is already carrying a third-party container.
 *
 * Read by the sign-in path: a script cannot be unloaded, so a document that
 * loaded GTM, GA4 or the Pixel while the visitor was anonymous would go on
 * reporting every product URL they then navigate to. The answer is a fresh
 * document, and this is the question that decides whether one is needed —
 * asked rather than assumed, so a deployment with no container ids configured
 * pays nothing for a rule that protects nothing there.
 */
export function analyticsLoadedIn(win: Window = window): boolean {
  return Object.values((win as DataLayerWindow).__n409AnalyticsLoaded ?? {}).some(Boolean);
}

/**
 * Load every configured provider. Idempotent: safe to call on mount and again
 * whenever consent flips to granted.
 */
export function injectAnalytics(
  config: AnalyticsConfig,
  win: Window = window,
  doc: Document = document,
): void {
  injectGtm(config, win as DataLayerWindow, doc);
  injectGa4(config, win as DataLayerWindow, doc);
  injectFbPixel(config, win as FbqWindow, doc);
}
