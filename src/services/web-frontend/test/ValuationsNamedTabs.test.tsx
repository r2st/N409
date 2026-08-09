import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/** Design §4.2 — the nine named listing tabs. */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: OPS_ID,
      email: 'ops@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ['admin'],
    },
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BUCKETS = [
  { key: 'all', label: 'All' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'unverified', label: 'Unverified' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'waiting_on_client', label: 'Waiting On Client' },
  { key: 'drafted', label: 'Drafted' },
  { key: 'published', label: 'Published' },
  { key: 'unread', label: 'Unread' },
  { key: 'ignored', label: 'Ignored' },
];

const COUNTS = {
  all: 979,
  incomplete: 317,
  unverified: 17,
  in_progress: 29,
  waiting_on_client: 22,
  drafted: 41,
  published: 575,
  unread: 6,
  ignored: 326,
};

function mockApi() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: COUNTS, buckets: BUCKETS });
    }
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/valuations?')) {
      return jsonResponse({ valuations: [], page: 1, per_page: 25, total: 0 });
    }
    return jsonResponse({});
  });
  return calls;
}

const renderPage = (entry = '/valuations') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ValuationsPage />
    </MemoryRouter>,
  );

describe('ValuationsPage named tabs', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the nine tabs the server names, with their counts', async () => {
    mockApi();
    renderPage();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(9);
    expect(tabs.map((t) => t.textContent)).toEqual([
      'All979',
      'Incomplete317',
      'Unverified17',
      'In Progress29',
      'Waiting On Client22',
      'Drafted41',
      'Published575',
      'Unread6',
      'Ignored326',
    ]);
  });

  /**
   * The labels come off the wire rather than being restated in the frontend.
   * Two copies of the mapping would be two answers to "how many are in
   * progress", and a tab whose count and rows disagree is worse than no tab.
   */
  it('asks for the named bucket shape', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findAllByRole('tab');
    expect(calls.some((c) => c.includes('buckets=named'))).toBe(true);
  });

  it('filters the listing by the tab that was clicked', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findAllByRole('tab');

    await userEvent.click(screen.getByRole('tab', { name: /Unverified/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.includes('/valuations?') && c.includes('bucket=unverified'))).toBe(true),
    );
  });

  it('marks the active tab from the URL', async () => {
    mockApi();
    renderPage('/valuations?bucket=drafted');
    const drafted = await screen.findByRole('tab', { name: /Drafted/ });
    expect(drafted).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('still honours a link written against the old five-group key', async () => {
    // `group` stays a URL alias so saved views and shared links do not break.
    const calls = mockApi();
    renderPage('/valuations?group=published');
    await screen.findAllByRole('tab');
    expect(calls.some((c) => c.includes('/valuations?') && c.includes('group=published'))).toBe(true);
  });

  it('drops the legacy alias when a tab is clicked, so the URL says one thing', async () => {
    const calls = mockApi();
    renderPage('/valuations?group=published');
    await screen.findAllByRole('tab');

    await userEvent.click(screen.getByRole('tab', { name: /Ignored/ }));
    await waitFor(() => {
      const listCalls = calls.filter((c) => c.includes('/valuations?') && !c.includes('counts'));
      const last = listCalls[listCalls.length - 1]!;
      expect(last).toContain('bucket=ignored');
      expect(last).not.toContain('group=');
    });
  });

  it('the All tab clears the bucket rather than filtering on "all"', async () => {
    const calls = mockApi();
    renderPage('/valuations?bucket=drafted');
    await screen.findAllByRole('tab');

    await userEvent.click(screen.getByRole('tab', { name: /^All/ }));
    await waitFor(() => {
      const listCalls = calls.filter((c) => c.includes('/valuations?') && !c.includes('counts'));
      expect(listCalls[listCalls.length - 1]!).not.toContain('bucket=');
    });
  });

  it('says the filters are the reason a named tab is empty', async () => {
    mockApi();
    renderPage('/valuations?bucket=unverified');
    const empty = await screen.findByText(/Nothing matches these filters/);
    expect(empty).toBeInTheDocument();
    expect(within(empty.closest('div')!).queryByText(/No valuations yet/)).not.toBeInTheDocument();
  });
});
