import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level responsive guards for the public marketing pages.
 *
 * jsdom has no layout engine, so a rendering test cannot detect that an element
 * overflows a 375px viewport. What it *can* do is catch the constructs that
 * cause it: a fixed pixel or rem width applied unconditionally, or a wide table
 * with nowhere to scroll. Both are the usual way a marketing page that looks
 * right on the developer's monitor breaks on the phone a founder reads it on.
 */

const MARKETING = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/pages/marketing',
);
const LAYOUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/components/MarketingLayout.tsx',
);

const FILES = [
  ...readdirSync(MARKETING)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => path.join(MARKETING, f)),
  LAYOUT,
].map((file) => ({ file: path.basename(file), text: readFileSync(file, 'utf8') }));

/** Class strings in the file, with any responsive/state prefix intact. */
function classNames(text: string): string[] {
  return [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? '').split(/\s+/))
    .filter(Boolean);
}

describe('marketing pages stay within a 375px viewport', () => {
  /**
   * Fixed widths that are known-safe, each with the reason it cannot overflow.
   * Anything not listed here fails — the point is that a new fixed width has to
   * be justified rather than merely happen to work on the author's screen.
   */
  const ALLOWED_FIXED_WIDTHS = new Map([
    [
      'LandingPage.tsx: w-[28rem]',
      'decorative blur, absolutely positioned inside an overflow-hidden hero',
    ],
    [
      'MarketingLayout.tsx: w-[34rem]',
      'desktop-only products dropdown, capped by max-w-[calc(100vw-2.5rem)]',
    ],
  ]);

  it('applies no unjustified fixed width', () => {
    // An unprefixed `w-[34rem]` is 544px of guaranteed horizontal scroll on a
    // phone. `min-w-[…]` is exempt: those sit inside overflow-x-auto containers
    // by design (see the table check below).
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      for (const cls of classNames(text)) {
        const key = `${file}: ${cls}`;
        if (/^w-\[\d/.test(cls) && !ALLOWED_FIXED_WIDTHS.has(key)) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('caps the desktop products dropdown to the viewport', () => {
    // At exactly 768px a centred 34rem panel clears the left edge by 4px.
    const layout = FILES.find((f) => f.file === 'MarketingLayout.tsx')!.text;
    expect(layout).toContain('max-w-[calc(100vw-2.5rem)]');
  });

  it('gives every wide table a horizontal scroll container', () => {
    // A `min-w-[720px]` table is deliberate — it must live inside something
    // that scrolls, or it drags the whole page sideways.
    for (const { file, text } of FILES) {
      const wideTables = [...text.matchAll(/min-w-\[\d+px\]/g)];
      if (wideTables.length === 0) continue;
      const scrollContainers = [...text.matchAll(/overflow-x-auto/g)];
      expect(scrollContainers.length, `${file}: wide table without a scroll container`).toBe(
        wideTables.length,
      );
    }
  });

  it('lets the multi-column grids collapse to one column', () => {
    // A bare `grid-cols-N` (N > 1) never collapses; the responsive form is
    // `grid-cols-1` plus an `sm:`/`md:`/`lg:` prefixed multi-column rule.
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      for (const cls of classNames(text)) {
        const match = /^grid-cols-(\d+)$/.exec(cls);
        if (match && Number(match[1]) > 2) offenders.push(`${file}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('wraps the hero trust row rather than letting it overflow', () => {
    const landing = FILES.find((f) => f.file === 'LandingPage.tsx')!.text;
    expect(landing).toMatch(/No credit card required/);
    const row = /className="mt-6 flex([^"]*)"/.exec(landing)?.[1] ?? '';
    expect(row, 'hero trust row must wrap').toContain('flex-wrap');
  });
});
