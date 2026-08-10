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
  type: 'review_requested',
  title: 'Acme is ready for review',
  body: 'The engine finished the 409A calculation.',
  read_at: null,
  created_at: '2026-07-01T09:00:00Z',
};

const read: AppNotification = {
  id: '01N409NOTE00000000000000BB',
  valuation_id: null,
  type: 'welcome',
  title: 'Welcome to N409',
  body: null,
  read_at: '2026-07-01T10:00:00Z',
  created_at: '2026-06-30T09:00:00Z',
};

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
    expect(screen.getByRole('status')).toHaveTextContent('Loading notifications…');
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
    expect(screen.getAllByRole('button', { name: 'Mark read' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });

  it('marks a single notification read and refreshes the count', async () => {
    const calls = mockApi([unread, read]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Mark read' }));

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

    const link = await screen.findByRole('link', { name: 'Open →' });
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
    expect(screen.queryByRole('link', { name: 'Open →' })).not.toBeInTheDocument();
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

    await user.click(await screen.findByRole('button', { name: 'Mark read' }));

    // Non-fatal by design: no alert, and the row is still actionable.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument());
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
});
