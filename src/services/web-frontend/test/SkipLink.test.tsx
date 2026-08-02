import { readFileSync } from 'node:fs';
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
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

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
  // A skip link that only exists in one of three shells is a skip link that
  // fails on two thirds of the site, and nothing else would catch that.
  const SHELLS = ['components/AppLayout.tsx', 'components/MarketingLayout.tsx', 'App.tsx'];

  it.each(SHELLS)('%s renders a SkipLink', (shell) => {
    expect(read(shell)).toMatch(/<SkipLink\s*\/>/);
  });

  it.each(SHELLS)('%s gives its <main> the skip target props', (shell) => {
    expect(read(shell)).toMatch(/<main\s+\{\.\.\.mainContentTargetProps\}/);
  });

  it('has no <main> left that the skip link cannot reach', () => {
    for (const shell of SHELLS) {
      const text = read(shell);
      const mains = [...text.matchAll(/<main\b[^>]*/g)].map((m) => m[0]);
      expect(mains.length).toBeGreaterThan(0);
      for (const tag of mains) expect(tag).toContain('mainContentTargetProps');
    }
  });
});
