import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  /**
   * The pivot keeps the previous range's figures through a range change, on
   * purpose: the reader is comparing against what the section said a moment
   * ago, and blanking it would discard the comparison. The catch arm states
   * that rule and its condition — the figures have to be labelled as not
   * current — and only the failure path kept the second half. On the ordinary
   * path one range's numbers sat under another range's dates with nothing to
   * distinguish that from a finished load.
   */
  it('says the figures are the previous range’s while the new one loads', async () => {
    let release: ((body: unknown) => void) | null = null;
    let pivotCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/valuations?'))
        return jsonResponse({ valuations, page: 1, per_page: 100, total: 1 });
      if (path.includes('/stats/dashboard')) {
        pivotCalls += 1;
        if (pivotCalls === 1) return jsonResponse(analytics);
        return new Promise<Response>((res) => {
          release = (body) => res(jsonResponse(body));
        });
      }
      throw new Error(`unexpected fetch ${path}`);
    });

    renderPage();
    const from = (await screen.findByLabelText('Analytics from')) as HTMLInputElement;
    await waitFor(() => expect(pivotCalls).toBe(1));

    await userEvent.type(from, '2026-06-01');
    await waitFor(() => expect(release).toBeTruthy());

    // The figures are still on screen — that is the deliberate part — and they
    // now say which range they belong to.
    const note = await screen.findByText(/still the previous one/i);
    expect(note).toBeInTheDocument();
    expect(screen.getByText('By product')).toBeInTheDocument();

    release!(analytics);
    await waitFor(() => expect(screen.queryByText(/still the previous one/i)).toBeNull());
  });

  /**
   * The analytics pivot is the half of this page that can fail on its own — the
   * valuation list has its own fetch and its own error line. A failed pivot set
   * `analytics` to null and stopped, which renders neither the loading skeleton
   * (loading is over) nor the pivot (there is no data): an "Analytics" heading
   * over blank space, with nothing to say whether the server failed or the range
   * is genuinely empty.
   */
  describe('when the analytics pivot fails', () => {
    const mockFailingAnalytics = (failFrom = 0) => {
      let calls = 0;
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        if (path.includes('/valuations?'))
          return jsonResponse({ valuations, page: 1, per_page: 100, total: 1 });
        if (path.includes('/stats/dashboard')) {
          if (calls++ >= failFrom) return jsonResponse({ error: 'boom' }, 500);
          return jsonResponse(analytics);
        }
        throw new Error(`unexpected fetch ${path}`);
      });
    };

    it('says so rather than rendering an empty analytics section', async () => {
      mockFailingAnalytics();
      renderPage();
      await screen.findByText('Recent valuations');
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/analytics/i);
    });

    it('offers a retry that fetches the pivot again', async () => {
      const fetchSpy = mockFailingAnalytics();
      renderPage();
      await screen.findByRole('alert');
      const before = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/stats/dashboard')).length;
      await userEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
      await waitFor(() =>
        expect(
          fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/stats/dashboard')).length,
        ).toBeGreaterThan(before),
      );
    });

    /**
     * A range change deliberately keeps the pivot already on screen rather than
     * collapsing it to placeholders — the reader is comparing against what it
     * said a moment ago. A *failed* range change discarded it, which is the one
     * case that rule exists to prevent, done silently.
     */
    it('keeps the figures already on screen when a range change fails', async () => {
      mockFailingAnalytics(1);
      renderPage();
      await screen.findByRole('table', { name: /Valuations by product and workflow stage/ });

      await userEvent.type(screen.getByLabelText('Analytics from'), '2026-01-01');
      await screen.findByRole('alert');

      // The stale pivot is still readable, and labelled as not current.
      expect(
        screen.getByRole('table', { name: /Valuations by product and workflow stage/ }),
      ).toBeInTheDocument();
      expect(screen.getByRole('alert').textContent).toMatch(/could not|failed|not be refreshed/i);
    });
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
