import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { SavedViews, viewQueryOf } from '../src/components/SavedViews';
import type { SavedView, User } from '../src/lib/types';

/** Saved worklist views (feature-improvements §2, ranked #8). */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeUser = (roles: string[]): User => ({
  id: 'me-1',
  email: 'me@409.ai',
  first_name: 'Mo',
  last_name: 'Ops',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles,
});

const view = (over: Partial<SavedView>): SavedView => ({
  id: 'sv-1',
  name: 'Due this week',
  query: 'due_to=2026-08-06&reviewer_id=me-1',
  visibility: 'private',
  is_default: false,
  is_owner: true,
  owner_name: 'Mo Ops',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  ...over,
});

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

function mockApi(roles: string[], views: SavedView[], recorded: Recorded[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/me')) return jsonResponse({ user: makeUser(roles) });
    if (path.includes('/saved-views')) {
      recorded.push({
        method,
        url: path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === 'GET') return jsonResponse({ views });
      if (method === 'DELETE') return jsonResponse(null, 204);
      return jsonResponse({ view: views[0] ?? view({}) }, method === 'POST' ? 201 : 200);
    }
    return jsonResponse({});
  });
}

function Probe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderViews(roles: string[], views: SavedView[], initialPath = '/valuations') {
  const recorded: Recorded[] = [];
  mockApi(roles, views, recorded);
  localStorage.setItem('n409.token', 'header.payload.sig');
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Probe />
        <Routes>
          <Route path="/valuations" element={<SavedViews />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return recorded;
}

describe('viewQueryOf', () => {
  it('keeps only saveable keys, sorted, and drops pagination and blanks', () => {
    const params = new URLSearchParams(
      'state=in_review&page=3&per_page=50&q=&kind=409a&nonsense=1&sort=due_date%3Aasc',
    );
    expect(viewQueryOf(params)).toBe('kind=409a&sort=due_date%3Aasc&state=in_review');
  });

  it('is empty for an unfiltered list', () => {
    expect(viewQueryOf(new URLSearchParams('page=2'))).toBe('');
  });
});

describe('SavedViews', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('applies a view to the URL when picked', async () => {
    renderViews(['reviewer'], [view({})]);
    const picker = await screen.findByRole('combobox', { name: 'Saved view' });

    await userEvent.selectOptions(picker, 'sv-1');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('due_to=2026-08-06'));
  });

  it('will not save an unfiltered list', async () => {
    renderViews(['reviewer'], []);
    expect(await screen.findByRole('button', { name: 'Save this view' })).toBeDisabled();
  });

  it('saves the on-screen filters under a name', async () => {
    const recorded = renderViews(['reviewer'], [], '/valuations?state=in_review&kind=409a&page=4');
    await userEvent.click(await screen.findByRole('button', { name: 'Save this view' }));
    await userEvent.type(screen.getByRole('textbox'), 'Review queue');
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));

    await waitFor(() => expect(recorded.some((r) => r.method === 'POST')).toBe(true));
    const post = recorded.find((r) => r.method === 'POST')!;
    expect(post.body).toMatchObject({
      name: 'Review queue',
      // Page is not part of a view.
      query: 'kind=409a&state=in_review',
      visibility: 'private',
      is_default: false,
    });
  });

  it('offers sharing to ops', async () => {
    renderViews(['reviewer'], [], '/valuations?state=in_review');
    await userEvent.click(await screen.findByRole('button', { name: 'Save this view' }));
    expect(screen.getByText('Share with the operations team')).toBeInTheDocument();
  });

  it('does not offer sharing to a client', async () => {
    renderViews(['valuation_user'], [], '/valuations?state=in_review');
    await userEvent.click(await screen.findByRole('button', { name: 'Save this view' }));
    expect(screen.queryByText('Share with the operations team')).not.toBeInTheDocument();
  });

  it('opens on the default view, but never over a link that already has filters', async () => {
    renderViews(['reviewer'], [view({ is_default: true, query: 'state=in_review' })]);
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('state=in_review'));

    // A shared or bookmarked URL wins over the default.
    renderViews(
      ['reviewer'],
      [view({ id: 'sv-2', is_default: true, query: 'state=in_review' })],
      '/valuations?kind=409a',
    );
    await waitFor(() => expect(screen.getAllByTestId('search')[1]).toHaveTextContent('kind=409a'));
  });

  it('shows a teammate’s shared view but no controls for it', async () => {
    renderViews(
      ['reviewer'],
      [
        view({
          id: 'sv-shared',
          name: 'Unpaid',
          query: 'paid_status=unpaid',
          is_owner: false,
          owner_name: 'Ada',
        }),
      ],
      '/valuations?paid_status=unpaid',
    );
    expect(await screen.findByRole('option', { name: /Unpaid — Ada/ })).toBeInTheDocument();
    // Not the owner: no rename/share/delete affordances.
    expect(screen.queryByRole('button', { name: 'Delete view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make default' })).not.toBeInTheDocument();
  });

  it('lets the owner toggle default, sharing and deletion of the active view', async () => {
    const recorded = renderViews(
      ['reviewer'],
      [view({ query: 'state=in_review' })],
      '/valuations?state=in_review',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(recorded.some((r) => r.method === 'PATCH')).toBe(true));
    expect(recorded.find((r) => r.method === 'PATCH')!.body).toEqual({ is_default: true });

    await userEvent.click(screen.getByRole('button', { name: 'Share with team' }));
    await waitFor(() => expect(recorded.filter((r) => r.method === 'PATCH')).toHaveLength(2));
    expect(recorded.filter((r) => r.method === 'PATCH')[1]!.body).toEqual({ visibility: 'shared' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(recorded.some((r) => r.method === 'DELETE')).toBe(true));
  });

  it('survives the picker failing to load', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/auth/me')) return jsonResponse({ user: makeUser(['reviewer']) });
      return jsonResponse({ detail: 'boom' }, 500);
    });
    localStorage.setItem('n409.token', 'header.payload.sig');
    render(
      <MemoryRouter initialEntries={['/valuations']}>
        <AuthProvider>
          <SavedViews />
        </AuthProvider>
      </MemoryRouter>,
    );
    // Renders the empty picker rather than throwing the worklist away.
    expect(await screen.findByRole('combobox', { name: 'Saved view' })).toBeInTheDocument();
  });
});
