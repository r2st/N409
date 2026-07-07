import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RichTextEditor } from '../src/components/RichTextEditor';
import { sanitizeHtml } from '../src/lib/m2';

/** Gap 9 — links + tables in the report editor. */

describe('sanitizeHtml (client mirror) link support', () => {
  it('keeps validated hrefs and strips unsafe ones', () => {
    expect(sanitizeHtml('<a href="https://ex.com" onclick="e()">x</a>')).toBe(
      '<a href="https://ex.com">x</a>',
    );
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
  });
});

describe('RichTextEditor toolbar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom has no execCommand — the toolbar calls it, so stub it.
    document.execCommand = vi.fn().mockReturnValue(true);
  });

  it('offers link, unlink, and table tools', () => {
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);
    expect(screen.getByTitle('Insert link')).toBeInTheDocument();
    expect(screen.getByTitle('Remove link')).toBeInTheDocument();
    expect(screen.getByTitle('Insert table')).toBeInTheDocument();
  });

  it('prompts for a URL and creates a link with a scheme', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('ex.com/data-room');
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);

    await user.click(screen.getByTitle('Insert link'));
    expect(document.execCommand).toHaveBeenCalledWith(
      'createLink',
      false,
      'https://ex.com/data-room',
    );
  });

  it('does nothing when the prompt is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);
    await user.click(screen.getByTitle('Insert link'));
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('inserts a starter table', async () => {
    const user = userEvent.setup();
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);
    await user.click(screen.getByTitle('Insert table'));
    const call = vi.mocked(document.execCommand).mock.calls.find((c) => c[0] === 'insertHTML');
    expect(call).toBeTruthy();
    expect(String(call![2])).toContain('<table>');
    expect(String(call![2])).toContain('<th>Column 1</th>');
  });
});
