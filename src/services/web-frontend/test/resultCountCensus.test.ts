import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A filter that changes a list and says nothing.
 *
 * Ten search and filter controls across the workspace, the admin consoles and
 * the help centre narrowed a list of results and produced no announcement at
 * all. Focus stays in the box, the box's own value does not change, and the
 * thing that *did* change is a table the typist is not pointed at — so to a
 * screen reader the query simply had no effect. The count, the "nothing
 * matched" state, and the difference between eleven hits and none were equally
 * silent. WCAG 2.2 SC 4.1.3 (Status Messages), Level AA.
 *
 * The surfaces that fetch made it worse rather than better: `Spinner` is a live
 * region, so the user heard "Loading…" and then nothing — no way to tell a
 * finished search from a stuck one without leaving the box and reading the
 * table by hand.
 *
 * So the rule is stated once, here, over the source: a page that owns a search
 * or filter control owns a `ResultCount` too. This is a source census with a
 * census's limitation — a control whose label is assembled at runtime is one it
 * cannot see — but the shape it does see is the shape all ten had, and the
 * shape the eleventh will have, because it will be pasted from one of them.
 *
 * **The eleventh was not pasted from one of them (R117).** The census asked
 * one question — is there a control *labelled* "Search" or "Filter" — and the
 * activity log's six are labelled after the columns they narrow: Scope, Actor,
 * Actor type, Event type, From date, To date. Not one of them contains either
 * word, so the page was never a surface as far as this file was concerned, and
 * six controls rewrote a fifty-row table in silence with a green tick over
 * them. A census that recognises an idiom rather than a behaviour is a census
 * that stops seeing the moment somebody names a control accurately.
 *
 * `URL_FILTER_BINDING` is the second detector, and it asks about behaviour: a
 * control whose `onChange` writes to the query string of a page that reads it
 * back with `useSearchParams` is a filter, whatever it is called. The two
 * detectors overlap on the surfaces that have both, which is the point — each
 * covers what the other cannot see, and each has its own vacuity guard below.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');
const REPO = path.resolve(here, '..');

/**
 * Pages whose filter control is not answered by a count, listed exhaustively
 * and with the reason — a census whose exceptions are implicit is one nobody
 * can audit.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/components/CommandPalette.tsx',
    why: 'The palette is a combobox: its rows are `role="option"` under `aria-expanded`, and the highlighted one is named by `aria-activedescendant` on every keystroke. The listbox contract already announces both the presence of results and which one is current — a second live region would talk over it.',
  },
  {
    file: 'src/components/HelpWidget.tsx',
    why: 'Its search returns a list of links rendered inside a `role="dialog"` the trap has just moved focus into, and the box is the first control in it. There is no result *count* surface here at all — the widget shows at most five suggestions above a "message the team" action, which is the outcome either way.',
  },
  {
    file: 'src/pages/marketing/BlogPages.tsx',
    why: 'The "filter" is a set of category links that navigate — each is an ordinary route change to a new document with its own <h1>, which a screen reader announces as a page load. Nothing updates in place.',
  },
];

/** Labels that mean "this control narrows a list of results". */
const FILTER_LABEL = /(aria-label|placeholder)=["'`](Search|Filter)\b/i;

/**
 * A control wired to the page's own query string — a filter by what it does
 * rather than by what it is called.
 *
 * Paired with `useSearchParams` in the same file deliberately. A local
 * `setParams` that holds a *model's* parameters rather than the URL's is a
 * different thing with the same name (DebtInstrumentsPage has one, and it
 * narrows nothing), and requiring the hook is what tells them apart.
 */
const URL_FILTER_BINDING = /onChange=\{[^}]*set(?:Filter|Params|SearchParams)\(/;
const READS_URL = /useSearchParams\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

interface Surface {
  file: string;
  labels: string[];
  announces: boolean;
  /** Which detector saw it. A surface both see is listed under both. */
  via: Array<'label' | 'url'>;
}

function filterSurfaces(): Surface[] {
  const found: Surface[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const labelled = lines.filter((line) => FILTER_LABEL.test(line));
    const bound = READS_URL.test(src) ? lines.filter((line) => URL_FILTER_BINDING.test(line)) : [];
    if (labelled.length === 0 && bound.length === 0) continue;
    const via: Array<'label' | 'url'> = [];
    if (labelled.length > 0) via.push('label');
    if (bound.length > 0) via.push('url');
    found.push({
      file: path.relative(REPO, file),
      labels: [...labelled, ...bound].map((l) => l.trim()),
      // Either the shared primitive, or a live region this file owns itself.
      announces: /<ResultCount\b/.test(src) || /aria-live=/.test(src),
      via,
    });
  }
  return found;
}

describe('a control that narrows a list says what is left', () => {
  const surfaces = filterSurfaces();
  const exemptFiles = new Set(EXEMPT.map((e) => e.file));

  it('finds the idiom at all', () => {
    // The vacuity guard. This census passes trivially the moment its regex
    // stops matching — a label moved onto its own line, a helper that builds
    // the placeholder — and a guard that has quietly stopped asking is worse
    // than no guard, because the green tick is what stops anyone looking.
    expect(surfaces.filter((s) => s.via.includes('label')).length).toBeGreaterThanOrEqual(12);
  });

  it('finds the url-bound idiom at all', () => {
    // The same guard for the second detector, which needs its own: the first
    // one stayed comfortably above its floor for as long as the activity log
    // was invisible to it, so one number cannot report on two questions.
    expect(surfaces.filter((s) => s.via.includes('url')).length).toBeGreaterThanOrEqual(3);
  });

  it('exempts nothing that no longer exists', () => {
    // An exemption for a file that has been deleted or renamed is an excuse
    // outliving its reason, and it silently widens the hole.
    const seen = new Set(surfaces.map((s) => s.file));
    expect(EXEMPT.filter((e) => !seen.has(e.file)).map((e) => e.file)).toEqual([]);
  });

  it('announces the result of every search or filter control', () => {
    const silent = surfaces
      .filter((s) => !s.announces && !exemptFiles.has(s.file))
      .map((s) => `${s.file}\n    ${s.labels.join('\n    ')}`);
    expect(silent).toEqual([]);
  });

  it('routes the announcement through the shared primitive on the pages', () => {
    // Pages should not each grow their own live region: the wording, the
    // politeness level and the always-mounted-while-empty rule are the parts
    // that are easy to get wrong, and they live in ResultCount.
    const homegrown = surfaces
      .filter((s) => s.file.startsWith('src/pages/') && !exemptFiles.has(s.file))
      .filter((s) => !/<ResultCount\b/.test(readFileSync(path.join(REPO, s.file), 'utf8')))
      .map((s) => s.file);
    expect(homegrown).toEqual([]);
  });
});
