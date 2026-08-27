import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpWidget } from '../src/components/HelpWidget';
import { CookieConsent } from '../src/components/CookieConsent';
import { ConsentProvider } from '../src/lib/consent';

/**
 * `aria-modal` is a claim about the rest of the page, not a decoration.
 *
 * It tells assistive technology to drop everything outside the dialog from the
 * virtual buffer, and the Tab trap enforces the same claim for the keyboard.
 * On an overlay that paints a scrim both are true for everyone: nothing behind
 * can be clicked either.
 *
 * Two surfaces claimed it with no scrim at all. The help widget is a corner
 * card whose entire point is to be read beside the form it explains; the
 * cookie gate is a strip along the bottom of the marketing site on a first
 * visit. Behind both, every control stays visible and clickable — for a mouse.
 * A screen-reader user got the application taken away instead, which on the
 * marketing site means a first visit that cannot be read at all until a
 * consent choice is made.
 */

afterEach(() => vi.restoreAllMocks());

function renderWidget() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ articles: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return render(
    <MemoryRouter>
      <HelpWidget />
      <a href="/behind">A link on the page behind</a>
    </MemoryRouter>,
  );
}

describe('the help widget is a panel beside the page, not a wall in front of it', () => {
  it('does not tell assistive technology the page is gone', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByRole('button', { name: 'Open help' }));

    const dialog = await screen.findByRole('dialog', { name: 'Help & support' });
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
  });

  it('lets the keyboard walk back out to the page while it stays open', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByRole('button', { name: 'Open help' }));

    /*
     * Tab forward until focus leaves the panel. With a trap it never does —
     * the last control hands focus back to the first for as long as anyone
     * keeps pressing — so the bound is what makes the assertion, not the exit.
     * `document.body` does not count as having left: it is where user-event
     * parks focus as it wraps around the end of the document, not a place on
     * the page a reader can be.
     */
    let escaped = false;
    for (let i = 0; i < 20 && !escaped; i++) {
      await user.tab();
      const panel = screen.getByRole('dialog', { name: 'Help & support' });
      escaped = document.activeElement !== document.body && !panel.contains(document.activeElement);
    }
    expect(escaped).toBe(true);
    // Walking out does not dismiss it — the panel is meant to stay open beside
    // whatever the reader goes back to.
    expect(screen.getByRole('dialog', { name: 'Help & support' })).toBeTruthy();
  });

  it('still dismisses on Escape and hands focus back to the launcher', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByRole('button', { name: 'Open help' }));
    await screen.findByRole('dialog', { name: 'Help & support' });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open help' })).toHaveFocus();
  });
});

function renderGate() {
  window.localStorage.clear();
  return render(
    <MemoryRouter>
      <ConsentProvider>
        <a href="/pricing">Pricing</a>
        <CookieConsent />
      </ConsentProvider>
    </MemoryRouter>,
  );
}

describe('the cookie gate does not hide the site it is asking about', () => {
  it('does not claim the page behind it is inert', () => {
    renderGate();
    const banner = screen.getByRole('dialog', { name: 'Cookie consent' });
    expect(banner.hasAttribute('aria-modal')).toBe(false);
  });

  it('lets a first-time visitor reach the page around it', async () => {
    const user = userEvent.setup();
    renderGate();
    screen.getByRole('dialog', { name: 'Cookie consent' });

    await user.tab({ shift: true });
    const banner = screen.getByRole('dialog', { name: 'Cookie consent' });
    expect(banner.contains(document.activeElement)).toBe(false);
  });

  it('still declines on Escape', async () => {
    const user = userEvent.setup();
    renderGate();
    screen.getByRole('dialog', { name: 'Cookie consent' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cookie consent' })).toBeNull());
  });
});

/**
 * The census. A dialog may say `aria-modal` when — and only when — it paints a
 * scrim over the document, because that is the one arrangement in which the
 * page really is unreachable for every input device and not just for the two
 * the dialog happens to intercept.
 */
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * Every `.tsx` under `src`, not just the flat listing of `src/components`.
 *
 * The census used to read one directory, non-recursively, which asked its four
 * questions of `src/components/*.tsx` and of nothing else. `src/pages`,
 * `src/pages/valuation` and `src/components/valuation` were outside it — 100-odd
 * files, including every panel in the workbench. No dialog lives there today,
 * so this widening changes no answer; it removes the place a dialog could be
 * added tomorrow and be guarded by nothing.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

interface DialogSource {
  file: string;
  source: string;
  scrim: boolean;
  modal: boolean;
  traps: boolean;
}

function dialogSources(): DialogSource[] {
  return tsxFiles(srcDir)
    .map((full) => {
      const source = readFileSync(full, 'utf8');
      return {
        file: path.relative(srcDir, full),
        source,
        scrim: source.includes('fixed inset-0'),
        // The attribute, not the word: the files below discuss `aria-modal`
        // in prose precisely because they had to stop asserting it.
        modal: source.includes('aria-modal="'),
        // The declaration in `ui.tsx` is not a call site; strip it first, or
        // the file that defines the trap reports itself as trapping forever.
        traps: source.replace(/export function useFocusTrap[\s\S]*?\n}/, '').includes('useFocusTrap<'),
      };
    })
    .filter(({ source }) => source.includes('role="dialog"'));
}

describe('only a dialog that covers the page may say the page is gone', () => {
  it('finds the dialogs it is meant to be guarding', () => {
    expect(
      dialogSources()
        .map((d) => d.file)
        .sort(),
    ).toEqual([
      'components/CommandPalette.tsx',
      'components/CookieConsent.tsx',
      'components/HelpIcon.tsx',
      'components/HelpWidget.tsx',
      'components/ui.tsx',
    ]);
  });

  it('has no scrimless dialog claiming aria-modal', () => {
    const overclaiming = dialogSources()
      .filter((d) => d.modal && !d.scrim)
      .map((d) => d.file);
    expect(overclaiming).toEqual([]);
  });

  it('has no scrimless dialog trapping the keyboard either', () => {
    /*
     * The trap is the same claim in the other modality. A panel that leaves
     * `aria-modal` off but still cycles Tab within itself has only moved the
     * harm from screen-reader users to keyboard users.
     */
    const trapping = dialogSources()
      .filter((d) => d.traps && !d.scrim)
      .map((d) => d.file);
    expect(trapping).toEqual([]);
  });

  it('has no dialog claiming aria-modal that lets the keyboard walk out', () => {
    /*
     * The fourth quadrant, and the one the census was missing.
     *
     * The other three all run from the scrim: an overlay that covers the page
     * must claim `aria-modal`, and one that does not must claim neither it nor
     * a Tab trap. None of them asks anything of a dialog that covers the page
     * and *does* claim it — so `aria-modal="true"` with no trap passed every
     * check here. That is the ordinary shape of the bug: the attribute is one
     * line and remembering it is easy, while the trap is a hook you have to
     * know exists.
     *
     * It is also the worst way round. `aria-modal` tells a screen reader to
     * drop the rest of the document from its buffer, so the content behind is
     * gone for the user who cannot see it — while Tab still walks a sighted
     * keyboard user straight out into controls that are now, by the dialog's
     * own claim, not there. The three dialogs that claim it all trap today;
     * this is what keeps the fourth from shipping without it.
     */
    const untrapped = dialogSources()
      .filter((d) => d.modal && !d.traps)
      .map((d) => d.file);
    expect(untrapped).toEqual([]);
  });

  it('has no scrim overlay that forgot to claim it', () => {
    // The converse: an overlay that does cover the page must say so, or a
    // screen reader keeps offering content the user cannot reach.
    const silent = dialogSources()
      .filter((d) => d.scrim && !d.modal)
      .map((d) => d.file);
    expect(silent).toEqual([]);
  });
});
