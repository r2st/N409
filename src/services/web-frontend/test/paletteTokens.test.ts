import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every colour utility written in this package has to name a token that exists.
 *
 * Tailwind v4 emits a colour rule only for a token declared in `@theme`. A
 * class naming a step that was never declared is not an error anywhere — not at
 * build time, not in the browser console, not in a snapshot: no rule is
 * generated, the property is simply never set, and the element inherits
 * whatever its parent had. It looks like a colour choice that someone made.
 *
 * That is how `text-ink-500` survived 260 call sites. It was the muted-text
 * step — captions, meta lines, table sub-text, the note under a heading — and
 * every one of them silently rendered as `text-ink-900`, so the app had no
 * secondary tier at all. Five more steps were missing beside it (`brass-600`,
 * `bond-300`, `bond-400`, `bond-900`, `paper-400`). Nothing failed. It was
 * found by reading the built stylesheet.
 *
 * So this reads the theme block and the source, and refuses to let the two
 * disagree. It is the cheap half of that stylesheet check — it proves a rule is
 * generated, not that the colour is right — and it is the half that catches the
 * silent failure, because a wrong colour is at least visible.
 */

/**
 * The package root. Taken from the working directory rather than from
 * `import.meta.url`, which is not a `file:` URL under the jsdom environment
 * this package's suite runs in. Vitest runs each workspace from its own
 * directory; `sourceFiles()` asserts it landed somewhere real.
 */
const ROOT = `${process.cwd()}/`;

/** Colour tokens the theme block declares, as Tailwind names them. */
function declaredTokens(): Set<string> {
  const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!theme) throw new Error('src/index.css has no @theme block');
  return new Set([...theme[1]!.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/**
 * Tailwind v4's built-in palette, which stays available alongside `@theme`.
 *
 * Listed rather than derived, deliberately. `:root[data-theme='dark']` re-points
 * some of these families, and re-pointing a variable is *not* declaring a token
 * — a family that appeared only in the dark block would generate no utility in
 * either theme. Reading the declarations out of the stylesheet would treat the
 * dark block as proof and let exactly that through.
 */
const TAILWIND_FAMILIES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  'slate', 'gray', 'zinc', 'neutral', 'stone',
];
const TAILWIND_STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const TAILWIND_KEYWORDS = ['black', 'white', 'transparent', 'current', 'inherit'];

/** Every utility prefix that takes a colour. */
const COLOR_PREFIXES = [
  'text', 'bg', 'border', 'ring', 'fill', 'stroke', 'divide', 'outline',
  'decoration', 'accent', 'caret', 'placeholder', 'shadow', 'from', 'via', 'to',
];

/**
 * `hover:`, `dark:`, `md:` and `group-hover:` prefixes are matched through
 * rather than enumerated — the boundary is "not a word character or dash", and
 * a `:` satisfies it. `bg-[#fff]` and `text-sm` do not match, the first because
 * of the bracket and the second because `sm` is not a colour family.
 */
const UTILITY = new RegExp(
  String.raw`(?<![\w-])(?:${COLOR_PREFIXES.join('|')})-([a-z]+(?:-[a-z]+)*)(?:-(\d{2,3}))?(?![\w-])`,
  'g',
);

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|css|html)$/.test(path)) found.push(path);
    }
  };
  walk(join(ROOT, 'src'));
  found.push(join(ROOT, 'index.html'));
  return found;
}

/** Every colour utility in the package, with the token it names and where. */
function paletteUses(declared: Set<string>): Map<string, string[]> {
  const families = new Set([...declared].map((t) => t.split('-')[0]!).concat(TAILWIND_FAMILIES));
  const uses = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(UTILITY)) {
      const family = m[1]!;
      // `bg-none`, `border-solid`, `shadow-card` and friends share the prefix
      // and are not colours. Anchoring on a known family is what separates them.
      if (!families.has(family.split('-')[0]!)) continue;
      const token = m[2] ? `${family}-${m[2]}` : family;
      const at = `${file.slice(ROOT.length)}:${m[0]}`;
      uses.set(token, [...(uses.get(token) ?? []), at]);
    }
  }
  return uses;
}

describe('palette tokens', () => {
  const declared = declaredTokens();
  const valid = new Set([
    ...declared,
    ...TAILWIND_FAMILIES.flatMap((f) => TAILWIND_STEPS.map((s) => `${f}-${s}`)),
    ...TAILWIND_KEYWORDS,
  ]);

  it('every colour utility in the package resolves to a declared token', () => {
    const undeclared = [...paletteUses(declared)]
      .filter(([token]) => !valid.has(token))
      // Loudest first: the count is the blast radius, and `ink-500` was 260.
      .sort((a, b) => b[1].length - a[1].length)
      .map(([token, at]) => `${token} — ${at.length} use(s), e.g. ${at.slice(0, 3).join(', ')}`);
    expect(undeclared, 'colour utilities naming a token no @theme step declares').toEqual([]);
  });

  it('scans the package rather than quietly finding nothing', () => {
    // A guard whose scanner has stopped matching passes forever. These pin the
    // two ways this test could go blind: no files walked, or a regex that no
    // longer recognises a utility.
    expect(sourceFiles().length).toBeGreaterThan(100);
    const uses = paletteUses(declared);
    expect(uses.size).toBeGreaterThan(30);
    expect(uses.get('ink-500')?.length ?? 0).toBeGreaterThan(100);
  });

  it('rejects a step that only the dark block re-points', () => {
    // The failure mode the family list above exists to prevent, exercised
    // directly: `:root[data-theme='dark']` sets `--color-red-300`, and if this
    // test read its declarations as proof of a token, a genuinely undeclared
    // custom step would pass the moment somebody re-pointed it there.
    const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
    const dark = /:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(dark, "index.css has no :root[data-theme='dark'] block").not.toBeNull();
    const darkOnly = [...dark![1]!.matchAll(/--color-([a-z0-9-]+)\s*:/g)]
      .map((m) => m[1]!)
      .filter((token) => !declared.has(token));
    // Those are Tailwind's own families; none may be a custom one.
    for (const token of darkOnly) {
      expect(TAILWIND_FAMILIES).toContain(token.split('-')[0]);
    }
  });
});
