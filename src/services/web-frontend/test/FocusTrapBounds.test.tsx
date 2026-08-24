import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button, Modal, Select, TextInput } from '../src/components/ui';

/**
 * Two ways the shared focus trap let go of focus, both reachable from ordinary
 * use of the dialogs already in the app.
 *
 * The trap is `useFocusTrap`, and every dialog in the product runs on it —
 * `Modal` (the convert-to-engagement and intake-detail dialogs, the save-view
 * dialog), the help slide-over, the help widget, the cookie gate. So both of
 * these were one bug in five places.
 *
 * The harnesses below are deliberately built the way the real callers are:
 * an inline `onClose` arrow, and dialog-owned state that changes as the user
 * works. That is the shape that broke it.
 */

/** Mirrors IntakeLinksPanel's "Convert to an engagement": two controls, and a
 *  parent that re-renders on every keystroke because the draft lives above. */
function ConvertDialog() {
  const [draft, setDraft] = useState<{ name: string; kind: string } | null>(null);
  return (
    <div>
      <button onClick={() => setDraft({ name: 'Acme Robotics', kind: '409a' })}>Convert</button>
      <a href="/behind">A link on the page behind</a>
      {/* Inline arrow, exactly as the three real call sites write it. */}
      <Modal open={draft !== null} onClose={() => setDraft(null)} title="Convert to an engagement">
        {draft && (
          <div>
            <TextInput
              aria-label="Company name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Select
              aria-label="Valuation type"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              <option value="409a">409A</option>
              <option value="asc718">ASC 718</option>
            </Select>
            <Button onClick={() => {}}>Create engagement</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

const openConvert = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<ConvertDialog />);
  await user.click(screen.getByRole('button', { name: 'Convert' }));
};

describe('a dialog that owns state does not take focus off the control being used', () => {
  /**
   * The trap depended on the `onEscape` callback it was handed. Every caller
   * passes an inline arrow, so the identity changed on every render, so the
   * effect tore down and re-installed on every render — and re-installing
   * means "focus the first control in the dialog". Changing the valuation type
   * therefore dropped the user into the company-name box.
   */
  it('leaves focus on the select after the selection changes', async () => {
    const user = userEvent.setup();
    await openConvert(user);

    const kind = screen.getByLabelText('Valuation type');
    await user.selectOptions(kind, 'asc718');

    expect(kind).toHaveValue('asc718');
    expect(kind).toHaveFocus();
  });

  /**
   * The same tear-down through the text box. Re-installing the trap calls
   * `.focus()` on the input, which in a browser drops the caret to the end of
   * the value — so a correction typed into the middle of a company name walked
   * to the end of it, one character at a time.
   */
  it('leaves the caret where the user put it while typing', async () => {
    const user = userEvent.setup();
    await openConvert(user);

    const name = screen.getByLabelText('Company name') as HTMLInputElement;
    await user.click(name);
    name.setSelectionRange(0, 0);
    await user.keyboard('The ');

    expect(name).toHaveValue('The Acme Robotics');
    expect(name).toHaveFocus();
    expect(name.selectionStart).toBe(4);
  });

  it('still closes on Escape after the dialog state has changed', async () => {
    const user = userEvent.setup();
    await openConvert(user);

    // The fix reads the handler through a ref; this asserts the ref is kept
    // current rather than frozen at the identity captured on open.
    await user.selectOptions(screen.getByLabelText('Valuation type'), 'asc718');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert' })).toHaveFocus();
  });
});

describe('Tab returns to the dialog from wherever focus has ended up', () => {
  /**
   * A browser drops focus to `<body>` whenever the focused element stops being
   * focusable underneath it — a submit button that disables itself while the
   * request is in flight is the everyday case, and both `Modal` dialogs in
   * IntakeLinksPanel have one. From `<body>`, Tab walked into the page behind
   * the overlay: the trap only ever intercepted Tab when focus was already on
   * its own first or last control.
   */
  it('does not hand the next Tab to the page behind it', async () => {
    const user = userEvent.setup();
    await openConvert(user);

    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();

    await user.tab();

    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('link', { name: 'A link on the page behind' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Convert' })).not.toHaveFocus();
  });

  it('enters at the last control when it is Shift+Tab that finds focus adrift', async () => {
    const user = userEvent.setup();
    await openConvert(user);

    (document.activeElement as HTMLElement).blur();
    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Create engagement' })).toHaveFocus();
  });

  it('still cycles first→last→first once focus is inside', async () => {
    const user = userEvent.setup();
    await openConvert(user);

    expect(screen.getByLabelText('Company name')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Valuation type')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Create engagement' })).toHaveFocus();
    // Off the end wraps to the start rather than leaving for the page behind.
    await user.tab();
    expect(screen.getByLabelText('Company name')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Create engagement' })).toHaveFocus();
  });
});

/**
 * A dialog whose highlight is `aria-activedescendant` rather than DOM focus —
 * the command palette's shape, and any listbox built the same way. The rows are
 * `<button tabindex="-1">`: reachable by pointer and by code, never a Tab stop,
 * because real focus has to stay in the box for the highlight to be announced.
 * They are also the *last* thing in the dialog, which is what makes the trap
 * the only thing standing between Tab and the page behind.
 */
function ListboxDialog() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open</button>
      <a href="/behind">A link on the page behind</a>
      <Modal open={open} onClose={() => setOpen(false)} title="Pick a valuation">
        <TextInput aria-label="Search" />
        <div>
          <button type="button" tabIndex={-1}>
            Northwind Robotics
          </button>
          <button type="button" tabIndex={-1}>
            Acme Holdings
          </button>
        </div>
      </Modal>
    </div>
  );
}

describe('the trap honours tabindex="-1" on every kind of control', () => {
  /**
   * `:not([tabindex="-1"])` used to sit on the `[tabindex]` clause alone, so
   * the intent was stated but enforced only for elements that had no other
   * reason to be focusable. A `<button>` matched `button:not([disabled])` and
   * counted as a Tab stop whatever its tabindex said — which is backwards,
   * since `tabindex="-1"` exists precisely to say "not a Tab stop".
   *
   * The damage is not that Tab visits a row. It is that the trap then believes
   * its last Tab stop is a row, so when focus is on the real last control it
   * declines to wrap — and Tab leaves for the page behind the overlay.
   */
  it('wraps at the last real control instead of leaking to the page behind', async () => {
    const user = userEvent.setup();
    render(<ListboxDialog />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByLabelText('Search')).toHaveFocus();
    await user.tab();

    expect(screen.getByLabelText('Search')).toHaveFocus();
    expect(screen.getByRole('link', { name: 'A link on the page behind' })).not.toHaveFocus();
  });

  it('does not enter the dialog on a row that opted out', async () => {
    const user = userEvent.setup();
    render(<ListboxDialog />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    (document.activeElement as HTMLElement).blur();
    // Shift+Tab from adrift enters at the last Tab stop. A row is not one.
    await user.tab({ shift: true });

    expect(screen.getByLabelText('Search')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Acme Holdings' })).not.toHaveFocus();
  });
});
