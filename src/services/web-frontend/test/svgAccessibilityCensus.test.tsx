import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonutChart } from '../src/components/charts';

/**
 * A census of the platform's inline SVGs, and a proof of the harm each rule
 * exists to prevent.
 *
 * There are two kinds of `<svg>` here and they want opposite things. Five are
 * pictures of data — the throughput trend, the value bridge, the donut, the
 * cap-table diagram, the calculator's curve — and must announce themselves.
 * The other forty-six are icons: a chevron beside "FAQ", a magnifier beside
 * "Jump to…", the seventeen glyphs down the sidebar beside the words they
 * repeat. Those must announce nothing, because the word is already there.
 *
 * Before R124, thirty-six of the icons said neither. A bare `<svg>` is not
 * skipped — HTML-AAM maps it to `graphics-document`, so it is a node in the
 * tree with no name — and where the icon sits inside a control that takes its
 * name from its own content, anything it draws is part of that name.
 *
 * Four rules, no allowlist:
 *
 *   1. every `<svg>` is either hidden (`aria-hidden` on the tag) or named
 *      (`aria-label`, `aria-labelledby`, or a direct-child `<title>`);
 *   2. every named `<svg>` also declares `role="img"`. `<svg>` has no reliable
 *      implicit role, and a name with no role to attach to is announced
 *      inconsistently or not at all — Safari/VoiceOver skips it;
 *   3. no `<svg>` is both hidden and named, which is a decision that reads as
 *      made and satisfies rule 1 while announcing nothing;
 *   4. no `<svg role="img">` contains anything interactive. ARIA makes an
 *      `img` a leaf — "user agents MUST NOT expose descendants" — so a control
 *      inside one is pruned before its name can be read, while `tabIndex`
 *      keeps it in the tab order regardless. That is exactly what the
 *      cap-table diagram was: a run of silent focus stops.
 *
 * Rule 1 asks for `aria-hidden` on the tag and not on an ancestor, though an
 * ancestor would work as well; four of these icons *were* already inside an
 * `aria-hidden` wrapper. A local claim is one a reviewer can check without
 * opening a second file — and for `AppLayout`'s `icons` map and
 * `ThemeToggle`'s `OPTIONS`, where the glyph is a value in a table and the
 * wrapper is written in a different component, a second file is exactly what
 * it would take. Saying it twice costs nothing and cannot go stale.
 *
 * Rule 4 is a shape, not a full answer: it catches a control inside a leaf,
 * not a *figure* inside one. Nothing here can tell that the donut's centre
 * total appears nowhere else — that took reading the component.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

type Tag = { name: string; attrs: string; kind: 'open' | 'close' | 'self'; at: number };

/**
 * The JSX tags in one file, in order.
 *
 * Attribute values are skipped with quote and brace nesting intact rather than
 * by a regex, because the tags this has to get right are the ones written over
 * eight lines with a `className={`…${x}`}` in the middle: a naive scan for the
 * next `>` ends the tag inside an arrow function and reads the remaining
 * attributes as page content.
 */
function scanTags(src: string): Tag[] {
  const tags: Tag[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue;
    const close = src[i + 1] === '/';
    const nameAt = i + (close ? 2 : 1);
    if (!/[A-Za-z]/.test(src[nameAt] ?? '')) continue;
    // A tag immediately preceded by a quote is inside a string constant — the
    // rich-text editor keeps snippets of document HTML in one.
    if (!close && /['"`]/.test(src[i - 1] ?? '')) continue;
    let j = nameAt;
    while (j < src.length && /[\w.:-]/.test(src[j] ?? '')) j++;
    const name = src.slice(nameAt, j);
    let depth = 0;
    let quote = '';
    let end = -1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote && src[j - 1] !== '\\') quote = '';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) break;
    const self = src[end - 1] === '/';
    tags.push({
      name,
      attrs: src.slice(nameAt + name.length, end - (self ? 1 : 0)),
      kind: close ? 'close' : self ? 'self' : 'open',
      at: i,
    });
    i = end;
  }
  return tags;
}

type Found = {
  file: string;
  line: number;
  hidden: boolean;
  named: boolean;
  role: string | null;
  interactive: string[];
};

const INTERACTIVE = /\brole\s*=\s*["'{]?\s*(button|link|checkbox|tab|menuitem)\b|\btabIndex\b|\bonClick\b/;

function svgs(): Found[] {
  const found: Found[] = [];
  for (const full of walk(SRC)) {
    // Comments are blanked (newlines kept, so line numbers survive) because
    // this codebase writes markup in prose when explaining itself.
    const src = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
    const tags = scanTags(src);
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (!tag || tag.name !== 'svg' || tag.kind === 'close') continue;

      // A `<title>` names the `<svg>` only as its direct child. The waterfall
      // and the donut hang a `<title>` off every shape for the mouse tooltip;
      // those name the shape, and counting them would report two deliberately
      // hidden charts as named.
      let directTitle = false;
      const inside: Tag[] = [];
      if (tag.kind === 'open') {
        let depth = 0;
        for (let j = i + 1; j < tags.length; j++) {
          const t = tags[j];
          if (!t) break;
          if (t.kind === 'close') {
            if (depth === 0) break; // </svg>
            depth--;
            continue;
          }
          if (depth === 0 && t.name === 'title') directTitle = true;
          inside.push(t);
          if (t.kind === 'open') depth++;
        }
      }

      found.push({
        file: path.relative(SRC, full),
        line: src.slice(0, tag.at).split('\n').length,
        hidden: /\baria-hidden\b/.test(tag.attrs),
        named: /\baria-label(ledby)?\s*=/.test(tag.attrs) || directTitle,
        role: /\brole\s*=\s*["']\s*(\w+)/.exec(tag.attrs)?.[1] ?? null,
        interactive: inside.filter((t) => INTERACTIVE.test(t.attrs)).map((t) => `<${t.name}>`),
      });
    }
  }
  return found;
}

/**
 * The two roles that name an `<svg>` here. `img` for a picture, which is a
 * leaf; `group` for a diagram whose parts are controls, which is not. Rule 4
 * is what stops the second being spelled as the first.
 */
const NAMEABLE = new Set(['img', 'group']);

const SVGS = svgs();
const where = (s: Found) => `${s.file}:${s.line}`;

describe('every inline SVG is either hidden or named', () => {
  it('finds the SVGs at all', () => {
    // Without this the rules below pass by scanning nothing — the failure
    // mode of every source scan in this suite. The three counts are separate
    // because the interesting way for this one to go quiet is not scanning
    // zero files but tokenizing badly enough to miss a spelling: `<svg>` bare,
    // `<svg\n  viewBox=…` over eight lines, and `<svg width="15" …/>` are all
    // in here, and a scan that saw only the first would still report a healthy
    // number and check almost nothing.
    expect(SVGS.length).toBeGreaterThan(45);
    expect(SVGS.filter((s) => s.named).length).toBeGreaterThan(3);
    expect(SVGS.filter((s) => s.hidden).length).toBeGreaterThan(40);
  });

  it('says which one it is on every SVG', () => {
    expect(SVGS.filter((s) => !s.hidden && !s.named).map(where)).toEqual([]);
  });

  it('gives every named SVG a role for the name to attach to', () => {
    // Either role names correctly; which one is the right one is rule 4's
    // question, not this one.
    const roleless = SVGS.filter((s) => s.named && !NAMEABLE.has(s.role ?? '')).map(
      (s) => `${where(s)} role=${s.role ?? 'none'}`,
    );
    expect(roleless).toEqual([]);
  });

  it('does not both hide and name the same SVG', () => {
    expect(SVGS.filter((s) => s.hidden && s.named).map(where)).toEqual([]);
  });

  it('puts nothing interactive inside a role="img" leaf', () => {
    const buried = SVGS.filter((s) => s.role === 'img' && s.interactive.length > 0).map(
      (s) => `${where(s)} contains ${s.interactive.join(', ')}`,
    );
    expect(buried).toEqual([]);
  });
});

describe('the two states reach the accessibility tree', () => {
  it('names a chart from its role and label', () => {
    render(
      <DonutChart
        title="Valuations by state"
        slices={[
          { label: 'Published', value: 7 },
          { label: 'In review', value: 3 },
        ]}
      />,
    );
    const chart = screen.getByRole('img', { name: 'Valuations by state: 10 in total' });
    expect(chart.tagName.toLowerCase()).toBe('svg');
    // The leaf exposes nothing drawn inside it, so the slices have to be in
    // the legend beside it or they are nowhere.
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('keeps a hidden icon out of the name of the control it decorates', () => {
    // The consequence of rule 1, on a fixture rather than a screen: an `<svg>`
    // that is not hidden contributes its text to the accessible name of any
    // control named from its own content — which the sidebar links, the FAQ
    // toggles and the theme radios all are.
    //
    // A fixture because none of the thirty-six icons draw text, so none of
    // them polluted a name *today*; the tree position they occupied is real
    // but jsdom does not model `graphics-document`, and this is the half of
    // the harm a render here can actually show.
    render(
      <div>
        <button data-testid="bare">
          Save
          <svg>
            <text>12</text>
          </svg>
        </button>
        <button data-testid="hidden">
          Save
          <svg aria-hidden="true">
            <text>12</text>
          </svg>
        </button>
      </div>,
    );
    expect(screen.getByTestId('bare')).toHaveAccessibleName('Save 12');
    expect(screen.getByTestId('hidden')).toHaveAccessibleName('Save');
  });
});
