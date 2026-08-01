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
  gtag('config', config.ga4Id);
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
