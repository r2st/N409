import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { radioGroupKeyDown, radioProps, tabListKeyDown, tabProps } from '../src/lib/rovingFocus';
import { ThemeToggle } from '../src/components/ThemeToggle';

/**
 * `role="tablist"` and `role="radiogroup"` are promises about the keyboard.
 *
 * A screen reader announcing "Drafted, tab, 6 of 9" is telling the user that
 * the arrows move between those nine and that Tab leaves the strip. Three
 * groups on the platform delivered neither — arrows did nothing, and all nine
 * sat in the tab order — which is a worse state than plain buttons, since
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

function Radios({ onPick = vi.fn() }: { onPick?: (i: number) => void }) {
  const [chosen, setChosen] = useState(0);
  return (
    <div role="radiogroup" aria-label="Group" onKeyDown={radioGroupKeyDown}>
      {['Light', 'System', 'Dark'].map((label, i) => (
        <button
          key={label}
          type="button"
          {...radioProps(i === chosen)}
          onClick={() => {
            setChosen(i);
            onPick(i);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const radios = () => screen.getAllByRole('radio');

describe('radioGroupKeyDown', () => {
  it('selects as it moves, which is what a radio group does', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Radios onPick={onPick} />);
    radios()[0]!.focus();

    // Unlike a tablist: a group that only moved focus would leave a keyboard
    // user unable to see what they had picked.
    await user.keyboard('{ArrowRight}');
    expect(onPick).toHaveBeenCalledWith(1);
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios()[1]).toHaveFocus();
  });

  it('takes the vertical arrows as well as the horizontal', async () => {
    const user = userEvent.setup();
    render(<Radios />);
    radios()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(radios()[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(radios()[0]).toHaveFocus();
  });

  it('moves the single tab stop with the answer', async () => {
    const user = userEvent.setup();
    render(<Radios />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    await user.click(radios()[2]!);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });
});

describe('ThemeToggle', () => {
  it('changes the theme from the keyboard', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const options = screen.getAllByRole('radio');
    const checked = () => options.find((o) => o.getAttribute('aria-checked') === 'true');

    checked()!.focus();
    await user.keyboard('{ArrowRight}');
    // The segmented control is the only way to reach 'system' explicitly, and
    // before this the arrows did nothing on it at all.
    expect(checked()).toHaveFocus();
    expect(checked()!.textContent).not.toBe(options[0]!.textContent);
  });

  it('always has an answer, so the group is never out of the tab order', () => {
    // `radioProps` gives the tab stop to the checked option and there is no
    // "none checked" branch, so this is the precondition it depends on.
    render(<ThemeToggle />);
    const stops = screen.getAllByRole('radio').filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAttribute('aria-checked', 'true');
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

/** The helper is where the strings live; it is not a group itself. */
const DEFINES_IT = 'lib/rovingFocus.ts';

/**
 * The two container roles and the handler each one must carry.
 *
 * `ParamsPanel`'s DLOM group is a `radiogroup` around native
 * `<input type="radio">` sharing a `name`, which the browser already navigates
 * with the arrows and already gives a single tab stop. It is exempt because
 * the platform is not the thing implementing the pattern there.
 */
const CONTAINERS = [
  { role: 'radiogroup', handler: 'radioGroupKeyDown', native: ['components/valuation/ParamsPanel.tsx'] },
  { role: 'tablist', handler: 'tabListKeyDown', native: [] as string[] },
];

describe('every declared group honours the keyboard contract', () => {
  it('can still see the groups it is looking for', () => {
    // The vacuity guard: every assertion below passes for a scan that found no
    // groups at all.
    const found = FILES.filter(
      ({ file, text }) => file !== DEFINES_IT && /role="(tablist|radiogroup)"/.test(text),
    ).map((f) => f.file);
    expect(found.sort()).toEqual([
      'components/ThemeToggle.tsx',
      'components/valuation/ParamsPanel.tsx',
      'pages/ValuationsPage.tsx',
      'pages/marketing/MarketingSections.tsx',
    ]);
  });

  it.each(CONTAINERS)('wires $handler on every $role', ({ role, handler, native }) => {
    // Counted rather than merely present. A file that keeps the import and
    // loses the attribute still mentions the name once, so a containment test
    // passes for the exact edit this is meant to catch — and a page that grows
    // a second group has to wire that one too.
    const silent = FILES.filter(({ file, text }) => {
      if (file === DEFINES_IT || native.includes(file)) return false;
      const groups = text.match(new RegExp(`role="${role}"`, 'g'))?.length ?? 0;
      const wired = text.match(new RegExp(`onKeyDown=\\{${handler}\\}`, 'g'))?.length ?? 0;
      return wired < groups;
    }).map((f) => f.file);
    expect(silent).toEqual([]);
  });

  it('keeps the native radio group on native radios, so the exemption stays true', () => {
    // An exemption that outlives its reason silently licenses the next one.
    const params = FILES.find((f) => f.file === 'components/valuation/ParamsPanel.tsx');
    expect(params).toBeDefined();
    expect(params!.text).toMatch(/name="dlom-form"/);
    expect(params!.text).not.toMatch(/role="radio"/);
  });

  it.each(['tab', 'radio'])('leaves the roving tabindex on role="%s" to the helper', (role) => {
    // A hand-written `role="tab"` is an option without `tabProps`, which means
    // the selected flag and `tabIndex` written separately — and those are the
    // same fact, so they drift.
    const handRolled = FILES.filter(
      ({ file, text }) => file !== DEFINES_IT && new RegExp(`role="${role}"[\\s/>]`).test(text),
    ).map((f) => f.file);
    expect(handRolled).toEqual([]);
  });
});
