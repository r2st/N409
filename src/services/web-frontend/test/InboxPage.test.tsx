import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { InboxPage } from '../src/pages/InboxPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const item = (over: Record<string, unknown> = {}) => ({
  id: '01N409IC000000000000000001',
  valuation_id: '01N409VA000000000000000001',
  valuation_number: '1766',
  company_name: 'Acme Corp',
  valuation_kind: '409a',
  valuation_state: 'started',
  kind: 'chat',
  body: 'Where do I upload the cap table?',
  author_name: 'Dana Client',
  author_email: 'dana@acme.test',
  email_meta: null,
  pinned: false,
  created_at: '2026-08-07T09:00:00Z',
  unread: true,
  ...over,
});

function mockApi(overrides: { items?: unknown[]; unread_total?: number } = {}) {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.includes('/inbox/read')) return jsonResponse({ marked: 1 });
    if (path.includes('/inbox')) {
      const items = overrides.items ?? [item()];
      return jsonResponse({
        items,
        total: items.length,
        unread_total: overrides.unread_total ?? items.filter((i) => (i as { unread: boolean }).unread).length,
        page: 1,
        per_page: 25,
      });
    }
    return jsonResponse({}, 404);
  });
  return { spy, calls };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <InboxPage />
    </MemoryRouter>,
  );

describe('InboxPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists threads from across every engagement', async () => {
    mockApi({
      items: [
        item(),
        item({
          id: '01N409IC000000000000000002',
          valuation_id: '01N409VA000000000000000002',
          company_name: 'Beta Industries',
          body: 'Any update on this one?',
          unread: false,
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta Industries')).toBeInTheDocument();
    expect(screen.getByText(/Where do I upload the cap table\?/)).toBeInTheDocument();
  });

  it('reports the unread count in words rather than only a badge', async () => {
    mockApi({ items: [item(), item({ id: 'x2', unread: true })], unread_total: 2 });
    renderPage();
    expect(await screen.findByText(/2 unread/)).toBeInTheDocument();
  });

  it('says so plainly when nothing is unread', async () => {
    mockApi({ items: [item({ unread: false })], unread_total: 0 });
    renderPage();
    expect(await screen.findByText(/Nothing unread/)).toBeInTheDocument();
  });

  it('names an inbound email by the address it came from', async () => {
    // An inbound email has no author row; the sending address is the only
    // thing we know about who sent it, and it is the useful thing.
    mockApi({
      items: [
        item({
          kind: 'email',
          author_name: null,
          author_email: null,
          email_meta: { from: 'cfo@acme.test', subject: 'Re: your 409A' },
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText(/cfo@acme.test/)).toBeInTheDocument();
    expect(screen.getByText(/Re: your 409A/)).toBeInTheDocument();
  });

  it('marks the thread read when the engagement is opened', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await user.click(await screen.findByText('Acme Corp'));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/inbox/read'))).toBe(true),
    );
  });

  it('filters to unread only', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await screen.findByText('Acme Corp');
    await user.click(screen.getByLabelText(/Unread only/i));
    await waitFor(() => expect(calls.some((c) => c.includes('unread=true'))).toBe(true));
  });

  it('filters by message kind', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await screen.findByText('Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    await waitFor(() => expect(calls.some((c) => c.includes('kind=note'))).toBe(true));
  });

  it('searches on submit rather than on every keystroke', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderPage();
    await screen.findByText('Acme Corp');
    await user.type(screen.getByLabelText(/Search the inbox/i), 'cap table');
    // Typing alone must not fire a request per character.
    expect(calls.filter((c) => c.includes('q=')).length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.includes('q=cap+table'))).toBe(true));
  });

  it('disables the clear-all action when nothing is unread', async () => {
    mockApi({ items: [item({ unread: false })], unread_total: 0 });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('explains a forbidden inbox rather than showing an empty one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Forbidden', status: 403 }, 403));
    renderPage();
    expect(await screen.findByText(/do not have access to the shared inbox/i)).toBeInTheDocument();
  });
});
