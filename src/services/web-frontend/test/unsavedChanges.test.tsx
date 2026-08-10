import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useUnsavedChanges } from '../src/lib/unsavedChanges';

/**
 * The guard between an analyst mid-edit and a click that throws the edit away.
 *
 * It was the only module in `src/lib` with no test at all, which is the wrong
 * one to leave uncovered: every branch in it is a decision about whether to
 * interrupt somebody, and both mistakes are silent. Interrupt too eagerly and
 * the app confirms on a middle-click, an in-page anchor, a download link — and
 * people learn to click through the dialog. Interrupt too rarely and the case
 * it exists for, clicking another workspace tab with a half-written report on
 * screen, loses the work with no warning at all.
 *
 * So the assertions are mostly about the *cases it must not fire on*. There is
 * no way to observe those from the feature itself; they only show up here.
 */

function Editor({ dirty, message = 'Discard unsaved changes?' }: { dirty: boolean; message?: string }) {
  useUnsavedChanges(dirty, message);
  return (
    <div>
      <a href="/other">plain link</a>
      <a href="#section">in-page anchor</a>
      <a href="/report.pdf" download>
        download
      </a>
      <a href="/new-tab" target="_blank" rel="noreferrer">
        new tab
      </a>
      <a href="https://example.com/away">other origin</a>
      <a href="/current">same page</a>
      <button type="button">not a link</button>
    </div>
  );
}

/** Whether the click reached the document — i.e. the navigation was allowed. */
function watchClicks() {
  const seen: string[] = [];
  const handler = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.('a');
    if (a) seen.push(a.getAttribute('href') ?? '');
  };
  // Bubble phase, so the hook's capture-phase `stopPropagation` prevents it.
  document.addEventListener('click', handler);
  return {
    seen,
    stop: () => document.removeEventListener('click', handler),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useUnsavedChanges', () => {
  it('does nothing at all while the form is clean', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const watch = watchClicks();
    render(<Editor dirty={false} />);

    await userEvent.click(screen.getByText('plain link'));
    expect(confirm).not.toHaveBeenCalled();
    expect(watch.seen).toEqual(['/other']);
    watch.stop();
  });

  it('confirms before an in-app navigation once the form is dirty, and blocks on cancel', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const watch = watchClicks();
    render(<Editor dirty message="Leave without saving?" />);

    await userEvent.click(screen.getByText('plain link'));
    expect(confirm).toHaveBeenCalledWith('Leave without saving?');
    // stopPropagation in the capture phase — the click never reaches the app.
    expect(watch.seen).toEqual([]);
    watch.stop();
  });

  it('lets the navigation through when the analyst confirms', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const watch = watchClicks();
    render(<Editor dirty />);

    await userEvent.click(screen.getByText('plain link'));
    expect(watch.seen).toEqual(['/other']);
    watch.stop();
  });

  it.each([
    ['in-page anchor', 'in-page anchor'],
    ['download', 'download'],
    ['new tab', 'new tab'],
    ['other origin', 'other origin'],
  ])('does not confirm on a %s — this document stays put', async (_label, text) => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<Editor dirty />);

    await userEvent.click(screen.getByText(text));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not confirm on a click that is not a link', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<Editor dirty />);

    await userEvent.click(screen.getByText('not a link'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not confirm on a modified or middle click, which opens somewhere else', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<Editor dirty />);
    const link = screen.getByText('plain link');

    // fireEvent rather than userEvent: the modifier flags are the whole point
    // of the case, and they have to be set on the click event itself.
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      fireEvent.click(link, init);
    }
    expect(confirm).not.toHaveBeenCalled();

    // The unmodified click through the same path still does confirm, so the
    // check above is not passing because fireEvent misses the listener.
    fireEvent.click(link);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('does not confirm on a click something else already handled', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<Editor dirty />);
    const link = screen.getByText('plain link');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    event.preventDefault();
    link.dispatchEvent(event);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not confirm when the href resolves to the page already shown', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    // jsdom's default location is http://localhost/; point the link at it.
    render(
      <div>
        <SelfLink />
      </div>,
    );
    await userEvent.click(screen.getByText('same page'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('arms beforeunload while dirty and disarms it when the form is saved', async () => {
    const { rerender, unmount } = render(<Editor dirty />);

    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(e);
      return e;
    };

    // preventDefault() is what arms the browser's own dialog; the string is
    // ignored by every modern engine, which is why this asserts the flag.
    expect(fire().defaultPrevented).toBe(true);

    rerender(<Editor dirty={false} />);
    expect(fire().defaultPrevented).toBe(false);

    rerender(<Editor dirty />);
    expect(fire().defaultPrevented).toBe(true);
    // …and the listener is removed on unmount, not left on window for the next
    // screen to inherit.
    unmount();
    expect(fire().defaultPrevented).toBe(false);
  });

  it('stops intercepting clicks once unmounted', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { unmount } = render(<Editor dirty />);
    const link = screen.getByText('plain link');
    link.remove();
    unmount();

    document.body.append(link);
    await userEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
    link.remove();
  });
});

/** A link whose href is the current URL, built at render so jsdom agrees. */
function SelfLink() {
  useUnsavedChanges(true, 'Discard?');
  return <a href={window.location.pathname + window.location.search}>same page</a>;
}
