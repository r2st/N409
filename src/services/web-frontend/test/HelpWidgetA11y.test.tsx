import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpWidget } from '../src/components/HelpWidget';

afterEach(() => vi.restoreAllMocks());

function renderWidget() {
  // The topics fetch is best-effort; stub it so the effect resolves quietly.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ articles: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return render(
    <MemoryRouter>
      <HelpWidget />
    </MemoryRouter>,
  );
}

describe('HelpWidget accessibility (F-3 P2)', () => {
  it('opens a dialog and closes it on Escape, restoring focus', async () => {
    const user = userEvent.setup();
    renderWidget();

    const launcher = screen.getByRole('button', { name: 'Open help' });
    await user.click(launcher);

    const dialog = await screen.findByRole('dialog', { name: 'Help & support' });
    /*
     * Not modal, and deliberately so — the panel paints no scrim, so the form
     * behind it stays live for the mouse and must stay readable for everyone
     * else. `OverlayModality.test.tsx` owns that rule; this one only records
     * that the dialog itself is announced and dismissible.
     */
    expect(dialog).toHaveAttribute('role', 'dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus returns to the launcher after close.
    expect(screen.getByRole('button', { name: 'Open help' })).toHaveFocus();
  });
});
