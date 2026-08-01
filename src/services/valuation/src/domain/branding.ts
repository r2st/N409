import { z } from 'zod';

/**
 * White-label branding — the identity a valuation firm puts in front of its own
 * clients (migration 0091).
 *
 * Everything here is pure: a partner row goes in, a fully-resolved `Branding`
 * comes out with no nulls left for a caller to guess at. That matters because
 * the same resolved object drives three renderers that cannot share code — the
 * SPA (CSS custom properties), the PDF cover, and the workflow emails — and a
 * firm's blue must be the same blue in all three.
 *
 * The colour maths is WCAG relative luminance. A firm picks one accent; the
 * product still has to place readable text on it and show it against a dark
 * sidebar, and asking a non-designer to supply four coherent colours is how
 * white-label ends up looking broken. So we derive what we can and only ask for
 * an override when the firm actually wants one.
 */

/** A resolved, render-ready brand. No nulls except genuinely optional assets. */
export interface Branding {
  /** Partner id, or null when this is the platform's own branding. */
  tenant_id: string | null;
  /** Public-facing firm name — window title, sidebar wordmark, report cover. */
  name: string;
  tagline: string | null;
  /** Accent on light surfaces, `#rrggbb`. */
  accent: string;
  /** Accent on dark chrome (sidebar, auth panel), `#rrggbb`. */
  accent_dark: string;
  /** Readable text colour to place *on* a filled `accent` swatch. */
  accent_fg: string;
  /** Readable text colour to place on a filled `accent_dark` swatch. */
  accent_dark_fg: string;
  logo_url: string | null;
  /** Logo for dark chrome; falls back to `logo_url`. */
  logo_dark_url: string | null;
  favicon_url: string | null;
  support_email: string | null;
  /** False when the tenant shows platform branding (the default). */
  white_label: boolean;
}

/** The product's own identity — the fallback for every unbranded tenant. */
export const PLATFORM_BRANDING: Branding = {
  tenant_id: null,
  name: 'N409',
  tagline: 'Valuations',
  // bond-500 / bond-400: the accent ramp from the SPA theme. The dark variant
  // lifts off the near-black chrome, which #12936f does not.
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

/** chrome-900 — the sidebar/auth ground `accent_dark` has to survive against. */
export const DARK_SURFACE = '#0b1220';
/** paper-50 — the light content ground. */
export const LIGHT_SURFACE = '#faf9f6';

/** Text colours we are willing to place on an accent, darkest and lightest. */
const ON_ACCENT_DARK = '#0b1220';
const ON_ACCENT_LIGHT = '#ffffff';

/** WCAG AA for large text / UI components. An accent is always one or the other. */
const MIN_ACCENT_CONTRAST = 3;

export interface BrandingSource {
  id: string;
  name: string;
  brand_name: string | null;
  brand_tagline: string | null;
  brand_color: string | null;
  accent_color_dark: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  support_email: string | null;
  white_label_enabled: boolean;
}

/**
 * `#rgb` and `#rrggbb`, with or without the hash, any case → `#rrggbb` lower.
 * Returns null for anything else rather than throwing: callers are resolving a
 * stored value, and a bad row must degrade to the default, not 500 the page.
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    const [r, g, b] = raw.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

function toRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** WCAG 2.1 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of near-black / white reads better on `background`. */
export function readableForeground(background: string): string {
  return contrastRatio(background, ON_ACCENT_DARK) >= contrastRatio(background, ON_ACCENT_LIGHT)
    ? ON_ACCENT_DARK
    : ON_ACCENT_LIGHT;
}

/** Move each channel `amount` (0–1) of the way toward white (+) or black (−). */
export function shade(hex: string, amount: number): string {
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  return toHex(toRgb(hex).map((c) => c + (target - c) * t) as [number, number, number]);
}

/**
 * Nudge `color` away from `background` until it clears `minRatio`.
 *
 * A firm's navy is a perfectly good brand colour and completely invisible on
 * our near-black sidebar. Rather than refuse it, we lighten (or darken, on a
 * light ground) in small steps — the hue survives, the contrast is earned.
 * Gives up at pure white/black, which always clears 3:1 against our surfaces.
 */
export function ensureContrast(color: string, background: string, minRatio = MIN_ACCENT_CONTRAST): string {
  if (contrastRatio(color, background) >= minRatio) return color;
  // Step toward whichever end is further from the background.
  const direction = relativeLuminance(background) < 0.5 ? 1 : -1;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = shade(color, direction * (step / 20));
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return direction > 0 ? '#ffffff' : '#000000';
}

/**
 * Partner row → render-ready branding.
 *
 * A tenant with `white_label_enabled = false` resolves to platform branding
 * outright, even if colours are stored — a firm can stage its brand and flip it
 * live in one switch, and turning it off is a true revert rather than a
 * field-by-field clear.
 */
export function resolveBranding(source: BrandingSource | null | undefined): Branding {
  if (!source || !source.white_label_enabled) return PLATFORM_BRANDING;

  const accent = normalizeHex(source.brand_color) ?? PLATFORM_BRANDING.accent;
  // An explicit dark accent is honoured as-is only if it is legible; otherwise
  // it is treated the same as a derived one.
  const accentDark = ensureContrast(normalizeHex(source.accent_color_dark) ?? accent, DARK_SURFACE);

  return {
    tenant_id: source.id,
    name: source.brand_name?.trim() || source.name,
    tagline: source.brand_tagline?.trim() || null,
    accent: ensureContrast(accent, LIGHT_SURFACE),
    accent_dark: accentDark,
    accent_fg: readableForeground(accent),
    accent_dark_fg: readableForeground(accentDark),
    logo_url: source.logo_url,
    logo_dark_url: source.logo_dark_url ?? source.logo_url,
    favicon_url: source.favicon_url,
    support_email: source.support_email,
    white_label: true,
  };
}

/**
 * CSS custom properties for one theme mode.
 *
 * The SPA themes itself by re-pointing design tokens (index.css does exactly
 * this for dark mode), so white-label needs a whole accent ramp, not one
 * colour: a tint to fill panels, a muted step for their borders, the accent
 * itself, a stronger step for hover, and a legible foreground. Deriving the
 * ramp here rather than in the client is what keeps the app, the PDF cover and
 * the branded emails on the same green.
 *
 * Light mode tints toward white and hovers darker; dark mode does the reverse,
 * matching how the bond ramp already moves between the two themes.
 */
export function brandingCssVariables(
  branding: Branding,
  mode: 'light' | 'dark' = 'light',
): Record<string, string> {
  const accent = mode === 'dark' ? branding.accent_dark : branding.accent;
  const fg = mode === 'dark' ? branding.accent_dark_fg : branding.accent_fg;
  const [softAmount, mutedAmount, strongAmount] =
    mode === 'dark' ? [-0.78, -0.55, 0.16] : [0.92, 0.72, -0.18];

  return {
    '--brand-accent': accent,
    '--brand-accent-fg': fg,
    '--brand-accent-soft': shade(accent, softAmount),
    '--brand-accent-muted': shade(accent, mutedAmount),
    '--brand-accent-strong': shade(accent, strongAmount),
  };
}

const HEX_COLOR = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour')
  .nullable();

/**
 * What a firm administrator may change about their own brand. Deliberately
 * narrower than the ops-side partner patch: no name/key/archive, which are
 * channel administration rather than branding.
 */
export const BRANDING_PATCH_SCHEMA = z
  .object({
    brand_name: z.string().min(1).max(200).nullable(),
    brand_tagline: z.string().max(200).nullable(),
    brand_color: HEX_COLOR,
    accent_color_dark: HEX_COLOR,
    logo_url: z.string().url().max(2000).nullable(),
    logo_dark_url: z.string().url().max(2000).nullable(),
    favicon_url: z.string().url().max(2000).nullable(),
    support_email: z.string().email().max(320).nullable(),
    white_label_enabled: z.boolean(),
  })
  .partial()
  .strict();

export type BrandingPatch = z.infer<typeof BRANDING_PATCH_SCHEMA>;
