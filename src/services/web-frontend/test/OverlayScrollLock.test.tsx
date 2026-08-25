import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Button, Modal } from '../src/components/ui';
import { HelpIcon } from '../src/components/HelpIcon';

/**
 * The page behind the backdrop.
 *
 * Every full-viewport overlay in the product paints a scrim over the document
 * and then leaves the document scrolling underneath it. The wheel over the
 * scrim moves the list behind the dialog; on a phone a drag does, and so does
 * a flick inside the dialog's own scroll area once it hits its end, because a
 * scroll that runs out chains to the nearest scrollable ancestor. Nothing on
 * screen explains it — the reader closes the dialog and the list is not where
 * they left it.
 *
 * `useScrollLock` is the fix and these are its edges: it must put back what it
 * found rather than a blank, it must survive two overlays open at once, and it
 * must not invent a scrollbar out of a viewport it cannot measure.
 */

const bodyOverflow = () => document.body.style.overflow;
const rootOverflow = () => document.documentElement.style.overflow;

/** A dialog opened from a button, the shape every real caller has. */
function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Convert to an engagement">
        <Button onClick={() => setOpen(false)}>Done</Button>
      </Modal>
    </div>
  );
}

describe('an overlay holds the document still while it covers it', () => {
  it('locks the page when a dialog opens and releases it when the dialog closes', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    expect(bodyOverflow()).toBe('');
    expect(rootOverflow()).toBe('');

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    // Both boxes: which of the root element and the body is the viewport's
    // scrolling box depends on the document, so locking one is locking maybe.
    expect(bodyOverflow()).toBe('hidden');
    expect(rootOverflow()).toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(bodyOverflow()).toBe('');
    expect(rootOverflow()).toBe('');
  });

  it('restores what it found rather than blanking the style it did not set', async () => {
    const user = userEvent.setup();
    // A page that had its own inline overflow before any dialog existed.
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
    try {
      render(<ModalHarness />);
      await user.click(screen.getByRole('button', { name: 'Open dialog' }));
      expect(bodyOverflow()).toBe('hidden');

      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(bodyOverflow()).toBe('auto');
      expect(rootOverflow()).toBe('auto');
    } finally {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    }
  });

  it('does not pad the body for a scrollbar when the document reports no width', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    /*
     * jsdom reports `clientWidth` as 0. The naive gutter measurement —
     * innerWidth minus clientWidth — reads the entire viewport as scrollbar
     * and shoves the body a thousand pixels off its own right edge. A
     * measurement of zero is not a measurement, and the guard that says so is
     * the only thing standing between a real browser's 15px gutter and that.
     */
    expect(document.body.style.paddingRight).toBe('');
    await user.click(screen.getByRole('button', { name: 'Done' }));
  });
});

/** Two overlays at once: ⌘K answers from anywhere, including from a dialog. */
function StackedHarness() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <div>
      <button onClick={() => setOuter(true)}>Open outer</button>
      <Modal open={outer} onClose={() => setOuter(false)} title="Outer">
        <Button onClick={() => setInner(true)}>Open inner</Button>
      </Modal>
      <Modal open={inner} onClose={() => setInner(false)} title="Inner">
        <Button onClick={() => setInner(false)}>Close inner</Button>
      </Modal>
    </div>
  );
}

describe('the last overlay out is the one that gives the page back', () => {
  it('keeps the page locked when an overlay closes on top of another', async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);

    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    expect(bodyOverflow()).toBe('hidden');

    // The inner dialog closes; the outer one is still covering the page.
    await user.click(screen.getByRole('button', { name: 'Close inner' }));
    expect(bodyOverflow()).toBe('hidden');

    await user.keyboard('{Escape}');
    expect(bodyOverflow()).toBe('');
  });
});

describe('the help slide-over locks the page too', () => {
  it('locks while the article is open and releases when it is dismissed', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HelpIcon article="valuation-methods" />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /^Help:/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(bodyOverflow()).toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'Close help' }));
    expect(bodyOverflow()).toBe('');
  });
});

/**
 * The census. A component that paints a full-viewport scrim and calls the
 * thing behind it a dialog has taken the page over; taking the page over and
 * leaving it scrolling is the bug. This is a source scan rather than a render
 * because what it guards is the *next* overlay — the one nobody has written a
 * test for yet — and the rule has to be able to see it the day it lands.
 */
const componentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/components');

function overlaySources(): Array<{ file: string; source: string }> {
  return readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ file: name, source: readFileSync(path.join(componentsDir, name), 'utf8') }))
    .filter(({ source }) => source.includes('fixed inset-0') && source.includes('role="dialog"'));
}

/**
 * The hook's own declaration is not a call site. `ui.tsx` both defines
 * `useScrollLock` and uses it, so a scan for the bare identifier reports the
 * file as locked for as long as the definition is there — including after the
 * one component in it that needed the call has stopped making it. Stripping
 * the declaration first is what keeps the rule from passing vacuously, which
 * is the failure this file is otherwise built to catch.
 */
const callsScrollLock = (source: string): boolean =>
  source.replace(/export function useScrollLock[\s\S]*?\n}/, '').includes('useScrollLock(');

describe('every full-viewport overlay locks the page behind it', () => {
  it('finds the overlays it is meant to be guarding', () => {
    // A census that has stopped matching anything passes by having nothing to
    // ask. These three are the overlays with a scrim as of this round.
    expect(
      overlaySources()
        .map((o) => o.file)
        .sort(),
    ).toEqual(['CommandPalette.tsx', 'HelpIcon.tsx', 'ui.tsx']);
  });

  it('has no overlay that paints a scrim without holding the page still', () => {
    const unlocked = overlaySources()
      .filter(({ source }) => !callsScrollLock(source))
      .map(({ file }) => file);
    expect(unlocked).toEqual([]);
  });

  it('contains the scroll gesture inside the scrim rather than chaining it out', () => {
    /*
     * The lock stops the page scrolling; containment stops the gesture being
     * handed to the page in the first place. They are not the same fix — a
     * flick that runs past the end of the dialog's own list is handled by the
     * second, before the first is ever consulted.
     */
    const uncontained = overlaySources()
      .filter(({ source }) => !source.includes('overscroll-contain'))
      .map(({ file }) => file);
    expect(uncontained).toEqual([]);
  });
});
