import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationsPage } from '../src/pages/NotificationsPage';
import type { AppNotification } from '../src/lib/types';

/** In-app notification centre (M4). */

const unread: AppNotification = {
  id: '01N409NOTE00000000000000AA',
  valuation_id: '01N409VAL00000000000000AAA',
  link: null,
  type: 'review_requested',
  title: 'Acme is ready for review',
  body: 'The engine finished the 409A calculation.',
  read_at: null,
  created_at: '2026-07-01T09:00:00Z',
};

const read: AppNotification = {
  id: '01N409NOTE00000000000000BB',
  valuation_id: null,
  link: null,
  type: 'welcome',
  title: 'Welcome to N409',
  body: null,
  read_at: '2026-07-01T10:00:00Z',
  created_at: '2026-06-30T09:00:00Z',
};

/**
 * The accessible names the row controls carry. Both name their notification —
 * a screenful of "Mark read" buttons is a control list with nothing in it to
 * choose between.
 */
const markReadName = `Mark “${unread.title}” as read`;
const openName = `Open the page for “${unread.title}”`;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
}

/**
 * Serves a mutable list so the reload after a write is observable — the point of
 * the write is that the next GET disagrees with the last one.
 */
function mockApi(initial: AppNotification[], opts: { writeFails?: boolean } = {}) {
  const calls: Call[] = [];
  let items = initial;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method });
    if (method === 'POST') {
      if (opts.writeFails) return jsonResponse({ status: 500, detail: 'nope' }, 500);
      if (path.endsWith('/read-all')) {
        items = items.map((n) => ({ ...n, read_at: n.read_at ?? '2026-07-02T00:00:00Z' }));
      } else {
        const id = path.split('/').at(-2);
        items = items.map((n) => (n.id === id ? { ...n, read_at: '2026-07-02T00:00:00Z' } : n));
      }
      return jsonResponse({ ok: true });
    }
    return jsonResponse({
      notifications: items,
      unread_count: items.filter((n) => n.read_at === null).length,
    });
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <NotificationsPage />
    </MemoryRouter>,
  );

describe('NotificationsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('announces the load before the list arrives', async () => {
    mockApi([unread]);
    renderPage();
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toContain('Loading notifications…');
    await screen.findByText(unread.title);
  });

  it('lists notifications with the unread count in the heading', async () => {
    mockApi([unread, read]);
    renderPage();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('(1 unread)');
    expect(screen.getByText(unread.title)).toBeInTheDocument();
    expect(screen.getByText(unread.body!)).toBeInTheDocument();
    expect(screen.getByText(read.title)).toBeInTheDocument();
  });

  it('offers per-row and bulk mark-read only for what is actually unread', async () => {
    mockApi([unread, read]);
    renderPage();

    await screen.findByText(unread.title);
    // One unread row → exactly one "Mark read" button, plus the bulk action.
    expect(screen.getAllByRole('button', { name: /as read$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });

  it('marks a single notification read and refreshes the count', async () => {
    const calls = mockApi([unread, read]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: markReadName }));

    await waitFor(() => expect(screen.queryByText(/unread/)).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/notifications/${unread.id}/read`))).toBe(
      true,
    );
    // Nothing unread left → the bulk action retires itself.
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('marks a notification read on its way to the valuation it points at', async () => {
    const calls = mockApi([unread, read]);
    const user = userEvent.setup();
    renderPage();

    const link = await screen.findByRole('link', { name: openName });
    expect(link).toHaveAttribute('href', `/valuations/${unread.valuation_id}`);
    await user.click(link);

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.includes(unread.id))).toBe(true),
    );
  });

  it('offers no link on a notification with no valuation attached', async () => {
    mockApi([read]);
    renderPage();
    await screen.findByText(read.title);
    expect(screen.queryByRole('link', { name: /^Open the page/ })).not.toBeInTheDocument();
  });

  it('clears everything with mark-all-read', async () => {
    const calls = mockApi([unread, { ...read, read_at: null, id: '01N409NOTE00000000000000CC' }]);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('(2 unread)');
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(screen.queryByText(/unread/)).not.toBeInTheDocument());
    expect(calls.some((c) => c.url.endsWith('/notifications/read-all'))).toBe(true);
  });

  it('leaves the row unread and stays quiet when a single mark-read fails', async () => {
    mockApi([unread], { writeFails: true });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: markReadName }));

    // Non-fatal by design: no alert, and the row is still actionable.
    await waitFor(() => expect(screen.getByRole('button', { name: markReadName })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a failed mark-all-read, which the user asked for explicitly', async () => {
    mockApi([unread], { writeFails: true });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not mark notifications as read.');
  });

  it('invites the reader in rather than showing an empty list', async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load notifications.');
    // The skeleton must give way to the error, not sit underneath it.
    expect(screen.queryByText('Loading notifications…')).not.toBeInTheDocument();
  });

  // ── What the list said to somebody not looking at it (R117) ───────────────

  it('says which rows are unread in words, not only in colour', () => {
    // Read/unread was a tinted border, a tinted background and a 8px dot with
    // no text in it. The dot is decorative and the word is the row's.
    mockApi([unread, read]);
    renderPage();

    return waitFor(() => {
      const unreadRow = screen.getByText(unread.title).closest('li')!;
      const readRow = screen.getByText(read.title).closest('li')!;
      expect(unreadRow).toHaveTextContent('Unread.');
      expect(readRow).not.toHaveTextContent('Unread.');
    });
  });

  it('names each row control after the notification it acts on', async () => {
    // Two unread rows: the names have to tell them apart, which "Mark read"
    // repeated twice cannot.
    const second = { ...unread, id: '01N409NOTE00000000000000DD', title: 'Globex needs figures' };
    mockApi([unread, second]);
    renderPage();

    expect(await screen.findByRole('button', { name: markReadName })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Mark “${second.title}” as read` })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: openName })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Open the page for “${second.title}”` })).toBeInTheDocument();
  });

  it('keeps the reader in the list when the button they pressed removes itself', async () => {
    // "Mark read" only renders while the row is unread, so pressing it unmounts
    // the focused element. Focus fell to <body>, and the next Tab restarted at
    // the top of the document — once per row marked off.
    const second = { ...unread, id: '01N409NOTE00000000000000DD', title: 'Globex needs figures' };
    const user = userEvent.setup();
    mockApi([unread, second]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: markReadName }));

    await waitFor(() => expect(screen.queryByRole('button', { name: markReadName })).not.toBeInTheDocument());
    const row = screen.getByText(unread.title).closest('li')!;
    expect(document.activeElement).toBe(row);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('moves focus to the heading when the bulk action retires itself', async () => {
    const user = userEvent.setup();
    mockApi([unread]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('speaks the outcome of a write, which moving focus alone does not', async () => {
    const user = userEvent.setup();
    mockApi([unread]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: markReadName }));
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((el) => el.textContent)).toContain('Marked as read.'),
    );
  });

  it('speaks the outcome of the bulk write too', async () => {
    const user = userEvent.setup();
    mockApi([unread]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((el) => el.textContent)).toContain(
        'All notifications marked as read.',
      ),
    );
  });

  /**
   * The account-scoped half of the table (R218).
   *
   * `valuation_id` was the only destination a row could name, so a declined
   * renewal arrived as "Update your card from the billing page" with nothing
   * to click, beside an email that carried the link. `link` is the general
   * answer and outranks the valuation path.
   */
  it('opens a linked notification that belongs to no engagement', async () => {
    const billing: AppNotification = {
      ...read,
      id: '01N409NOTE00000000000000EE',
      link: '/billing',
      read_at: null,
      title: 'Your subscription payment did not go through',
    };
    mockApi([billing]);
    renderPage();

    const link = await screen.findByRole('link', { name: `Open the page for “${billing.title}”` });
    expect(link).toHaveAttribute('href', '/billing');
  });

  it('prefers the stored link over the engagement it also names', async () => {
    mockApi([{ ...unread, link: '/billing' }]);
    renderPage();
    expect(await screen.findByRole('link', { name: openName })).toHaveAttribute('href', '/billing');
  });

  /**
   * The server refuses a non-path at the write and a CHECK constraint refuses
   * it at the column, and this is still checked here — because this is the
   * place the value becomes a navigation. React Router hands `//host` to the
   * browser as a protocol-relative URL, and a reader who leaves the
   * application from a link inside their own inbox cannot tell it was not ours.
   */
  it('will not follow a stored link that is not an app path', async () => {
    mockApi([{ ...read, id: '01N409NOTE00000000000000FF', link: '//evil.example/take-over' }]);
    renderPage();
    await screen.findByText(read.title);
    expect(screen.queryByRole('link', { name: /^Open the page/ })).not.toBeInTheDocument();
  });

  it('mounts the outcome region before the write, not with the message in it', async () => {
    // A live region inserted into the DOM already holding its text is commonly
    // not announced at all; it has to be observed empty first.
    mockApi([unread]);
    renderPage();
    await screen.findByText(unread.title);
    expect(screen.getAllByRole('status').some((el) => el.textContent === '')).toBe(true);
  });
});
