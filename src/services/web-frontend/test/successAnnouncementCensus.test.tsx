import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorNote, SuccessNote } from '../src/components/ui';

/**
 * R188 — the save that worked, said out loud.
 *
 * `ErrorNote` is `role="alert"`, so a save that *fails* has always been
 * announced. The confirmation that it *succeeded* was a plain `<div>` in
 * fourteen places, drawing the same box by hand, with no role on any of them.
 * A screen-reader user pressing Save therefore heard something when it went
 * wrong and nothing when it went right — and nothing is also what a button
 * that did nothing sounds like. The only recourse is to tab back through the
 * form hunting for a sentence, or to press Save a second time, which on a
 * surface with no uniqueness on its create tables is its own bug.
 *
 * Twenty-eight of thirty-three outcome notes were silent. Two of the fourteen
 * boxes had `role="status"` added by hand at some point, which is the tell: the
 * intent was there and there was nothing holding it.
 *
 * The census below finds the shape — `{flag && <element>message</element>}`
 * where `flag` names an outcome — and requires it to be announced, by being a
 * `SuccessNote`/`ErrorNote` or by carrying a live role of its own. The second
 * route matters: several of these are a line of small print rather than a box,
 * and boxing them all would be a redesign rather than a fix.
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

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/** End of the JSX opening tag at `i`, skipping strings and `{…}` expressions. */
function tagEnd(src: string, i: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return j;
  }
  return -1;
}

/**
 * Flags that name the outcome of something the reader just did. Deliberately
 * lexical: the alternative is a list of files, which goes stale silently.
 */
const OUTCOME_FLAG =
  /\{(\w*(?:saved|Saved|sent|Sent|copied|Copied|done|Done|note|Note|ok|Ok)\w*)\s*&&\s*\(?\s*</g;

const ANNOUNCED = /role="status"|role="alert"|aria-live|<ErrorNote|<SuccessNote|<Toast/;

/**
 * Two matches of the shape that are not confirmations, and would be wrong to
 * announce. Named rather than pattern-excluded, so a third has to be argued
 * for rather than absorbed.
 */
const NOT_A_CONFIRMATION: Record<string, string> = {
  'components/valuation/AiPanel.tsx:notes':
    'The AI job’s own output, rendered when the job carries notes — a result the reader came to read, not a report on an action they took.',
  'pages/InboxPage.tsx:canPostNote':
    'A permission boolean gating the chat/note toggle. The word is “note” in the sense of an internal message, and what it guards is a pair of buttons.',
};

describe('an action that succeeded is announced', () => {
  const silent: string[] = [];
  const shapes: string[] = [];
  for (const { file, text } of FILES) {
    for (const m of text.matchAll(OUTCOME_FLAG)) {
      const tagStart = text.indexOf('<', m.index + m[0].length - 1);
      const end = tagEnd(text, tagStart);
      if (end < 0) continue;
      const tag = text.slice(tagStart, end + 1);
      // The live role may be on this element or on the note it wraps.
      const opening = text.slice(tagStart, end + 81);
      const key = `${file}:${m[1]}`;
      shapes.push(key);
      if (!ANNOUNCED.test(tag) && !ANNOUNCED.test(opening) && !(key in NOT_A_CONFIRMATION)) {
        silent.push(`${key} (line ${text.slice(0, m.index).split('\n').length})`);
      }
    }
  }

  it('is looking at a source tree that still has confirmations in it', () => {
    // The vacuity guard: a renamed flag convention would empty the scan and
    // turn the assertion below into a check that passes by asking nothing.
    expect(shapes.length).toBeGreaterThan(25);
  });

  it('leaves no outcome note that says nothing to a screen reader', () => {
    expect(silent).toEqual([]);
  });

  it('still finds the two shapes that are not confirmations', () => {
    // If either stops matching, the exclusion is dead weight and the reason
    // above has quietly stopped applying to anything.
    for (const key of Object.keys(NOT_A_CONFIRMATION)) {
      expect(shapes, `${key} no longer matches — drop the exclusion`).toContain(key);
    }
  });
});

describe('SuccessNote', () => {
  it('announces politely, where ErrorNote interrupts', () => {
    // The pairing is the point. An error has to cut in; a confirmation must
    // never cut across what the reader is in the middle of.
    render(<SuccessNote>Branding updated.</SuccessNote>);
    expect(screen.getByRole('status')).toHaveTextContent('Branding updated.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws the box the fourteen hand-written ones drew', () => {
    // Adopting it must not move anything on screen, or the fix becomes a
    // redesign that has to be reviewed page by page.
    const { container } = render(<SuccessNote>Saved.</SuccessNote>);
    const box = container.firstElementChild!;
    expect(box.className).toContain('border-bond-200');
    expect(box.className).toContain('bg-bond-50');
    expect(box.className).toContain('text-bond-700');
  });

  it('takes an extra class without losing its own', () => {
    const { container } = render(<SuccessNote className="mt-6">Saved.</SuccessNote>);
    expect(container.firstElementChild!.className).toContain('mt-6');
    expect(container.firstElementChild!.className).toContain('bg-bond-50');
  });

  it('renders nothing when there is nothing to confirm', () => {
    // Same contract as ErrorNote: an always-mounted empty box would be a
    // permanently open live region, which announces the *next* thing that
    // happens to land in it.
    const { container } = render(<SuccessNote>{null}</SuccessNote>);
    expect(container).toBeEmptyDOMElement();
    const both = render(<ErrorNote>{null}</ErrorNote>);
    expect(both.container).toBeEmptyDOMElement();
  });
});
