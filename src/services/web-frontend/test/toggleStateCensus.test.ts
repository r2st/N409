import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A button whose only signal of being *on* is its colour.
 *
 * Fourteen filter chips, view switchers and sheet tabs across the workspace and
 * the admin pages selected between two class strings on an equality test and
 * said nothing else. The active one was distinguishable by a dark background
 * and by nothing a screen reader or a high-contrast mode can reach — WCAG 1.4.1
 * (colour is not the only means) and 4.1.2 (a control's *value* has to be
 * programmatically determinable). Six other buttons in the same codebase
 * already carried `aria-pressed`, which is how this reads as an omission rather
 * than a decision: the idiom was copy-pasted, and the attribute was not part of
 * what got copied.
 *
 * So the rule is stated once, here, over the source. It is a regex census and
 * carries that limitation — a chip whose className is assembled by a helper
 * rather than written as a template literal is one this cannot see — but the
 * shape it does see is the shape every one of the fourteen had, and it is the
 * shape the fifteenth will have too, because it will be pasted from one of
 * them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');

/**
 * Buttons that vary their styling on something other than selection, and are
 * therefore not toggles at all. Listed exhaustively and with the reason, the
 * way the retired-engagement sweep lists its exempt DELETEs — a census whose
 * exceptions are implicit is one nobody can audit.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/components/ScrollableTabs.tsx',
    why: 'ArrowButton picks left/right placement from a prop; there is no on state, and it names itself "Scroll tabs left".',
  },
  {
    file: 'src/components/ThemeToggle.tsx',
    why: 'Styling follows the `variant` prop (chrome vs surface). The theme it *is* on is already in its aria-label, which changes with the choice.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The text of the JSX opening tag beginning at `index`.
 *
 * Brace-aware, and it has to be: `onClick={() => setKind(k)}` contains a `>`
 * that is not the end of the tag, so scanning to the first `>` would cut every
 * one of these buttons off before its className.
 */
function openTag(src: string, index: number): string | null {
  let depth = 0;
  for (let i = index; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(index, i + 1);
  }
  return null;
}

interface Toggle {
  file: string;
  line: number;
  hasState: boolean;
}

function conditionalStyleButtons(): Toggle[] {
  const found: Toggle[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(path.resolve(here, '..'), file);
    let i = 0;
    while ((i = src.indexOf('<button', i)) !== -1) {
      const tag = openTag(src, i);
      const at = i;
      i += '<button'.length;
      if (!tag) continue;
      const classes = /className=\{`([\s\S]*?)`\}/.exec(tag)?.[1];
      // A template-literal className that branches on an equality test is the
      // shape: `${a === b ? 'on' : 'off'}`. A static string cannot express a
      // state, and a branch on something other than equality (a count, a
      // nullish check) is not the selected/unselected pair being looked for.
      if (!classes || !classes.includes('?') || !/===|!==/.test(classes)) continue;
      found.push({
        file: rel,
        line: src.slice(0, at).split('\n').length,
        hasState: /aria-(pressed|current|selected|expanded|checked)/.test(tag),
      });
    }
  }
  return found;
}

describe('buttons that style themselves by selection say so', () => {
  const toggles = conditionalStyleButtons();

  it('finds the idiom at all', () => {
    // The vacuity guard. This census passes trivially the moment its regex
    // stops matching — a className helper, a formatting change that breaks the
    // template literal across lines — and a guard that has quietly stopped
    // asking is worse than no guard, because the green tick is what stops
    // anyone looking.
    expect(toggles.length).toBeGreaterThanOrEqual(20);
  });

  it('exempts nothing that no longer exists', () => {
    // An exemption for a file that has been deleted or renamed is an excuse
    // still being granted to nobody, and it hides the day the real button
    // comes back under a new path.
    const files = new Set(toggles.map((t) => t.file));
    for (const { file } of EXEMPT) expect(files).toContain(file);
  });

  it('gives every selection toggle a programmatic state', () => {
    const exempt = new Set(EXEMPT.map((e) => e.file));
    const missing = toggles.filter((t) => !t.hasState && !exempt.has(t.file));
    expect(missing.map((m) => `${m.file}:${m.line}`)).toEqual([]);
  });
});
