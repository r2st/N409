import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

    const pivot = await screen.findByRole('table', { name: 'Product pivot' });
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

    const detail = await screen.findByRole('table', { name: 'State detail' });
    expect(detail).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    const started = links.find((l) => l.getAttribute('href') === '/valuations?state=started');
    expect(started).toBeTruthy();
    expect(started!.textContent).toBe('3');
  });

  it('keeps drill-through links consistent with the date range', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: 'Product pivot' });

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
    expect(screen.queryByRole('table', { name: 'Product pivot' })).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('/stats/dashboard'))).toBe(true);
  });
});
