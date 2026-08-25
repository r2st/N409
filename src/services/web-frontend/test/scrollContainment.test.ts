import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A scroll that runs out is handed to whatever is behind it.
 *
 * That is the default, and it is almost never what the page means. Flick
 * through the resolution text on the board-sign page, reach the bottom, and
 * the page itself starts moving — the panel you were reading scrolls out of
 * view. Open the mobile navigation drawer, scroll to the last item, keep
 * going, and the workspace behind it moves instead; close the drawer and you
 * are somewhere else than where you opened it. Nothing on screen announces the
 * handover, so what the reader experiences is the page moving on its own.
 *
 * Sideways it is worse than a surprise. A wide table — the cap table, the
 * comparables grid, the waterfall — scrolls horizontally inside its own
 * container, and a horizontal scroll that reaches the container's edge and
 * keeps going is the same gesture the browser reads as "go back". A trackpad
 * swipe across a cap table could navigate out of a half-filled form.
 *
 * `overscroll-behavior: contain` ends the chain at the container that owns the
 * gesture. This census asks every scroll container in the app to declare it,
 * on the axis it actually scrolls: containing an axis the element does not
 * scroll is not free, because an element that is not a scroll container on
 * that axis should still pass the gesture up — a vertical flick over a wide
 * table has to keep scrolling the page.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** `overflow-*-auto` utility → the containment utility that must accompany it. */
const AXES = [
  { scrolls: 'overflow-auto', contains: 'overscroll-contain' },
  { scrolls: 'overflow-y-auto', contains: 'overscroll-y-contain' },
  { scrolls: 'overflow-x-auto', contains: 'overscroll-x-contain' },
] as const;

/** Whole-word: `overflow-auto` must not match inside `overflow-x-auto`. */
const uses = (line: string, util: string): boolean => new RegExp(`(?<![-\\w])${util}(?![-\\w])`).test(line);

/**
 * A line of prose about a utility is not a use of it. `AppLayout` explains in
 * a comment why its sidebar nav scrolls, and a scan that cannot tell that from
 * markup reports a comment as an unguarded scroll container forever.
 */
const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

interface ScrollSite {
  file: string;
  line: number;
  axis: string;
  contained: boolean;
}

function scrollSites(): ScrollSite[] {
  const sites: ScrollSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.tsx')) continue;
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (isComment(line)) return;
          for (const { scrolls, contains } of AXES) {
            if (!uses(line, scrolls)) continue;
            sites.push({
              file: path.relative(SRC, full),
              line: index + 1,
              axis: scrolls,
              contained: uses(line, contains),
            });
          }
        });
    }
  };
  walk(SRC);
  return sites;
}

describe('every scroll container keeps its own scroll', () => {
  it('finds the scroll containers it is meant to be guarding', () => {
    // A census that has stopped matching anything passes by having nothing to
    // ask. The count moves with the product; a floor is what keeps the rule
    // from quietly becoming a no-op if the utility is ever renamed.
    const sites = scrollSites();
    expect(sites.length).toBeGreaterThan(80);
    // All three axes are represented, so no branch of the rule is untested.
    expect(new Set(sites.map((s) => s.axis))).toEqual(
      new Set(['overflow-auto', 'overflow-y-auto', 'overflow-x-auto']),
    );
  });

  it('has no scroll container that hands its overflow to the page', () => {
    const chaining = scrollSites()
      .filter((s) => !s.contained)
      .map((s) => `${s.file}:${s.line} (${s.axis})`);
    expect(chaining).toEqual([]);
  });

  it('does not contain an axis the container does not scroll', () => {
    /*
     * The converse, and the reason the rule is written per axis. A wide table
     * with blanket `overscroll-contain` swallows the vertical flick that was
     * meant for the page: the reader puts a finger on the only thing filling
     * the screen and the screen refuses to move.
     */
    const overreaching = scrollSites()
      .filter((s) => s.axis === 'overflow-x-auto')
      .filter((s) => {
        const line = readFileSync(path.join(SRC, s.file), 'utf8').split('\n')[s.line - 1] ?? '';
        return uses(line, 'overscroll-contain') && !uses(line, 'overflow-y-auto');
      })
      .map((s) => `${s.file}:${s.line}`);
    expect(overreaching).toEqual([]);
  });
});
