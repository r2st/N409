import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Dark-mode audit, as a test.
 *
 * Dark mode here is not a set of `dark:` variants — it is one block in
 * index.css that re-points the design tokens (see the long comment there). The
 * consequence is that a component is theme-correct *by construction* as long as
 * every colour it names is a token that block moves. The three ways to escape
 * that are a stock Tailwind palette step nobody re-pointed, a literal
 * `text-white`/`bg-black` on a surface that inverts underneath it, and a hex
 * written straight into a TSX attribute.
 *
 * All three are invisible in a light-mode screenshot and in every existing
 * test, because the component renders perfectly — against the wrong ground. So
 * they are checked here against the source, which is the only place the
 * distinction exists. Each rule below is a bug this file was written to catch,
 * with the callsite named in its allowlist entry or its fix.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(srcDir);
  return out.sort();
}

const FILES = sourceFiles().map((file) => ({
  /** Repo-relative, so a failure names something you can open. */
  name: path.relative(path.join(here, '..'), file),
  text: readFileSync(file, 'utf8'),
}));

const css = readFileSync(path.join(srcDir, 'index.css'), 'utf8');

/** The `--color-*` names a `:root[...]` block re-points, by selector. */
function tokensInBlock(selector: string): Set<string> {
  const start = css.indexOf(selector);
  expect(start, `${selector} block missing from index.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const end = css.indexOf('\n}', open);
  const body = css.slice(open, end);
  return new Set([...body.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]!));
}

const DARK_TOKENS = tokensInBlock(":root[data-theme='dark']");

/**
 * Tailwind's stock palette families. Anything from one of these is a colour
 * with a fixed value baked into the framework: it does not know about
 * `data-theme`, so unless the dark block re-points that exact step it renders
 * its light-mode value on a dark page. The N409 families (ink, paper, bond,
 * chrome, surface, chart…) are excluded because they are ours and the block
 * moves them — or, for `chrome` and `brass`, deliberately does not.
 */
const STOCK_FAMILIES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

const UTILITY_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'from',
  'to',
  'via',
  'fill',
  'stroke',
  'decoration',
  'divide',
  'outline',
  'accent',
  'placeholder',
  'caret',
  'shadow',
];

const STOCK_UTILITY = new RegExp(
  `\\b(?:${UTILITY_PREFIXES.join('|')})-(${STOCK_FAMILIES.join('|')})-(\\d{2,3})\\b`,
  'g',
);

describe('dark mode — stock palette steps', () => {
  it('re-points every Tailwind palette step the app actually uses', () => {
    // `bg-rose-50` + `text-rose-800` was the whole rose family: a near-white
    // #fff1f2 panel with dark red text, on the Stripe test-mode warning and the
    // research tab's "not summarised" badge. Both moved to `red`, which the
    // dark block does re-point, rather than growing the block a family for two
    // callsites of a colour the rest of the app never uses.
    const escapes: string[] = [];
    for (const { name, text } of FILES) {
      for (const [, family, step] of text.matchAll(STOCK_UTILITY)) {
        if (DARK_TOKENS.has(`${family}-${step}`)) continue;
        escapes.push(`${name}: ${family}-${step}`);
      }
    }
    expect([...new Set(escapes)].sort()).toEqual([]);
  });

  it('keeps the dark block free of steps nothing uses', () => {
    // The inverse check: a re-pointed step with no callsite is a value nobody
    // can see and nobody will maintain. Cheap to run, and it means the list
    // above is the real inventory rather than an aspiration.
    const used = new Set<string>();
    for (const { text } of FILES) {
      for (const [, family, step] of text.matchAll(STOCK_UTILITY)) used.add(`${family}-${step}`);
    }
    const stray = [...DARK_TOKENS].filter((token) => {
      const family = token.replace(/-\d+$/, '');
      return STOCK_FAMILIES.includes(family) && !used.has(token);
    });
    expect(stray.sort()).toEqual([]);
  });
});

describe('dark mode — literal black and white', () => {
  /**
   * `white` and `black` are the two colours that cannot be re-pointed, so each
   * one has to sit on a fill that stays put in both themes: a `bond` or
   * `chrome` surface, or a firm's white-label accent, which is a tenant's
   * choice rather than a theme's.
   */
  const ALLOWED = new Map<string, string>([
    [
      'src/pages/ClientIntakePage.tsx',
      'step pip on the firm accent — `style` supplies accent_fg, the class is its fallback',
    ],
    ['src/pages/PartnerDetailPage.tsx', 'sign-in tile in the branding preview, on the firm accent'],
  ]);

  it('never puts white or black on a surface that inverts under it', () => {
    // NetworkTab drew its selected service filter as `bg-ink-900 text-white`
    // while its twelve siblings across the app used `bg-ink-900 text-paper-50`.
    // In dark mode `ink-900` is #eef1f7 — so the chip was white on white, and
    // the analyst's current filter was the one thing on the page they could
    // not read. Its siblings inverted to dark-on-light and stayed legible.
    const hits: string[] = [];
    for (const { name, text } of FILES) {
      if (name.endsWith('index.css') || ALLOWED.has(name)) continue;
      for (const [match] of text.matchAll(
        new RegExp(`\\b(?:${UTILITY_PREFIXES.join('|')})-(?:white|black)\\b`, 'g'),
      )) {
        hits.push(`${name}: ${match}`);
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  it('lists only allowlisted files that still contain one', () => {
    // An allowlist that outlives its callsite silently licenses the next one.
    for (const [name, why] of ALLOWED) {
      const file = FILES.find((f) => f.name === name);
      expect(file, `${name} is allowlisted but gone — drop the entry`).toBeDefined();
      expect(
        new RegExp(`\\b(?:${UTILITY_PREFIXES.join('|')})-(?:white|black)\\b`).test(file!.text),
        `${name} no longer needs its allowlist entry (${why})`,
      ).toBe(true);
    }
  });
});

describe('dark mode — hex literals in components', () => {
  /**
   * A hex in a TSX attribute is the one colour in the app that cannot follow
   * the theme. Two forms are fine and the regex below tolerates both: a
   * fallback inside `var(--token, #hex)`, which only ever renders if the token
   * is undefined, and the files here, where the hex is the subject rather than
   * the styling.
   */
  const ALLOWED = new Map<string, string>([
    ['src/lib/theme.ts', 'the two theme-color meta values — they are the theme, not styled by it'],
    ['src/lib/branding.tsx', 'the default white-label ramp; these values are the tokens'],
    ['src/pages/LoginPage.tsx', "Google's four brand colours in the federated sign-in mark"],
    ['src/pages/PartnerLoginPage.tsx', 'fallback accent for a partner with no branding set'],
    ['src/pages/PartnerDetailPage.tsx', 'fallback accent and the colour-input placeholders'],
    ['src/pages/BrandingPage.tsx', 'the colour input default'],
    ['src/components/charts.tsx', 'heatmap text on a saturated alpha fill, opaque in both themes'],
  ]);

  it('names a token instead of a hex everywhere else', () => {
    // The chart series were eight hex literals in PALETTE plus six more spread
    // across the analytics tab and the vesting curve. Half failed WCAG's 3:1
    // non-text minimum on the dark card — `#3b5b7d` sat at 2.4:1, so the
    // volatility line was a dark stroke on a dark ground. They are
    // `--color-chart-1..8` now, lifted in the dark block.
    const hits: string[] = [];
    for (const { name, text } of FILES) {
      if (ALLOWED.has(name)) continue;
      // Strip `var(--token, #hex)` fallbacks before looking for bare hexes.
      const bare = text.replace(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g, 'var()');
      for (const [match] of bare.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) hits.push(`${name}: ${match}`);
    }
    expect(hits.sort()).toEqual([]);
  });
});

describe('dark mode — the chart ramp', () => {
  it('defines all eight series in both themes', () => {
    const light = tokensInBlock('@theme');
    for (let i = 1; i <= 8; i += 1) {
      expect(light.has(`chart-${i}`), `--color-chart-${i} missing from @theme`).toBe(true);
      expect(DARK_TOKENS.has(`chart-${i}`), `--color-chart-${i} missing from the dark block`).toBe(true);
    }
  });

  it('clears the 3:1 non-text contrast floor against the dark card', () => {
    // The reason the ramp is re-pointed rather than reused. A 2px line stroke
    // and a 7px donut arc are graphical objects, so WCAG 1.4.11 applies: 3:1
    // against the adjacent colour, which for every chart in the app is
    // `--color-surface`.
    const darkBlock = css.slice(css.indexOf(":root[data-theme='dark']"));
    const surface = /--color-surface:\s*(#[0-9a-fA-F]{6})/.exec(darkBlock)?.[1];
    expect(surface).toBeDefined();

    const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };

    for (let i = 1; i <= 8; i += 1) {
      const value = new RegExp(`--color-chart-${i}:\\s*(#[0-9a-fA-F]{6})`).exec(darkBlock)?.[1];
      expect(value, `--color-chart-${i} is not a 6-digit hex in the dark block`).toBeDefined();
      expect(ratio(value!, surface!), `--color-chart-${i} (${value}) on ${surface}`).toBeGreaterThan(3);
    }
  });
});
