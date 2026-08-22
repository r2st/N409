import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * What a finger can reach, and what a phone does to a form.
 *
 * `appResponsive.test.ts` next door asks whether the page *fits* — table
 * widths, grids that collapse. This asks the two questions that are about the
 * input device rather than the viewport, and that a width test cannot see:
 *
 *   1. is the control big enough to hit, and
 *   2. does focusing it throw the layout away.
 *
 * (2) is the less obvious one. WebKit on iOS zooms the viewport whenever it
 * focuses a control whose font-size is under 16px, and does not zoom back out
 * on blur. `inputClass` was `text-sm` — 14px — and dresses all but eight of the
 * ~490 controls in the product, so tapping any field magnified the page and
 * left it magnified for the rest of the form.
 *
 * MOST OF THIS COMPILES THE REAL STYLESHEET rather than grepping it. That is
 * deliberate, and it is this codebase's own scar: `--color-ink-500` was missing
 * from `@theme` for a long time, so `text-ink-500` at 260 call sites generated
 * no rule at all and the whole muted tier rendered at full weight — a source
 * grep for `text-ink-500` would have found 260 reasons to say it was fine. A
 * `touch:` variant that is never defined, or a `tap-area` utility that is
 * deleted, fails in exactly that way: the class stays in the markup, Tailwind
 * emits nothing, and every assertion written against the source still passes.
 * So the assertions below are made against generated CSS.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const SRC = path.join(PKG, 'src');

/** The touch-target floor, in px. WCAG 2.5.5 / the iOS and Android guidance. */
const TOUCH_FLOOR = 44;

/** Below this, WebKit on iOS zooms the page when it focuses the control. */
const NO_ZOOM_FONT_PX = 16;

/**
 * Compile `src/index.css` for a given set of candidate classes, exactly as the
 * build does, and return the CSS the browser would get.
 *
 * The font `@import`s are dropped first: they resolve through node_modules to
 * several megabytes of `@font-face` that nothing here asks about.
 */
async function buildCss(candidates: string[]): Promise<string> {
  const css = readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/@import '@fontsource[^']*';/g, '');
  const compiler = await compile(css, {
    base: PKG,
    loadStylesheet: async (id: string, base: string) => {
      if (id !== 'tailwindcss') throw new Error(`unexpected @import ${id}`);
      // `tailwindcss/index.css` is not in the package's `exports`, so it is
      // reached from the manifest rather than resolved directly.
      const manifest = createRequire(import.meta.url).resolve('tailwindcss/package.json');
      const resolved = path.join(path.dirname(manifest), 'index.css');
      return { path: id, base, content: readFileSync(resolved, 'utf8') };
    },
  });
  return compiler.build(candidates);
}

/**
 * The declaration block a selector opens, up to its matching close. Enough to
 * ask what a rule contains without pulling in a CSS parser.
 */
function blockAfter(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  return css.slice(at);
}

describe('the touch variant and the hit-area utility survive compilation', () => {
  it('gives `touch:` a coarse-pointer media query, not nothing at all', async () => {
    const css = await buildCss(['touch:min-h-11']);
    const rule = blockAfter(css, '.touch\\:min-h-11');
    expect(rule, '`touch:min-h-11` generated no rule — the variant is undefined').not.toBe('');
    expect(rule).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    expect(rule).toMatch(/min-height:/);
  });

  it('keys the variant on the pointing device rather than the viewport width', async () => {
    // The distinction is the whole reason `touch:` exists beside `sm:`. An
    // iPad in landscape is 1024px wide and still driven by a fingertip; a
    // narrow desktop window is 500px wide and driven by a mouse. A variant
    // that quietly became a width query would size controls for the wrong one.
    const css = await buildCss(['touch:min-h-11']);
    const rule = blockAfter(css, '.touch\\:min-h-11');
    expect(rule).not.toMatch(/min-width|max-width/);
  });

  it('resolves the touch floor to 44px', async () => {
    // `min-h-11` is 44px only because `--spacing` is 0.25rem and the root font
    // is 16px. If the spacing scale is ever re-based, 11 stops meaning 44 and
    // every `touch:min-h-11` in the product silently moves with it.
    const css = await buildCss(['min-h-11']);
    const spacing = /--spacing:\s*([\d.]+)rem/.exec(css);
    expect(spacing, 'no --spacing in the compiled theme').not.toBeNull();
    expect(Number(spacing![1]) * 11 * 16).toBe(TOUCH_FLOOR);
  });

  it('pads `tap-area` to the touch floor, and only under a coarse pointer', async () => {
    const css = await buildCss(['tap-area']);
    const rule = blockAfter(css, '.tap-area');
    expect(rule, '`tap-area` generated no rule — the @utility is gone').not.toBe('');
    expect(rule).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    // A pseudo-element, because the point of this utility is that the box the
    // layout sees does not change: the "?" beside a field label is baseline-
    // aligned inside a <label> and cannot grow without shifting the label.
    expect(rule).toMatch(/&::after/);
    expect(rule).toMatch(new RegExp(`min-width:\\s*${TOUCH_FLOOR}px`));
    expect(rule).toMatch(new RegExp(`min-height:\\s*${TOUCH_FLOOR}px`));
    // Under a fine pointer it must do nothing — an invisible 44px pad around
    // every "?" on a desktop would swallow clicks meant for the text beside it.
    const outsideMedia = rule.slice(0, rule.indexOf('@media'));
    expect(outsideMedia).not.toMatch(/::after/);
  });
});

describe('a form field does not zoom the page when it is focused', () => {
  it('takes every text-entry control to 16px under a coarse pointer', async () => {
    const css = await buildCss([]);
    const rule = blockAfter(css, '@media (pointer: coarse)');
    expect(rule, 'no coarse-pointer block in the compiled stylesheet').not.toBe('');
    expect(rule).toMatch(new RegExp(`font-size:\\s*${NO_ZOOM_FONT_PX}px`));
    for (const selector of ['input', 'select', 'textarea']) {
      expect(rule, `${selector} is not covered`).toMatch(new RegExp(`(^|[\\s,])${selector}[\\s,:)]`));
    }
  });

  it('exempts only the controls whose box is not sized by its text', async () => {
    // A checkbox at 16px is a bigger checkbox, not an un-zoomed one — it has no
    // text to measure. Every *other* input type has to be in, so the exemption
    // list is pinned rather than left to grow.
    const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');
    const chain = /input((?::not\(\[type='[a-z]+'\]\))+)/.exec(css)?.[1];
    // Narrowed rather than asserted: a regex that stops matching should fail
    // the comparison below with an empty list, not be cast into one.
    expect(chain, 'the coarse-pointer input rule has moved').toBeDefined();
    const exempt = [...(chain ?? '').matchAll(/\[type='([a-z]+)'\]/g)]
      .flatMap((m) => (m[1] ? [m[1]] : []))
      .sort();
    expect(exempt).toEqual(['checkbox', 'color', 'radio', 'range']);
  });

  it('leaves pinch-zoom with the user, which is why the 16px rule exists', () => {
    // The other way to stop WebKit zooming is `maximum-scale=1` on the viewport
    // tag, which works by taking zoom away from everyone. Sizing the text was
    // chosen *instead of* that, so a later `maximum-scale` would not be a
    // second belt — it would undo the reason for the first one.
    const html = readFileSync(path.join(PKG, 'index.html'), 'utf8');
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html);
    expect(viewport, 'no viewport meta tag').not.toBeNull();
    expect(viewport![1]).toMatch(/width=device-width/);
    expect(viewport![1]).toMatch(/initial-scale=1/);
    expect(viewport![1]).not.toMatch(/maximum-scale|user-scalable/);
  });
});

/* ------------------------------------------------------------------ census */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Tailwind's paired line-heights. `text-sm` is 14px on a 20px line, so the
 * button around it is 20px plus its vertical padding — which is why `py-2`
 * lands at 36px and not at 44.
 */
const LINE_HEIGHT: Record<string, number> = { 'text-xs': 16, 'text-sm': 20, 'text-base': 24 };

interface Control {
  file: string;
  line: number;
  /** Drawn height in px — an estimate; see the note on the assertion below. */
  height: number;
  /** Carries `tap-area`, or a `touch:` class that resizes it. */
  escapes: boolean;
}

/**
 * Every `<button>` in the app, with the height it draws at and whether it has
 * been given a touch escape.
 *
 * The height is an estimate from the utility classes, not a measurement — this
 * is jsdom, which has no layout engine, and the alternative was measuring 400
 * buttons in a browser by hand. It only has to be good enough to notice a new
 * `px-2 py-1 text-xs` control, and the escape it asks for costs one class.
 */
function controls(): Control[] {
  const found: Control[] = [];
  for (const { file, text } of FILES) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/<button\b/.test(line)) return;
      // The className may be several lines below the tag, and may be a
      // template literal or a conditional; take the whole attribute value.
      const chunk = lines.slice(i, i + 20).join('\n');
      const tagEnd = chunk.search(/>\s*(\n|$)/);
      const attrs = tagEnd < 0 ? chunk : chunk.slice(0, tagEnd);
      const cm = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/s.exec(attrs);
      if (!cm) return;
      const cls = cm[1] ?? cm[2] ?? cm[3] ?? '';

      const escapes = /\btap-area\b/.test(cls) || /\btouch:(min-)?[hw]-\d+/.test(cls);

      let height: number | null = null;
      const h = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/.exec(cls);
      if (h) {
        height = Number(h[1]) * 4;
      } else {
        const pad = /(?:^|\s)p[y]?-(\d+(?:\.\d+)?)(?:\s|$)/.exec(cls);
        if (pad) {
          const size = Object.keys(LINE_HEIGHT).find((k) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(cls));
          // An arbitrary `text-[0.65rem]` has no paired line-height; `normal`
          // is about 1.2×, and these are the smallest controls in the product.
          const arbitrary = /text-\[([\d.]+)rem\]/.exec(cls);
          const paired = size === undefined ? undefined : LINE_HEIGHT[size];
          const lh = paired ?? (arbitrary?.[1] ? Number(arbitrary[1]) * 16 * 1.2 : 24);
          height = Number(pad[1]) * 4 * 2 + lh;
        }
      }
      if (height !== null) found.push({ file, line: i + 1, height, escapes });
    });
  }
  return found;
}

const CONTROLS = controls();

describe('every control a finger has to hit is reachable', () => {
  const small = CONTROLS.filter((c) => c.height < TOUCH_FLOOR);

  it('gives a touch escape to every button drawn under the floor', () => {
    const offenders = small
      .filter((c) => !c.escapes)
      .map((c) => `${c.file}:${c.line} (~${Math.round(c.height)}px drawn)`);
    expect(offenders).toEqual([]);
  });

  it('found the small controls it is screening — the census is not empty', () => {
    // The failure this guards is the parser going blind: a `className` form it
    // stops matching makes every button vanish from the census and the
    // assertion above pass by having nothing to say. R100 escaped 28 of these.
    expect(small.length).toBeGreaterThanOrEqual(20);
  });

  it('reads a whole button, including the ones drawn large', () => {
    // The other half: if the height estimate collapsed to zero the census would
    // be all-small and still pass above. Some buttons in this product are drawn
    // over the floor on their own and must be seen as such.
    expect(CONTROLS.length).toBeGreaterThan(small.length);
  });

  it('never pads a control that is positioning something else', () => {
    // `tap-area` sets `position: relative` so its pseudo-element has something
    // to anchor to. On a control that is already `absolute`, `fixed` or
    // `sticky` that is not an addition — it is a replacement, at equal
    // specificity, and the control jumps out of the place it was holding. The
    // failure only appears under a coarse pointer, so a desktop walkthrough
    // would never show it. Those controls take `touch:h-11 touch:w-11`, which
    // resizes without touching `position`.
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      for (const cls of [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]) {
        const value = cls[1] ?? cls[2] ?? '';
        if (!/(^|\s)tap-area(\s|$)/.test(value)) continue;
        if (/(^|\s)(absolute|fixed|sticky)(\s|$)/.test(value)) offenders.push(`${file}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('escapes the smallest target in the product — the field-label "?"', () => {
    // 16px drawn, and it is the app's entire inline-help mechanism. A previous
    // round fixed its *toggle* for touch (a tap fired hover, focus and click
    // off one gesture, opening and shutting the bubble inside the tap); that
    // only ever mattered once the tap could land.
    const ui = FILES.find((f) => f.file === 'components/ui.tsx')!;
    const tooltip = /className="([^"]*\bcursor-help\b[^"]*)"/.exec(ui.text);
    expect(tooltip, 'the InfoTooltip button has moved').not.toBeNull();
    expect(tooltip![1]).toMatch(/(^|\s)h-4(\s|$)/); // still 16px drawn
    expect(tooltip![1]).toMatch(/(^|\s)tap-area(\s|$)/); // 44px to a finger
  });

  it('holds the shared Button primitive to the floor', () => {
    // Most buttons in the product are this one. It draws at 36px — `py-2` on a
    // 20px line — which is comfortable for a cursor and under the floor.
    const ui = FILES.find((f) => f.file === 'components/ui.tsx')!;
    const primitive = /export function Button\(\{[\s\S]*?className=\{`([^`]*)`\}/.exec(ui.text);
    expect(primitive, 'the Button primitive has moved').not.toBeNull();
    expect(primitive![1]).toMatch(/touch:min-h-11/);
  });
});

describe('nothing in the app opens on hover alone', () => {
  it('registers no hover handler that a finger cannot fire', () => {
    // A tap fires mouseenter, then focus, then click, off the single gesture.
    // A control that opens on hover and toggles on click therefore opened and
    // shut inside one tap and read as dead. Two shipped instances were fixed by
    // keying hover to `onPointerEnter` guarded on `pointerType === 'mouse'`;
    // this is what stops a third arriving. `group-hover:` is exempt — those are
    // colour changes, not affordances that reveal content.
    const offenders = FILES.filter((f) => /onMouseEnter|onMouseOver/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('still finds the pointer-typed handlers that replaced them', () => {
    // Without this the assertion above would also pass on a codebase that had
    // simply deleted its hover affordances.
    const guarded = FILES.filter((f) => /onPointerEnter/.test(f.text) && /pointerType/.test(f.text));
    expect(guarded.length).toBeGreaterThanOrEqual(2);
  });
});
