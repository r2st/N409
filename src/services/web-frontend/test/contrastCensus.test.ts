import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA contrast, as a test.
 *
 * Contrast is the one accessibility property no other test in this suite can
 * see. jsdom resolves no custom properties and computes no colours, so every
 * render test here passes on text that is invisible; and the theme is built by
 * re-pointing design tokens (see the long comment in index.css), so a component
 * whose classes are all "correct" still renders against whichever ground the
 * *other* theme moved underneath it. A light-mode screenshot cannot show it
 * either. The only place the pairing exists is the source, so that is what this
 * reads.
 *
 * Three bugs it was written to catch, all of them live when it was added:
 *
 *   1. The sidebar user avatar was `bg-bond-700 text-chrome-fg`. `chrome` is
 *      the family that deliberately does *not* invert — it is the brand
 *      furniture that stays dark in both themes — while the bond ramp moves
 *      *up* in dark mode so the accent lifts off a dark ground. So in dark mode
 *      the initials were #faf9f6 on #6bdcb6: **1.59:1**, a near-white glyph on
 *      a light mint disc. index.css already carries the token that exists for
 *      exactly this (`--color-bond-fg`, "foreground for anything sitting on a
 *      filled bond swatch"), and its comment even names the failure — "white on
 *      #43cca0 is unreadable". One call site reached for the wrong one.
 *
 *   2. The progress stepper's "done" pip was `bg-emerald-500 text-bond-fg`:
 *      white on #00bc7d, **2.47:1** in light mode. It carries the step number
 *      or the ✓, so it is text, and it is the densest thing on the tab.
 *
 *   3. `text-ink-400` on `bg-paper-200` — the muted badge tone — is **4.35:1**,
 *      which misses AA by a hair and did so at sixteen call sites: every
 *      "Archived", "Revoked", "Expired" and "calc" chip in the product, plus
 *      two step pips. A near-miss repeated sixteen times is still sixteen
 *      unreadable badges, and it is precisely the kind nobody eyeballs.
 *
 * What this reads is a pair written in **one class string** — `bg-…` and
 * `text-…` on the same element. That is the case where the source states the
 * pairing outright and no rendering is needed to know it. Text that inherits
 * its ground from an ancestor is out of scope and stays out: guessing the
 * effective background needs a layout, and a census that guesses is worse than
 * one with a stated edge.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TAILWIND_THEME = path.resolve(HERE, '../../../../node_modules/tailwindcss/theme.css');

type Rgb = [number, number, number];

/**
 * OKLCh → sRGB, per CSS Color 4.
 *
 * Needed because Tailwind v4 ships its default palette in `oklch()`, and half
 * the colours in play here (every status ramp — red, amber, emerald, sky,
 * violet) come from that palette rather than from index.css. The conversion is
 * proved against known values below; the whole census rests on it, so it is not
 * taken on faith.
 */
function oklchToRgb(lightness: number, chroma: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((u) => {
    const v = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(v * 255)));
  }) as Rgb;
}

function parseColor(value: string): Rgb | null {
  const v = value.trim();
  const six = /^#([0-9a-f]{6})$/i.exec(v)?.[1];
  if (six) return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16)) as Rgb;
  const three = /^#([0-9a-f]{3})$/i.exec(v)?.[1];
  if (three) return [...three].map((c) => parseInt(c + c, 16)) as Rgb;
  const oklch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(v);
  if (oklch) return oklchToRgb(Number(oklch[1]) / 100, Number(oklch[2]), Number(oklch[3]));
  // Anything else — a gradient, a colour-mix, a bare keyword — is not a flat
  // fill this can reason about, so it drops out rather than being guessed at.
  return null;
}

/** Every `--color-*` a block declares, resolved to sRGB. */
function colorVars(css: string): Record<string, Rgb> {
  const out: Record<string, Rgb> = {};
  for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = m;
    if (!name || !value) continue;
    const rgb = parseColor(value);
    if (rgb) out[name] = rgb;
  }
  return out;
}

/**
 * A token by name, or a thrown error.
 *
 * Deliberately not `tokens[name] ?? something`: a token that is not in the
 * theme means the name is a typo or the ramp was renamed, and either way the
 * honest answer is to stop. Defaulting would score the pair against a colour
 * nothing renders and report a pass.
 */
function tone(tokens: Record<string, Rgb>, name: string): Rgb {
  const rgb = tokens[name];
  if (!rgb) throw new Error(`no --color-${name} in the theme`);
  return rgb;
}

/** The `{ … }` body of the first block whose header matches. */
function block(css: string, header: string): string {
  const at = css.indexOf(header);
  if (at === -1) throw new Error(`index.css has no ${header} block`);
  return css.slice(at, css.indexOf('\n}', at));
}

const INDEX_CSS = readFileSync(path.join(SRC, 'index.css'), 'utf8');
/** Tailwind's defaults first, then this app's overrides on top of them. */
const LIGHT = {
  ...colorVars(readFileSync(TAILWIND_THEME, 'utf8')),
  ...colorVars(block(INDEX_CSS, '@theme {')),
};
/** Dark re-points a subset; everything it does not name keeps its light value. */
const DARK = { ...LIGHT, ...colorVars(block(INDEX_CSS, ":root[data-theme='dark'] {")) };

const relativeLuminance = ([r, g, b]: Rgb): number => {
  const f = (c: number) => {
    const u = c / 255;
    return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

/*
 * WCAG 1.4.3: 4.5:1 for body text, 3:1 for "large" text — 18.66px bold, or
 * 24px at any weight. Mapped onto this app's type scale, that is `text-2xl`
 * (24px) and up unconditionally, and `text-lg`/`text-xl` (18/20px) only when
 * the same string also sets a bold weight. Everything else is body text. The
 * exemption is kept deliberately tight: reading it loosely is how a census
 * ends up blessing the small print it exists to check.
 */
const LARGE = /\btext-(2xl|3xl|4xl|5xl|6xl|7xl)\b/;
const LARGE_IF_BOLD = /\btext-(lg|xl)\b/;
const BOLD = /\bfont-(semibold|bold|black)\b/;

/** Named tokens that are a colour but carry no numeric step. */
const FLAT = 'surface|skeleton|skeleton-sheen|chrome-fg|chrome-dim|chrome-faint|bond-fg';
const BG = new RegExp(String.raw`(?:^|\s)bg-([a-z]+-[0-9]+|${FLAT})(?=\s|$)`);
const FG = new RegExp(String.raw`(?:^|\s)text-([a-z]+-[0-9]+|${FLAT})(?=\s|$)`);

type Pair = { where: string; classes: string; fg: string; bg: string; needs: number };

/**
 * Every foreground/background pair the source states in a single class string.
 *
 * Any quoted run is read, not just `className="…"`: the conditional tones are
 * written as bare strings in a lookup table or a ternary arm
 * (`archived: 'bg-paper-200 text-ink-400 ring-ink-200'`), and those are where
 * the muted-badge bug lived. A string that does not resolve to two known
 * tokens is skipped, which is what keeps `text-sm`, `text-center` and
 * `bg-[url(…)]` out.
 */
function pairs(): Pair[] {
  const found: Pair[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/["'`]([^"'`\n]*(?:bg-|text-)[^"'`\n]*)["'`]/g)) {
      const classes = m[1];
      if (!classes) continue;
      const bg = BG.exec(classes)?.[1];
      const fg = FG.exec(classes)?.[1];
      if (!bg || !fg || !LIGHT[bg] || !LIGHT[fg]) continue;
      const large = LARGE.test(classes) || (LARGE_IF_BOLD.test(classes) && BOLD.test(classes));
      found.push({
        where: `${path.relative(SRC, file)}:${text.slice(0, m.index).split('\n').length}`,
        classes,
        fg,
        bg,
        needs: large ? 3 : 4.5,
      });
    }
  }
  return found;
}

const PAIRS = pairs();

describe('the colour maths is right before anything is asked of it', () => {
  it('converts OKLCh to sRGB', () => {
    // The sRGB primaries and both endpoints, in the OKLCh coordinates CSS
    // Color 4 gives for them. If Tailwind's palette is being misread, it is
    // these that say so — not a contrast number, which is plausible when wrong.
    const hex = (rgb: Rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
    expect(hex(oklchToRgb(0, 0, 0))).toBe('#000000');
    expect(hex(oklchToRgb(1, 0, 0))).toBe('#ffffff');
    expect(hex(oklchToRgb(0.62796, 0.25768, 29.234))).toBe('#ff0000');
    expect(hex(oklchToRgb(0.86644, 0.29483, 142.495))).toBe('#00ff00');
    expect(hex(oklchToRgb(0.45201, 0.31321, 264.052))).toBe('#0000ff');
  });

  it('computes the WCAG ratio', () => {
    // The two ends of the scale the thresholds are expressed in.
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([18, 18, 18], [18, 18, 18])).toBeCloseTo(1, 5);
  });

  it('reads both themes out of index.css', () => {
    // Dark is a re-pointing, so the proof that it was read is a token that
    // moved. `ink` is the text ramp and it inverts outright.
    expect(tone(LIGHT, 'ink-900')).toEqual([11, 18, 32]);
    expect(tone(DARK, 'ink-900')).toEqual([232, 232, 234]);
    // And one it does not name, which must fall through to the light value.
    expect(tone(DARK, 'chrome-fg')).toEqual(tone(LIGHT, 'chrome-fg'));
    // Tailwind's own palette is in play too, in `oklch()`.
    expect(tone(LIGHT, 'emerald-500')).toEqual([0, 188, 125]);
  });
});

describe('every stated text/background pair meets WCAG AA', () => {
  it('finds the pairs at all', () => {
    // Without this the assertions below pass by scanning nothing — the failure
    // mode of every source scan in this suite.
    expect(PAIRS.length).toBeGreaterThan(400);
  });

  for (const [theme, tokens] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const) {
    it(`holds in ${theme} mode`, () => {
      const failing = PAIRS.filter((p) => contrast(tone(tokens, p.fg), tone(tokens, p.bg)) < p.needs).map(
        (p) =>
          `${p.where}  text-${p.fg} on bg-${p.bg} = ` +
          `${contrast(tone(tokens, p.fg), tone(tokens, p.bg)).toFixed(2)}:1 (needs ${p.needs}:1)`,
      );
      expect(failing).toEqual([]);
    });
  }
});

describe('the three bugs this was written for', () => {
  /*
   * Pinned as ratios rather than as class strings, so they stay meaningful if
   * the fix is later expressed some other way. Each is the pairing that was
   * actually on the element, scored in the theme where it failed.
   */
  it('keeps the sidebar avatar legible in dark mode', () => {
    expect(contrast(tone(DARK, 'bond-fg'), tone(DARK, 'bond-500'))).toBeGreaterThanOrEqual(4.5);
    const avatar = PAIRS.find((p) => p.where.startsWith('components/AppLayout.tsx') && p.bg === 'bond-500');
    expect(avatar?.fg).toBe('bond-fg');
  });

  it('keeps the progress stepper pips legible in light mode', () => {
    expect(contrast(tone(LIGHT, 'paper-50'), tone(LIGHT, 'emerald-700'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the muted badge tone above the line in both themes', () => {
    expect(contrast(tone(LIGHT, 'ink-400'), tone(LIGHT, 'paper-200'))).toBeLessThan(4.5); // was shipped
    for (const tokens of [LIGHT, DARK]) {
      expect(contrast(tone(tokens, 'ink-500'), tone(tokens, 'paper-200'))).toBeGreaterThanOrEqual(4.5);
    }
    // And no call site kept the old tone.
    expect(PAIRS.filter((p) => p.bg === 'paper-200' && p.fg === 'ink-400')).toEqual([]);
  });
});
