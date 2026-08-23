import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tabListKeyDown, tabProps } from '../src/lib/tablist';

/**
 * `role="tablist"` is a promise about the keyboard.
 *
 * A screen reader announcing "Drafted, tab, 6 of 9" is telling the user that
 * the arrows move between those nine and that Tab leaves the strip. Both
 * tablists on the platform delivered neither — arrows did nothing, and all
 * nine sat in the tab order — which is a worse state than plain buttons, since
 * plain buttons promise nothing and keep the promise.
 */

function Strip({ count = 3, onPick = vi.fn() }: { count?: number; onPick?: (i: number) => void }) {
  return (
    <div role="tablist" aria-label="Strip" onKeyDown={tabListKeyDown}>
      {Array.from({ length: count }, (_, i) => (
        <button key={i} {...tabProps(i === 0)} onClick={() => onPick(i)}>
          {/* A child, so the key event bubbles from something that is not the
              tab itself — which is the ordinary case: every tab in the
              valuations strip carries a count badge. */}
          <span>Tab {i + 1}</span>
        </button>
      ))}
    </div>
  );
}

const tabs = () => screen.getAllByRole('tab');

describe('tabListKeyDown', () => {
  it('moves right and wraps', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    tabs()[0]!.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tabs()[2]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tabs()[0]).toHaveFocus();
  });

  it('moves left and wraps', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    tabs()[0]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs()[2]).toHaveFocus();
  });

  it('takes Home and End', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    tabs()[1]!.focus();
    await user.keyboard('{End}');
    expect(tabs()[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tabs()[0]).toHaveFocus();
  });

  it('finds the current tab from a child the event bubbled through', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    // Reading `document.activeElement` would work here and stop working the
    // day a tab holds its own focusable child; reading the event target is
    // what makes the badge inside every valuations tab irrelevant.
    const inner = screen.getByText('Tab 2').parentElement!;
    inner.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs()[2]).toHaveFocus();
  });

  it('leaves keys it does not own to the browser', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Strip onPick={onPick} />);
    tabs()[0]!.focus();
    // Swallowing everything would take activation with it — these are buttons,
    // and Enter and Space are how a button is pressed.
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(0);
  });

  it('does nothing for a strip with no tabs in it', async () => {
    const user = userEvent.setup();
    render(<Strip count={0} />);
    screen.getByRole('tablist').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('skips a disabled tab rather than parking focus on it', async () => {
    const user = userEvent.setup();
    render(
      <div role="tablist" aria-label="Strip" onKeyDown={tabListKeyDown}>
        <button {...tabProps(true)}>One</button>
        <button {...tabProps(false)} disabled>
          Two
        </button>
        <button {...tabProps(false)}>Three</button>
      </div>,
    );
    screen.getByText('One').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Three')).toHaveFocus();
  });
});

describe('tabProps', () => {
  it('puts only the selected tab in the tab order', () => {
    render(<Strip />);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  });
});

// ── Nothing declares the role without honouring it ──────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/** The helper is where the strings live; it is not a tablist itself. */
const DEFINES_IT = 'lib/tablist.ts';

describe('every declared tablist honours the contract', () => {
  const declaring = FILES.filter(({ file, text }) => file !== DEFINES_IT && /role="tablist"/.test(text));

  it('can still see a tablist', () => {
    // The vacuity guard: both assertions below pass for a scan that found no
    // tablists at all.
    expect(declaring.map((d) => d.file).sort()).toEqual([
      'pages/ValuationsPage.tsx',
      'pages/marketing/MarketingSections.tsx',
    ]);
  });

  it('wires the keyboard on every one of them', () => {
    // Counted rather than merely present. A file that imports the handler and
    // then loses the attribute still mentions the name once, so `includes`
    // passes for the exact edit this is meant to catch — and a page that grows
    // a second tablist has to wire that one too.
    const silent = declaring
      .filter(({ text }) => {
        const lists = text.match(/role="tablist"/g)?.length ?? 0;
        const wired = text.match(/onKeyDown=\{tabListKeyDown\}/g)?.length ?? 0;
        return wired < lists;
      })
      .map((d) => d.file);
    expect(silent).toEqual([]);
  });

  it('leaves the roving tabindex to the helper rather than hand-writing it', () => {
    // A hand-written `role="tab"` is a tab without `tabProps`, which means
    // `aria-selected` and `tabIndex` written separately — and those are the
    // same fact, so they drift.
    const handRolled = FILES.filter(
      ({ file, text }) => file !== DEFINES_IT && /role="tab"[\s/>]/.test(text),
    ).map((f) => f.file);
    expect(handRolled).toEqual([]);
  });
});
