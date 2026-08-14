import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HelpWidget, HELP_TOPICS, filterTopics, htmlToText } from '../src/components/HelpWidget';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderWidget(path = '/valuations') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HelpWidget />
    </MemoryRouter>,
  );
}

describe('filterTopics', () => {
  it('returns everything for an empty query', () => {
    expect(filterTopics(HELP_TOPICS, '')).toHaveLength(HELP_TOPICS.length);
  });

  it('matches title, keywords and body case-insensitively', () => {
    expect(filterTopics(HELP_TOPICS, 'DLOM').map((t) => t.id)).toContain('params');
    expect(filterTopics(HELP_TOPICS, 'upload').map((t) => t.id)).toContain('documents');
    expect(filterTopics(HELP_TOPICS, 'zzz-no-match')).toHaveLength(0);
  });
});

describe('HelpWidget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens from the launcher, searches topics, expands one', async () => {
    const user = userEvent.setup();
    renderWidget();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Open help'));
    expect(screen.getByRole('dialog', { name: 'Help & support' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search help topics…'), 'report');
    expect(screen.getByText('Reports and versions')).toBeInTheDocument();
    expect(screen.queryByText('Uploading documents')).not.toBeInTheDocument();

    await user.click(screen.getByText('Reports and versions'));
    expect(screen.getByText(/immutable version history/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));
    await user.type(screen.getByPlaceholderText('Search help topics…'), 'quaternions');
    expect(screen.getByText(/No topics match/)).toBeInTheDocument();
  });

  it('sends a support message with the current page path', async () => {
    const user = userEvent.setup();
    // Fresh Response per call — the widget also fetches /help/articles on
    // mount (P2 #10) and a Response body is single-read.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ message: { id: 'm1', status: 'open' } }, 201)),
      );
    renderWidget('/valuations/01ABC/documents');

    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));

    const send = screen.getByRole('button', { name: 'Send to support' });
    expect(send).toBeDisabled(); // empty form can't submit

    await user.type(screen.getByPlaceholderText('What do you need help with?'), 'Upload fails');
    await user.type(screen.getByPlaceholderText(/Tell us what happened/), 'The cap table upload errors out.');
    await user.click(send);

    await waitFor(() => expect(screen.getByText("Thanks — we're on it.")).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/support/messages',
      expect.objectContaining({ method: 'POST' }),
    );
    const postCall = fetchSpy.mock.calls.find(([url]) => url === '/api/v1/support/messages');
    const body = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(body).toEqual({
      subject: 'Upload fails',
      body: 'The cap table upload errors out.',
      page_path: '/valuations/01ABC/documents',
    });
  });

  it('surfaces API failures in the form', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse({ title: 'Unprocessable', detail: 'Message too long' }, 422)),
    );
    renderWidget();

    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));
    await user.type(screen.getByPlaceholderText('What do you need help with?'), 'Hi');
    await user.type(screen.getByPlaceholderText(/Tell us what happened/), 'Help me');
    await user.click(screen.getByRole('button', { name: 'Send to support' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Message too long');
  });
});

/**
 * The digest shown under each topic in the widget, built from the article HTML
 * the knowledge base returns.
 */
describe('htmlToText', () => {
  it('strips markup and collapses the whitespace it leaves behind', () => {
    expect(htmlToText('<h2>Title</h2>\n<p>Body   text.</p>')).toBe('Title Body text.');
  });

  it('decodes the entities an article is written with', () => {
    expect(htmlToText('<p>Black &amp; Scholes said &quot;it&#39;s fine&quot;</p>')).toBe(
      'Black & Scholes said "it\'s fine"',
    );
  });

  /**
   * An escaped tag is text the author wanted shown, not markup — and it must
   * not be decoded before the tag strip runs, or the strip would eat it.
   */
  it('keeps an escaped tag as the text it was written as', () => {
    expect(htmlToText('<p>Use &lt;section&gt; here</p>')).toBe('Use <section> here');
  });

  /**
   * The article that documents how to escape a tag writes `&amp;lt;` to put
   * "&lt;" on the page. Decoding `&amp;` first turned that into `&lt;`, which
   * the next rule decoded again into "<" — so the one article whose subject is
   * entities was the one whose digest came out wrong.
   */
  it('does not decode an escaped entity twice', () => {
    expect(htmlToText('<p>Write &amp;lt;div&amp;gt; to show a tag</p>')).toBe(
      'Write &lt;div&gt; to show a tag',
    );
    expect(htmlToText('<p>&amp;amp; is an ampersand</p>')).toBe('&amp; is an ampersand');
  });
});

/**
 * Leaving the widget — by the close button, by following a link out of it, and
 * by coming back from the contact form.
 */
describe('HelpWidget — closing and coming back', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** The launcher carries the same label when open, so scope to the panel. */
  const closeButton = () => within(screen.getByRole('dialog')).getByLabelText('Close help');

  it('closes from the panel’s own close button', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));

    await user.click(closeButton());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([['Read the full article →'], ['View all articles →']])(
    'gets out of the way when %s is followed',
    async (linkName) => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({
          articles: [
            {
              id: 'a1',
              slug: 'dlom',
              title: 'Marketability discounts',
              keywords: 'dlom',
              body_html: '<p>How the DLOM is set.</p>',
              published: true,
            },
          ],
        }),
      );
      renderWidget();
      await user.click(screen.getByLabelText('Open help'));
      await user.click(await screen.findByText('Marketability discounts'));

      await user.click(screen.getByRole('link', { name: linkName }));

      // A panel still hanging over the article the reader just asked for is
      // the thing standing between them and it.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('goes back to the topics from the contact form', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));

    await user.click(screen.getByRole('button', { name: '← Back to help topics' }));
    expect(screen.getByPlaceholderText('Search help topics…')).toBeInTheDocument();
  });

  /**
   * Closing unmounts `ContactForm` and its draft goes with it, so the view has
   * to go back too. It did not: reopening landed on an emptied contact form,
   * which reads to the analyst who closed the panel mid-message as their draft
   * having been silently thrown away — with no offer of the help they had just
   * asked for.
   */
  it('reopens on the help topics after being closed mid-message', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));
    await user.type(screen.getByPlaceholderText('What do you need help with?'), 'Upload fails');

    await user.click(closeButton());
    await user.click(screen.getByLabelText('Open help'));

    expect(screen.getByPlaceholderText('Search help topics…')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('What do you need help with?')).not.toBeInTheDocument();
  });

  /** And the confirmation does not outlive the session it belonged to. */
  it('does not greet the next visit with the last message’s confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse({ message: { id: 'm1', status: 'open' } }, 201)),
    );
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));
    await user.type(screen.getByPlaceholderText('What do you need help with?'), 'Upload fails');
    await user.type(screen.getByPlaceholderText(/Tell us what happened/), 'It errors out.');
    await user.click(screen.getByRole('button', { name: 'Send to support' }));
    await screen.findByText("Thanks — we're on it.");

    await user.click(closeButton());
    await user.click(screen.getByLabelText('Open help'));

    expect(screen.queryByText("Thanks — we're on it.")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search help topics…')).toBeInTheDocument();
  });

  /** The launcher toggle is the same close, so it resets the view too. */
  it('resets the view when the launcher is used to close it', async () => {
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByLabelText('Open help'));
    await user.click(screen.getByRole('button', { name: 'Contact support' }));

    // While the panel is open its own close button carries the same label, so
    // the launcher is the one that is not inside the dialog.
    const dialog = screen.getByRole('dialog');
    const launcher = screen.getAllByLabelText('Close help').find((el) => !dialog.contains(el))!;
    await user.click(launcher);
    await user.click(screen.getByLabelText('Open help'));

    expect(screen.getByPlaceholderText('Search help topics…')).toBeInTheDocument();
  });
});
