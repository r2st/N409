import { describe, expect, it } from 'vitest';
import {
  BRANDING_PATCH_SCHEMA,
  brandingCssVariables,
  contrastRatio,
  DARK_SURFACE,
  ensureContrast,
  LIGHT_SURFACE,
  normalizeHex,
  PLATFORM_BRANDING,
  readableForeground,
  relativeLuminance,
  resolveBranding,
  shade,
  type BrandingSource,
} from '../../src/domain/branding.js';

const source = (over: Partial<BrandingSource> = {}): BrandingSource => ({
  id: '01J0PARTNER0000000000000000',
  name: 'Meridian Valuation Partners LLP',
  brand_name: null,
  brand_tagline: null,
  brand_color: null,
  accent_color_dark: null,
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  support_email: null,
  white_label_enabled: true,
  ...over,
});

describe('normalizeHex', () => {
  it('expands shorthand and lower-cases', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('#1D4ED8')).toBe('#1d4ed8');
  });

  it('accepts a missing hash and surrounding whitespace', () => {
    expect(normalizeHex(' 1d4ed8 ')).toBe('#1d4ed8');
  });

  it('rejects anything else rather than throwing', () => {
    // A malformed stored value must degrade to the default, not 500 the page.
    for (const bad of ['', '#12345', 'rebeccapurple', '#gggggg', null, undefined]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe('relativeLuminance / contrastRatio', () => {
  it('anchors at the WCAG endpoints', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('is symmetric and self-identity is 1', () => {
    expect(contrastRatio('#12936f', '#faf9f6')).toBeCloseTo(contrastRatio('#faf9f6', '#12936f'), 10);
    expect(contrastRatio('#12936f', '#12936f')).toBeCloseTo(1, 10);
  });
});

describe('readableForeground', () => {
  it('puts white on dark grounds and near-black on light ones', () => {
    expect(readableForeground('#0b1220')).toBe('#ffffff');
    expect(readableForeground('#f5d90a')).toBe('#0b1220');
  });

  it('always clears 4.5:1 on the platform accents', () => {
    for (const accent of [PLATFORM_BRANDING.accent, PLATFORM_BRANDING.accent_dark]) {
      expect(contrastRatio(accent, readableForeground(accent))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('shade', () => {
  it('moves toward white and black without overflowing a channel', () => {
    expect(shade('#000000', 1)).toBe('#ffffff');
    expect(shade('#ffffff', -1)).toBe('#000000');
    expect(shade('#808080', 0)).toBe('#808080');
  });
});

describe('ensureContrast', () => {
  it('leaves a colour alone when it already clears the ratio', () => {
    expect(ensureContrast('#43cca0', DARK_SURFACE)).toBe('#43cca0');
  });

  it('lifts a dark navy off the dark sidebar', () => {
    // The motivating case: a firm's brand navy is invisible on chrome-900.
    const lifted = ensureContrast('#101a3a', DARK_SURFACE);
    expect(lifted).not.toBe('#101a3a');
    expect(contrastRatio(lifted, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('darkens toward the other end on a light ground', () => {
    const darkened = ensureContrast('#fdfdfb', LIGHT_SURFACE);
    expect(relativeLuminance(darkened)).toBeLessThan(relativeLuminance('#fdfdfb'));
    expect(contrastRatio(darkened, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('resolves every 6-digit grey against both surfaces', () => {
    for (let v = 0; v <= 255; v += 17) {
      const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
      expect(contrastRatio(ensureContrast(hex, DARK_SURFACE), DARK_SURFACE)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(ensureContrast(hex, LIGHT_SURFACE), LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('resolveBranding', () => {
  it('falls back to platform branding for an unknown tenant', () => {
    expect(resolveBranding(null)).toEqual(PLATFORM_BRANDING);
    expect(resolveBranding(undefined)).toEqual(PLATFORM_BRANDING);
  });

  it('ignores stored branding until the tenant switch is on', () => {
    // Staging a brand must not leak it: the switch is the only thing that
    // publishes, and turning it off is a true revert.
    const staged = resolveBranding(
      source({ white_label_enabled: false, brand_name: 'Meridian', brand_color: '#7c3aed' }),
    );
    expect(staged).toEqual(PLATFORM_BRANDING);
  });

  it('uses the public brand name, falling back to the internal channel name', () => {
    expect(resolveBranding(source({ brand_name: 'Meridian Valuations' })).name).toBe('Meridian Valuations');
    expect(resolveBranding(source()).name).toBe('Meridian Valuation Partners LLP');
    // A whitespace-only override is not a name.
    expect(resolveBranding(source({ brand_name: '   ' })).name).toBe('Meridian Valuation Partners LLP');
  });

  it('derives a legible dark accent when the firm supplies only one colour', () => {
    const branding = resolveBranding(source({ brand_color: '#101a3a' }));
    expect(contrastRatio(branding.accent_dark, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(branding.accent, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(branding.accent, branding.accent_fg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(branding.accent_dark, branding.accent_dark_fg)).toBeGreaterThanOrEqual(3);
  });

  it('corrects an explicit dark accent that would be illegible', () => {
    const branding = resolveBranding(source({ brand_color: '#7c3aed', accent_color_dark: '#0c0f18' }));
    expect(branding.accent_dark).not.toBe('#0c0f18');
    expect(contrastRatio(branding.accent_dark, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('falls back to the light logo for dark chrome, but keeps an explicit one', () => {
    expect(resolveBranding(source({ logo_url: 'https://cdn.example.com/a.svg' })).logo_dark_url).toBe(
      'https://cdn.example.com/a.svg',
    );
    expect(
      resolveBranding(
        source({ logo_url: 'https://cdn.example.com/a.svg', logo_dark_url: 'https://cdn.example.com/b.svg' }),
      ).logo_dark_url,
    ).toBe('https://cdn.example.com/b.svg');
  });

  it('normalises a shorthand colour stored by an older client', () => {
    // #036 already clears contrast on paper, so it survives resolution intact
    // and isolates expansion from the contrast correction tested above.
    expect(resolveBranding(source({ brand_color: '#036' })).accent).toBe('#003366');
  });

  it('darkens a pale accent that would vanish on the light content ground', () => {
    const branding = resolveBranding(source({ brand_color: '#aabbcc' }));
    expect(branding.accent).not.toBe('#aabbcc');
    expect(contrastRatio(branding.accent, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the platform accent when the stored colour is unusable', () => {
    expect(resolveBranding(source({ brand_color: 'not-a-colour' })).accent).toBe(PLATFORM_BRANDING.accent);
  });

  it('marks the tenant so a client can tell inherited from owned branding', () => {
    const branding = resolveBranding(source({ brand_color: '#7c3aed' }));
    expect(branding.white_label).toBe(true);
    expect(branding.tenant_id).toBe('01J0PARTNER0000000000000000');
    expect(PLATFORM_BRANDING.white_label).toBe(false);
  });
});

describe('brandingCssVariables', () => {
  const branding = resolveBranding(source({ brand_color: '#7c3aed' }));

  it('emits the ramp the SPA theme re-points, as valid hex', () => {
    const vars = brandingCssVariables(branding);
    expect(Object.keys(vars).sort()).toEqual([
      '--brand-accent',
      '--brand-accent-fg',
      '--brand-accent-muted',
      '--brand-accent-soft',
      '--brand-accent-strong',
    ]);
    for (const value of Object.values(vars)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('tints toward white in light mode and toward black in dark mode', () => {
    const light = brandingCssVariables(branding, 'light');
    const dark = brandingCssVariables(branding, 'dark');
    // The soft step fills panels, so it must sit near the surface it fills.
    expect(relativeLuminance(light['--brand-accent-soft']!)).toBeGreaterThan(
      relativeLuminance(light['--brand-accent']!),
    );
    expect(relativeLuminance(dark['--brand-accent-soft']!)).toBeLessThan(
      relativeLuminance(dark['--brand-accent']!),
    );
  });

  it('keeps panel text legible against the tint it fills', () => {
    for (const mode of ['light', 'dark'] as const) {
      const vars = brandingCssVariables(branding, mode);
      const bodyText = mode === 'dark' ? '#eef1f7' : '#0b1220';
      expect(contrastRatio(vars['--brand-accent-soft']!, bodyText)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('BRANDING_PATCH_SCHEMA', () => {
  it('accepts a partial patch and nullable clears', () => {
    expect(BRANDING_PATCH_SCHEMA.safeParse({ brand_color: '#7c3aed' }).success).toBe(true);
    expect(BRANDING_PATCH_SCHEMA.safeParse({ logo_url: null }).success).toBe(true);
    expect(BRANDING_PATCH_SCHEMA.safeParse({}).success).toBe(true);
  });

  it('rejects unknown keys so a patch cannot reach other partner columns', () => {
    const parsed = BRANDING_PATCH_SCHEMA.safeParse({ brand_color: '#7c3aed', key: 'other-firm' });
    expect(parsed.success).toBe(false);
  });

  it('rejects malformed colours, URLs and emails', () => {
    expect(BRANDING_PATCH_SCHEMA.safeParse({ brand_color: 'purple' }).success).toBe(false);
    expect(BRANDING_PATCH_SCHEMA.safeParse({ brand_color: '#abc' }).success).toBe(false);
    expect(BRANDING_PATCH_SCHEMA.safeParse({ logo_url: 'not a url' }).success).toBe(false);
    expect(BRANDING_PATCH_SCHEMA.safeParse({ support_email: 'nope' }).success).toBe(false);
  });
});
