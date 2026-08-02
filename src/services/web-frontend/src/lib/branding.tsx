import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';

/**
 * White-label branding — the firm's identity, applied to the whole app.
 *
 * Two things happen here and nothing else: the resolved brand is put in context
 * for components that render a name or a logo, and the server-computed accent
 * ramp is written into the document as CSS custom properties. The token
 * mapping lives in index.css (`:root[data-brand='on']`), so re-pointing five
 * variables re-skins every accented surface in the product without any
 * component knowing branding exists.
 *
 * All colour maths is the API's (domain/branding.ts). If the client derived its
 * own shades, the app and the PDF report would drift apart, which is precisely
 * the bug a firm notices first.
 */

export interface Branding {
  tenant_id: string | null;
  name: string;
  tagline: string | null;
  accent: string;
  accent_dark: string;
  accent_fg: string;
  accent_dark_fg: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  support_email: string | null;
  white_label: boolean;
}

export interface BrandingCss {
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface BrandingResponse {
  branding: Branding;
  css: BrandingCss;
}

/** Mirrors PLATFORM_BRANDING on the server — the pre-fetch and fallback brand. */
export const PLATFORM_BRANDING: Branding = {
  tenant_id: null,
  name: 'N409',
  tagline: 'Valuations',
  accent: '#12936f',
  accent_dark: '#43cca0',
  accent_fg: '#ffffff',
  accent_dark_fg: '#08251c',
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  support_email: null,
  white_label: false,
};

/**
 * Is this actually a branding payload?
 *
 * `api()` rejects on a network failure or a non-2xx, and the caller below
 * already swallows that — an unbranded tenant is the norm and a failed lookup
 * must never block the app. What it could not survive was a *200 carrying the
 * wrong body*: `setBranding(res.branding)` happily stored `undefined`, and the
 * next render of `<Wordmark>` read `branding.name` off it and threw. That is
 * not a blank logo, it is the whole authenticated shell replaced by "Something
 * went wrong" — sidebar, navigation and the sign-out button included — with
 * nothing in the console, because the same `.catch` that was meant to make
 * branding optional also swallowed the TypeError raised one line later.
 *
 * A 200 with an unexpected body is not exotic in front of a reverse proxy: an
 * error page served as 200, a half-finished deploy where the route is answered
 * by another service, a tenant record that came back empty. The response is
 * checked before it is allowed to become state, and only the fields that are
 * actually dereferenced need to be present.
 */
function isBrandingResponse(value: unknown): value is BrandingResponse {
  if (typeof value !== 'object' || value === null) return false;
  const branding = (value as { branding?: unknown }).branding;
  if (typeof branding !== 'object' || branding === null) return false;
  const b = branding as Partial<Branding>;
  return (
    typeof b.name === 'string' &&
    b.name.length > 0 &&
    typeof b.white_label === 'boolean' &&
    (b.favicon_url === null || typeof b.favicon_url === 'string')
  );
}

interface BrandingContextValue {
  branding: Branding;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: PLATFORM_BRANDING,
  refresh: async () => {},
});

const STYLE_ELEMENT_ID = 'n409-brand-theme';

function declarations(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      // Values come from our own API and are hex strings, but a stray `}` or
      // `<` would break out of the rule, so anything unexpected is dropped.
      .filter(([name, value]) => /^--[a-z-]+$/.test(name) && /^#[0-9a-fA-F]{6}$/.test(value))
      .map(([name, value]) => `${name}:${value};`)
      .join('')
  );
}

/**
 * Writes (or clears) the brand stylesheet. Two rules — the dark one carries an
 * extra attribute so it wins when both match — which is what lets index.css map
 * the accent tokens exactly once for both themes.
 */
export function applyBrandingCss(branding: Branding, css: BrandingCss | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  let style = document.getElementById(STYLE_ELEMENT_ID);

  if (!branding.white_label || !css) {
    root.removeAttribute('data-brand');
    style?.remove();
    return;
  }

  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.append(style);
  }
  style.textContent =
    `:root[data-brand='on']{${declarations(css.light)}}` +
    `:root[data-brand='on'][data-theme='dark']{${declarations(css.dark)}}`;
  root.setAttribute('data-brand', 'on');
}

/** Swaps the tab icon for the firm's. Restored to the platform icon on clear. */
function applyFavicon(href: string | null): void {
  if (typeof document === 'undefined') return;
  const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) return;
  if (href) {
    link.dataset.platformHref ??= link.href;
    link.href = href;
  } else if (link.dataset.platformHref) {
    link.href = link.dataset.platformHref;
  }
}

export function BrandingProvider({
  children,
  /** Test seam, and how the branded login page passes a slug-resolved brand. */
  initial,
}: {
  children: ReactNode;
  initial?: BrandingResponse;
}) {
  const { status } = useAuth();
  const [branding, setBranding] = useState<Branding>(initial?.branding ?? PLATFORM_BRANDING);

  const applyResponse = useCallback((res: unknown) => {
    if (!isBrandingResponse(res)) {
      // Keep whatever brand is already showing — platform, or the one this
      // session resolved at login. Replacing it with a malformed payload is
      // how the shell used to crash; replacing it with PLATFORM_BRANDING would
      // silently un-brand a firm's workspace over one bad response.
      throw new Error('/branding returned an unexpected payload');
    }
    setBranding(res.branding);
    applyBrandingCss(res.branding, res.css ?? null);
    applyFavicon(res.branding.favicon_url);
  }, []);

  const refresh = useCallback(async () => {
    applyResponse(await api<unknown>('/branding'));
  }, [applyResponse]);

  useEffect(() => {
    if (initial) {
      applyBrandingCss(initial.branding, initial.css);
      applyFavicon(initial.branding.favicon_url);
      return;
    }

    // /branding needs a session, and a 401 from api() signs the user out — so
    // this waits for auth rather than probing. Signing out reverts to platform
    // branding, which is also what the shared-machine case wants.
    if (status !== 'authenticated') {
      setBranding(PLATFORM_BRANDING);
      applyBrandingCss(PLATFORM_BRANDING, null);
      applyFavicon(null);
      return;
    }

    // Guarded rather than delegated to refresh(): a response landing after the
    // user signed out must not paint the firm's brand over a login screen.
    let cancelled = false;
    api<unknown>('/branding')
      .then((res) => {
        if (!cancelled) applyResponse(res);
      })
      // An unbranded tenant is the norm and a failed lookup must never block
      // the app — platform branding is already applied. A malformed 200 lands
      // here too, via the throw in applyResponse, and is treated the same way:
      // the brand on screen stays put and the app keeps running.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initial, status, applyResponse]);

  const value = useMemo(() => ({ branding, refresh }), [branding, refresh]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): Branding {
  return useContext(BrandingContext).branding;
}

/**
 * Re-reads the tenant's brand. The branding settings page calls this after a
 * save so the firm sees its own colours applied immediately rather than on the
 * next reload — the change it just made is the thing it wants to look at.
 */
export function useBrandingRefresh(): () => Promise<void> {
  return useContext(BrandingContext).refresh;
}

/**
 * Document title suffix. A firm's client should see the firm's name in the tab,
 * not ours — so this is what page titles append instead of a hard-coded 'N409'.
 */
export function useBrandName(): string {
  return useBranding().name;
}

/** The logo for a given ground, falling back to the light asset. */
export function brandLogo(branding: Branding, ground: 'light' | 'dark'): string | null {
  return ground === 'dark' ? (branding.logo_dark_url ?? branding.logo_url) : branding.logo_url;
}

export { BrandingContext };
