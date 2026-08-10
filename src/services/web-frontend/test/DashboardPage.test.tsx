import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../src/pages/DashboardPage';
import type { DashboardAnalytics, User, Valuation } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = {
  id: '01N409USER00000000000000OP',
  email: 'ops@example.com',
  first_name: 'Olive',
  last_name: 'Ops',
  roles: ['admin'],
} as unknown as User;

const clientUser = {
  id: '01N409USER00000000000000CL',
  email: 'client@example.com',
  first_name: 'Cleo',
  last_name: 'Client',
  roles: ['valuation_user'],
} as unknown as User;

const valuations = [
  {
    id: '01N409VAL000000000000000AA',
    company_name: 'Acme',
    kind: '409a',
    state: 'started',
    waiting_on_client: false,
    created_at: '2026-06-01T00:00:00Z',
    due_date: null,
  },
] as unknown as Valuation[];

const analytics: DashboardAnalytics = {
  total: 5,
  by_kind: [
    { kind: '409a', open: 2, in_review: 1, drafted: 0, published: 1, closed: 0, total: 4 },
    { kind: 'esop', open: 1, in_review: 0, drafted: 0, published: 0, closed: 0, total: 1 },
  ],
  by_state: { started: 3, review: 1, published: 1 },
  by_source: { direct: 5 },
  buckets: {
    all: { total: 5, unread: 2 },
    incomplete: { total: 3, unread: 2 },
    unverified: { total: 0, unread: 0 },
    in_progress: { total: 1, unread: 0 },
    waiting_on_client: { total: 1, unread: 0 },
    drafted: { total: 0, unread: 0 },
    published: { total: 1, unread: 0 },
    unread: { total: 2, unread: 2 },
    ignored: { total: 0, unread: 0 },
  },
  activity: [
    {
      id: '01N409EVT000000000000000AA',
      scope: 'valuation',
      type: 'valuation_state_changed',
      actor_type: 'human',
      actor_email: 'ops@example.com',
      valuation_id: '01N409VAL000000000000000AA',
      company_name: 'Acme',
      number: '1042',
      occurred_at: '2026-07-02T09:00:00Z',
    },
  ],
  throughput: [
    { week: '2026-04-06', count: 0 },
    { week: '2026-04-13', count: 2 },
    { week: '2026-04-20', count: 1 },
  ],
  sla: { overdue: 2, waiting_stale: 1, waiting_days: 7 },
};

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/valuations?')) return jsonResponse({ valuations, page: 1, per_page: 100, total: 1 });
    if (path.includes('/stats/dashboard')) return jsonResponse(analytics);
    throw new Error(`unexpected fetch ${path}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = opsUser;
  });

  it('renders drill-through links on pivot cells for ops', async () => {
    mockApi();
    renderPage();

    const pivot = await screen.findByRole('table', { name: /Valuations by product and workflow stage/ });
    expect(pivot).toBeInTheDocument();

    // Cell: 409a × open = 2 → /valuations?kind=409a&group=open
    const links = screen.getAllByRole('link');
    const cell = links.find((l) => l.getAttribute('href') === '/valuations?kind=409a&group=open');
    expect(cell).toBeTruthy();
    expect(cell!.textContent).toBe('2');

    // Row total drops the group filter; the grand total drops both.
    expect(links.some((l) => l.getAttribute('href') === '/valuations?kind=409a')).toBe(true);
    expect(links.some((l) => l.getAttribute('href') === '/valuations')).toBe(true);
    // Column total drops the kind filter.
    expect(links.some((l) => l.getAttribute('href') === '/valuations?group=in_review')).toBe(true);
  });

  it('renders the per-state detail with state drill-through', async () => {
    mockApi();
    renderPage();

    const detail = await screen.findByRole('table', { name: /Valuations by workflow state/ });
    expect(detail).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    const started = links.find((l) => l.getAttribute('href') === '/valuations?state=started');
    expect(started).toBeTruthy();
    expect(started!.textContent).toBe('3');
  });

  it('keeps drill-through links consistent with the date range', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /Valuations by product and workflow stage/ });

    const from = screen.getByLabelText('Analytics from') as HTMLInputElement;
    // fireEvent-style change via userEvent is overkill for a date input
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(from, { target: { value: '2026-06-01' } });

    await waitFor(() => {
      const links = screen.getAllByRole('link');
      expect(
        links.some(
          (l) => l.getAttribute('href') === '/valuations?created_from=2026-06-01&kind=409a&group=open',
        ),
      ).toBe(true);
    });
  });

  it('hides analytics from client users and never fetches stats', async () => {
    mockUser = clientUser;
    const fetchSpy = mockApi();
    renderPage();

    // Stat cards still render for clients…
    expect(await screen.findByText('Recent valuations')).toBeInTheDocument();
    // …but the analytics block is gone.
    expect(screen.queryByText('Analytics')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('table', { name: /Valuations by product and workflow stage/ }),
    ).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('/stats/dashboard'))).toBe(true);
  });

  // ── Design §3.1 — the three bands the landing dashboard was missing ────────

  it('renders the bucket strip with unread badges, linked to the pre-filtered listing', async () => {
    mockApi();
    renderPage();

    await screen.findByText('Incomplete');
    const links = screen.getAllByRole('link');
    const incomplete = links.find((l) => l.getAttribute('href') === '/valuations?bucket=incomplete');
    expect(incomplete).toBeTruthy();
    expect(incomplete!.textContent).toContain('3');
    expect(incomplete!.textContent).toContain('2 unread');
    // A bucket with nothing unread carries no badge — a zero repeated seven
    // times says the same thing seven ways.
    const published = links.find((l) => l.getAttribute('href') === '/valuations?bucket=published');
    expect(published!.textContent).not.toContain('unread');
  });

  /**
   * The dashboard is a wall of numbers in tables and charts, which is exactly
   * the content that disappears when the markup is only visual.
   */
  describe('accessibility', () => {
    it('names the pivot with a caption and scopes every header cell', async () => {
      mockApi();
      renderPage();
      const pivot = await screen.findByRole('table', { name: /Valuations by product and workflow stage/ });

      // Column headers, so a figure read in isolation is announced with the
      // stage it belongs to.
      expect(within(pivot).getAllByRole('columnheader').length).toBeGreaterThan(1);
      expect(within(pivot).getByRole('columnheader', { name: 'Product' })).toBeInTheDocument();
      // And a row header per product plus the totals row, so it is announced
      // with the product too — "3" alone is not an answer to anything.
      const rowHeaders = within(pivot).getAllByRole('rowheader');
      expect(rowHeaders.length).toBeGreaterThan(1);
      expect(rowHeaders.some((h) => /total/i.test(h.textContent ?? ''))).toBe(true);
    });

    it('gives the state detail table a caption and row headers', async () => {
      mockApi();
      renderPage();
      const detail = await screen.findByRole('table', { name: /Valuations by workflow state/ });
      expect(within(detail).getByRole('columnheader', { name: 'State' })).toBeInTheDocument();
      expect(within(detail).getAllByRole('rowheader').length).toBeGreaterThan(0);
    });

    it('names each bucket link with what following it does', async () => {
      mockApi();
      renderPage();
      await screen.findByText('Incomplete');
      // Not "Incomplete 3 2 unread" — three numbers and no sentence.
      expect(screen.getByRole('link', { name: 'Incomplete: 3 valuations, 2 unread' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /^Published: \d+ valuations$/ })).toBeInTheDocument();
    });

    it('groups the analytics date inputs so their two labels have a subject', async () => {
      mockApi();
      renderPage();
      await screen.findByLabelText('Analytics from');
      expect(screen.getByRole('group', { name: 'Analytics date range' })).toBeInTheDocument();
    });
  });

  it('states both SLA figures, and what the waiting one means', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Past due')).toBeInTheDocument();
    expect(screen.getByText('Stalled with the client')).toBeInTheDocument();
    expect(screen.getByText(/no contact for 7 days/)).toBeInTheDocument();
  });

  it('draws the throughput series', async () => {
    mockApi();
    renderPage();
    // The SVG is decorative; the series is published as a table so a screen
    // reader can read the figures rather than only the chart's name.
    expect(await screen.findByRole('table', { name: /Published per week/ })).toBeInTheDocument();
  });

  it('lists recent activity against the engagement it happened on', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('Valuation state changed')).toBeInTheDocument();
    const row = screen
      .getAllByRole('link')
      .find((l) => l.getAttribute('href') === '/valuations/01N409VAL000000000000000AA');
    expect(row!.textContent).toContain('Acme');
    expect(row!.textContent).toContain('#1042');
  });

  it('shows a client none of the four bands', async () => {
    mockUser = clientUser;
    mockApi();
    renderPage();
    await screen.findByText('Recent valuations');
    // Every band is served by /stats/dashboard, which a client never fetches.
    expect(screen.queryByText('Past due')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Incomplete')).not.toBeInTheDocument();
  });
});
