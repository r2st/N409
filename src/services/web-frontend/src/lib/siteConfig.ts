/**
 * Environment-configured marketing surface (409.ai §22/§23).
 *
 * The public site links out to things that only exist once the business is
 * actually live — a booking calendar, a demo recording, social profiles, real
 * mailboxes. Hardcoding placeholders means shipping dead links to prospects, so
 * every one of them is read from the build environment and the corresponding UI
 * is *omitted* when it is not configured. A missing value degrades the page; a
 * wrong value costs a lead.
 *
 * All values are baked at build time via `VITE_*` defines (see vite.config.ts).
 */

export interface MarketingEnv {
  VITE_CALENDLY_URL?: string;
  VITE_DEMO_VIDEO_URL?: string;
  VITE_TWITTER_URL?: string;
  VITE_LINKEDIN_URL?: string;
  VITE_PARTNERS_EMAIL?: string;
  VITE_PRIVACY_EMAIL?: string;
  VITE_SUPPORT_EMAIL?: string;
}

/** Trimmed value, or undefined when unset/blank — never an empty string. */
function opt(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Accept only `http(s)` absolute URLs. A malformed or relative value is treated
 * as unset so a typo in deployment config can never render a broken link (or a
 * `javascript:` URL) into the page.
 */
function optUrl(value: string | undefined): string | undefined {
  const raw = opt(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Accept only something that looks like `local@domain.tld`. */
function optEmail(value: string | undefined): string | undefined {
  const raw = opt(value);
  if (!raw) return undefined;
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(raw) ? raw : undefined;
}

export interface SiteConfig {
  /** Booking link for "Book a call". Undefined → CTA falls back to /contact. */
  calendlyUrl?: string;
  /** Demo video embed URL. Undefined → the video facade is not rendered. */
  demoVideoUrl?: string;
  /** Social profiles; each is omitted from the footer when unset. */
  socialLinks: Array<{ label: string; href: string }>;
  /** Partner/enterprise enquiries. Undefined → the page points at /contact. */
  partnersEmail?: string;
  /** Privacy/data-subject requests. Undefined → the page points at /contact. */
  privacyEmail?: string;
  /** General support. Undefined → the page points at /contact. */
  supportEmail?: string;
}

/**
 * Resolve the marketing configuration. Takes the env explicitly so tests can
 * exercise both the configured and the unconfigured site without touching
 * `import.meta.env`.
 */
export function siteConfig(env: MarketingEnv = import.meta.env as MarketingEnv): SiteConfig {
  const twitter = optUrl(env.VITE_TWITTER_URL);
  const linkedin = optUrl(env.VITE_LINKEDIN_URL);
  return {
    calendlyUrl: optUrl(env.VITE_CALENDLY_URL),
    demoVideoUrl: optUrl(env.VITE_DEMO_VIDEO_URL),
    socialLinks: [
      ...(twitter ? [{ label: 'X (Twitter)', href: twitter }] : []),
      ...(linkedin ? [{ label: 'LinkedIn', href: linkedin }] : []),
    ],
    partnersEmail: optEmail(env.VITE_PARTNERS_EMAIL),
    privacyEmail: optEmail(env.VITE_PRIVACY_EMAIL),
    supportEmail: optEmail(env.VITE_SUPPORT_EMAIL),
  };
}
