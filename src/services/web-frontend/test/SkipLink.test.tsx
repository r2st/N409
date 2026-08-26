import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAIN_CONTENT_ID, SkipLink, mainContentTargetProps } from '../src/components/SkipLink';

/**
 * WCAG 2.4.1 (Bypass Blocks). The app shell puts ~30 nav links ahead of the
 * content and the marketing header another dozen; without a bypass every
 * keyboard navigation replays all of them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
/** Every source file under src/, so the shell census below is not a hand-list. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx$/.test(full) ? [full] : [];
  });
}

describe('SkipLink', () => {
  it('is in the tab order but visually hidden until focused', async () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    // sr-only clips it to 1px rather than removing it from the tab order,
    // which display:none / visibility:hidden would.
    expect(link).toHaveClass('sr-only');
    expect(link.className).toContain('focus:not-sr-only');
    await userEvent.tab();
    expect(link).toHaveFocus();
  });

  it('points at the shared main-content anchor', () => {
    render(<SkipLink />);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      `#${MAIN_CONTENT_ID}`,
    );
  });

  it('moves focus to the target, not just the scroll position', async () => {
    render(
      <>
        <SkipLink />
        <main {...mainContentTargetProps}>
          <button>First control</button>
        </main>
      </>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Skip to main content' }));
    // A bare fragment jump scrolls but leaves focus at the top of the document,
    // so the next Tab would replay the nav. The handler focuses the target.
    expect(document.getElementById(MAIN_CONTENT_ID)).toHaveFocus();
  });

  it('lands focus such that the next Tab reaches the content', async () => {
    render(
      <>
        <SkipLink />
        <main {...mainContentTargetProps}>
          <button>First control</button>
        </main>
      </>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Skip to main content' }));
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'First control' })).toHaveFocus();
  });

  it('degrades to the plain fragment when the target is absent', async () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    // No <main> on the page: the handler must not preventDefault and swallow
    // the navigation, leaving the user with a dead control.
    await userEvent.click(link);
    expect(document.getElementById(MAIN_CONTENT_ID)).toBeNull();
  });
});

describe('mainContentTargetProps', () => {
  it('makes the target programmatically focusable without a focus ring', () => {
    // tabIndex -1 is what lets .focus() work on a <main>; without it the skip
    // link scrolls but focus stays put.
    expect(mainContentTargetProps.tabIndex).toBe(-1);
    expect(mainContentTargetProps.id).toBe(MAIN_CONTENT_ID);
    expect(mainContentTargetProps.className).toContain('outline-none');
  });
});

describe('every page shell wires the bypass', () => {
  /**
   * This census used to be a list of three filenames. That is the version of
   * this test that cannot work: a shell is not a fixed set, and the list went
   * stale in both directions at once. `App.tsx` stopped rendering a `<main>`
   * when `/` was moved onto the shared marketing shell, so one third of the
   * census was asserting against a file with nothing left to assert on — and
   * meanwhile the three pages that render their own `<main>` outside any
   * layout (the intake and board-signing portals, and the 404) had never been
   * looked at, because naming the shells by hand is exactly what stops you
   * finding the ones you did not think of.
   *
   * So the set is derived. Whatever renders a `<main>` is a shell, and the
   * rules below follow from what is actually on the page rather than from a
   * list someone has to remember to update.
   */
  const JSX_MAIN = /<main[\s>]/;
  const JSX_NAV = /<nav[\s>]/;
  const SKIP_LINK = /<SkipLink\s*\/>/;

  /** Prose says `<main>` too — the docs on SkipLink itself are full of it. */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const sources = walk(SRC).map((file) => ({
    file: path.relative(SRC, file).split(path.sep).join('/'),
    text: code(readFileSync(file, 'utf8')),
  }));

  const withMain = sources.filter((s) => JSX_MAIN.test(s.text));

  it('finds the shells rather than being told them', () => {
    // Vacuity guard: a derived census that derives nothing passes silently.
    expect(withMain.length).toBeGreaterThanOrEqual(4);
    expect(withMain.map((s) => s.file)).toContain('components/AppLayout.tsx');
    expect(withMain.map((s) => s.file)).toContain('components/MarketingLayout.tsx');
  });

  it('gives every <main> in the app the skip target props', () => {
    // Not just the shells: the skip link resolves `#main-content` at click
    // time, so a <main> that does not carry the id is a bypass that lands
    // nowhere on that page — and the pages most likely to grow their own
    // <main> are the standalone ones with no layout to inherit it from.
    const untargeted = withMain
      .flatMap(({ file, text }) => [...text.matchAll(/<main[\s>][^>]*/g)].map((m) => ({ file, tag: m[0] })))
      .filter(({ tag }) => !tag.includes('mainContentTargetProps'))
      .map(({ file }) => file);
    expect(untargeted).toEqual([]);
  });

  it('puts a skip link on every shell that has blocks worth skipping', () => {
    // WCAG 2.4.1 is about *repeated* content ahead of the main landmark. A nav
    // beside a main is that, and it is what separates the two real shells from
    // a portal page whose header is a logo and nothing else.
    const missing = withMain
      .filter((s) => JSX_NAV.test(s.text) && !SKIP_LINK.test(s.text))
      .map((s) => s.file);
    expect(missing).toEqual([]);
  });

  it('leaves no skip link without something to skip to', () => {
    // The other direction: a SkipLink rendered in a file with no target <main>
    // is a control that focuses nothing. `degrades to the plain fragment`
    // above proves it fails softly; this proves it does not ship that way.
    const dangling = sources
      .filter((s) => SKIP_LINK.test(s.text) && !JSX_MAIN.test(s.text))
      .map((s) => s.file);
    expect(dangling).toEqual([]);
  });
});
