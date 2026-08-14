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
    expect(document.execCommand).toHaveBeenCalledWith('createLink', false, 'https://ex.com/data-room');
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

/**
 * The formatting tools and the typing surface — everything the toolbar does
 * besides links and tables.
 */
describe('RichTextEditor formatting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.execCommand = vi.fn().mockReturnValue(true);
  });

  it.each([
    ['Bold', 'bold', undefined],
    ['Italic', 'italic', undefined],
    ['Underline', 'underline', undefined],
    ['Section heading', 'formatBlock', 'h2'],
    ['Sub-heading', 'formatBlock', 'h3'],
    ['Paragraph', 'formatBlock', 'p'],
    ['Bulleted list', 'insertUnorderedList', undefined],
    ['Numbered list', 'insertOrderedList', undefined],
    ['Remove link', 'unlink', undefined],
  ])('%s runs the %s command', async (title, command, arg) => {
    const user = userEvent.setup();
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);

    await user.click(screen.getByTitle(title));

    expect(document.execCommand).toHaveBeenCalledWith(command, false, arg);
  });

  /**
   * The toolbar acts on the selection in the editor, and a button that took
   * focus on mousedown would collapse that selection before the click ever
   * ran — bold would apply to nothing.
   */
  it('does not steal the selection when a tool is pressed', async () => {
    const user = userEvent.setup();
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);

    const bold = screen.getByTitle('Bold');
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bold.dispatchEvent(mousedown);

    expect(mousedown.defaultPrevented).toBe(true);
    // And the editor is what ends up focused when the command runs.
    await user.click(bold);
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('reports the edited HTML, sanitized, as it is typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RichTextEditor value="" onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'Fair value');

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.lastCall![0]).toContain('Fair value');
  });

  it('strips what the whitelist rejects out of a paste', async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="" onChange={onChange} />);
    const box = screen.getByRole('textbox');

    box.innerHTML = '<p>Kept</p><script>steal()</script>';
    box.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(expect.not.stringContaining('<script>'));
    expect(onChange.mock.lastCall![0]).toContain('Kept');
  });

  /** The value arrives sanitized, so a stored `<script>` never reaches the DOM. */
  it('sanitizes the value it is handed', () => {
    render(<RichTextEditor value="<p>Body</p><script>x()</script>" onChange={() => {}} />);

    const box = screen.getByRole('textbox');
    expect(box.innerHTML).toContain('Body');
    expect(box.innerHTML).not.toContain('<script>');
  });

  it('is not editable and offers no working tools while disabled', () => {
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} disabled />);

    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByTitle('Bold')).toBeDisabled();
    expect(screen.getByTitle('Insert link')).toBeDisabled();
    expect(screen.getByTitle('Insert table')).toBeDisabled();
  });
});

describe('RichTextEditor link URLs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.execCommand = vi.fn().mockReturnValue(true);
  });

  const linked = async (typed: string) => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(typed);
    render(<RichTextEditor value="<p>hi</p>" onChange={() => {}} />);
    await user.click(screen.getByTitle('Insert link'));
    return vi.mocked(document.execCommand).mock.calls.find((c) => c[0] === 'createLink')?.[2];
  };

  it('leaves a URL that already carries a scheme alone', async () => {
    expect(await linked('https://ex.com/a')).toBe('https://ex.com/a');
  });

  it('keeps a mailto: address as one', async () => {
    expect(await linked('mailto:analyst@ex.com')).toBe('mailto:analyst@ex.com');
  });

  it('recognises a scheme whatever its case', async () => {
    expect(await linked('HTTPS://ex.com')).toBe('HTTPS://ex.com');
  });

  /**
   * A pasted URL routinely arrives with a trailing space. Untrimmed it matched
   * no scheme, so it was prefixed *and* kept its padding — `https://ex.com%20`,
   * a link to the wrong place.
   */
  it('trims a padded URL rather than building the padding into the href', async () => {
    expect(await linked('  ex.com/data-room  ')).toBe('https://ex.com/data-room');
  });

  it('trims padding off a URL that already has a scheme too', async () => {
    expect(await linked('  https://ex.com  ')).toBe('https://ex.com');
  });

  /** Answering the prompt with nothing but spaces is answering it with nothing. */
  it('creates no link from a blank answer', async () => {
    expect(await linked('   ')).toBeUndefined();
    expect(document.execCommand).not.toHaveBeenCalled();
  });
});
