import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R188 — a placeholder that nobody can hear.
 *
 * Every skeleton primitive is `aria-hidden` by construction, and correctly so:
 * a screen reader gains nothing from thirty pulsing rectangles. The
 * announcement is `LoadingBlock`'s job, and `Spinner` carries its own. That
 * division is already proved in Skeletons.test.tsx — for the primitives.
 *
 * What was not checked is the call sites, and one of them had drawn its entire
 * loading state out of `aria-hidden` parts: `CapabilityRoster` answered a wait
 * with a bare `<Skeleton className="h-24 w-full" />`. The roster is the whole
 * of what that panel says, so between opening the admin settings page and the
 * answer arriving there was nothing at all to report — not the wait, not the
 * content. A slow request and a panel that renders nothing are the same
 * experience.
 *
 * The rule is per file rather than per placeholder, and that is deliberate.
 * Requiring every skeleton tag to sit inside a `LoadingBlock` would be wrong:
 * `AdminApiTokensPage` draws a stat strip *and* a table for the same single
 * load, and wrapping both would put two live regions on one wait — which
 * Skeletons.test.tsx separately forbids. One announcement per surface is the
 * contract; this checks the surface has one at all.
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

const FILES = walk(SRC)
  .map((file) => ({
    file: path.relative(SRC, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }))
  // The primitives themselves define both halves; they are not a call site.
  .filter(({ file }) => file !== 'components/ui.tsx');

/** Every placeholder primitive. All of them are `aria-hidden` by design. */
const SILENT_PLACEHOLDER =
  /<(Skeleton|SkeletonText|SkeletonTable|SkeletonCardList|SkeletonDividedList|SkeletonStatStrip|StatCardSkeleton)[\s/>]/;

/** Anything that makes the wait audible. */
const ANNOUNCES = /<LoadingBlock|<Spinner|<PageSkeleton|role="status"|aria-busy/;

describe('a surface that draws placeholders announces the wait', () => {
  const drawing = FILES.filter(({ text }) => SILENT_PLACEHOLDER.test(text));

  it('is looking at a source tree with placeholders in it', () => {
    expect(drawing.length).toBeGreaterThan(15);
  });

  it('has no surface whose whole loading state is aria-hidden', () => {
    const silent = drawing.filter(({ text }) => !ANNOUNCES.test(text)).map(({ file }) => file);
    expect(silent).toEqual([]);
  });
});
