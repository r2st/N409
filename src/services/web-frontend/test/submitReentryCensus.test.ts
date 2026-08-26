import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A submit control that writes has to go dead while its write is in flight.
 *
 * Nothing between the click and the response makes a second click impossible:
 * the form stays mounted (the panel is closed by the *success* branch), the
 * button stays enabled, and the endpoints these forms post to accept a second
 * identical row — several of the tables carry no uniqueness at all. So the
 * guard is the button, and it is the only guard there is.
 *
 * The idiom is already unanimous: every one of the disabled submits in the tree
 * names an in-flight flag — `busy`, `saving`, `sending`, `recording` — rather
 * than only a validity condition. `disabled={!name.trim()}` on its own would
 * satisfy "has a disabled prop" and stop nothing, so this asks for the flag by
 * name.
 *
 * Two shapes are excused, and both are excused for the same reason: they do not
 * write.
 *
 *   * `hidden` submits. `<button type="submit" hidden />` is how a filter form
 *     gets the Enter key; there is no control on screen to click twice.
 *   * The entries in EXCUSED below, named one at a time with what they do
 *     instead of writing.
 *
 * Scoped to `type="submit"` on purpose. A write behind a plain `onClick` is the
 * same hazard and is not counted here; those are already spelled with an
 * in-flight flag throughout, and matching a handler to the button that calls it
 * is a parser rather than a scan. What this pins is the shape that had drifted.
 *
 * See `createFormReentry.test.tsx` for the three writes this was extracted
 * from — a double-clicked "Add" put the same holding into a fund twice, and
 * `/funds/:id/nav` summed both.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

/** Names a request in flight, as opposed to a form merely being invalid. */
const IN_FLIGHT = /\b(busy|busyId|saving|sending|recording|pending|submitting|creating|adding)\b/;

/**
 * Submits that do not reach the network, by `file: label`.
 *
 * Keyed on the button's own text so that a *new* submit added to one of these
 * files is not excused by its neighbour.
 */
const EXCUSED: Record<string, string> = {
  'pages/InboxPage.tsx: Search':
    'sets the query state the inbox already re-reads; no request is made by the submit itself',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

interface Submit {
  file: string;
  /** The element's own attribute text, `<` to the matching `>`. */
  tag: string;
  /** The button's visible text, or '' for a self-closing one. */
  label: string;
}

/**
 * The start tag containing `at`, and the text that follows it.
 *
 * Hand-scanned rather than matched: an attribute value is a JSX expression and
 * may hold `>` (`disabled={busy || a > b}`), so the tag ends at the first `>`
 * outside braces, not the first `>`.
 */
function elementAt(text: string, at: number): { tag: string; label: string } | null {
  const open = text.lastIndexOf('<', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) {
      const tag = text.slice(open, i + 1);
      const after = text.slice(i + 1, i + 1 + 200);
      const label = tag.endsWith('/>') ? '' : (after.split('<')[0] ?? '').trim().replace(/\s+/g, ' ');
      return { tag, label };
    }
  }
  return null;
}

function submitsIn(file: string, text: string): Submit[] {
  const out: Submit[] = [];
  for (let at = text.indexOf('type="submit"'); at >= 0; at = text.indexOf('type="submit"', at + 1)) {
    const el = elementAt(text, at);
    if (el) out.push({ file, tag: el.tag, label: el.label });
  }
  return out;
}

const SUBMITS = walk(SRC).flatMap((full) =>
  submitsIn(path.relative(SRC, full).split(path.sep).join('/'), readFileSync(full, 'utf8')),
);

const guarded = (s: Submit) =>
  /\bhidden\b/.test(s.tag) || (/\bdisabled=\{/.test(s.tag) && IN_FLIGHT.test(s.tag));

describe('a submit that writes goes dead while the write is in flight', () => {
  it('is looking at a source tree with submit controls in it', () => {
    // The vacuity guard: a renamed extension, a moved `src/`, or a scanner that
    // silently stopped matching all produce an empty census that passes.
    expect(SUBMITS.length).toBeGreaterThan(40);
    expect(SUBMITS.filter(guarded).length).toBeGreaterThan(30);
  });

  it('names an in-flight flag on every submit that is not excused', () => {
    const unguarded = SUBMITS.filter((s) => !guarded(s))
      .map((s) => `${s.file}: ${s.label}`)
      .filter((key) => !(key in EXCUSED));
    expect(
      unguarded,
      'these submit controls stay live while their own request is outstanding, so a second ' +
        'click posts a second row — add `disabled={busy}` (and the `if (busy) return` beside it), ' +
        'or name the control in EXCUSED with what it does instead of writing',
    ).toEqual([]);
  });

  it('keeps the excused list honest', () => {
    const present = new Set(SUBMITS.map((s) => `${s.file}: ${s.label}`));
    for (const key of Object.keys(EXCUSED)) {
      expect(present.has(key), `EXCUSED names ${key}, which no longer exists — drop the entry`).toBe(true);
      const still = SUBMITS.filter((s) => `${s.file}: ${s.label}` === key);
      expect(
        still.every((s) => !guarded(s)),
        `EXCUSED still excuses ${key}, which now guards itself — drop the entry`,
      ).toBe(true);
    }
  });
});
