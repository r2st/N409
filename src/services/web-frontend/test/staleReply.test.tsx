import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';
import { FirmDashboardPage } from '../src/pages/FirmDashboardPage';
import { AdminJobsPage } from '../src/pages/AdminJobsPage';

/**
 * Out-of-order replies to a request the user re-issued.
 *
 * Every one of these pages re-fetches when a control changes, and nothing about
 * `fetch` orders the replies. The interesting case is not a request that fails
 * — it is one that succeeds *late*, after the user has already moved on, and
 * repaints the previous answer under the current controls. There is no error
 * state, no spinner and no further request coming to correct it, so the screen
 * settles on a self-consistent lie.
 *
 * Each test here drives the same shape: issue request A, change the control to
 * issue request B, then resolve B *before* A. The newest answer must win, and
 * the abandoned one must write nothing — neither its data nor its failure.
 *
 * See `src/lib/useLatestOnly.ts` for the guard these assert.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VAL_A = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

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

/**
 * A request whose reply the test releases by hand.
 *
 * The race cannot be produced with resolved promises and fake timers: it needs
 * two replies genuinely outstanding at once, released in the opposite order to
 * the order they were issued.
 */
interface Pending {
  url: string;
  resolve: (body: unknown, status?: number) => void;
}

function deferredFetch(handler: (url: string) => unknown | 'defer') {
  const pending: Pending[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    const immediate = handler(path);
    if (immediate !== 'defer') return jsonResponse(immediate);
    return new Promise<Response>((res) => {
      pending.push({ url: path, resolve: (body, status = 200) => res(jsonResponse(body, status)) });
    });
  });
  return pending;
}

const valuationRow = (id: string, company: string) => ({
  id,
  number: '1001',
  workflow_id: null,
  kind: '409a',
  state: 'completed',
  waiting_on_client: false,
  company_name: company,
  service_name: null,
  user_id: OPS_ID,
  partner_id: null,
  source: null,
  currency: 'USD',
  service_countries: [],
  paid_status: 'paid',
  qsbs_attestation: null,
  delivery_days: null,
  assigned_reviewer_id: null,
  created_at: '2026-07-01T00:00:00Z',
  due_date: null,
  published_at: null,
});

const listBody = (company: string) => ({
  valuations: [valuationRow(VAL_A, company)],
  page: 1,
  per_page: 25,
  total: 1,
});

const COUNTS = {
  counts: { all: 1, open: 0, in_review: 0, drafted: 0, published: 0, closed: 1 },
  buckets: [
    { key: 'all', label: 'All' },
    { key: 'in_review', label: 'In review' },
  ],
};

describe('ValuationsPage — the worklist under two outstanding loads', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the newest filter’s rows when the previous filter replies last', async () => {
    const pending = deferredFetch((path) => {
      if (path.includes('/valuations/counts')) return COUNTS;
      if (path.includes('/users/options')) return { options: [] };
      if (path.includes('/partners')) return { partners: [] };
      if (path.includes('/valuations?')) return 'defer';
      return {};
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/valuations']}>
        <ValuationsPage />
      </MemoryRouter>,
    );

    // The first load, released so the page has rows to be wrong about.
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(listBody('First Load Inc'));
    await screen.findAllByText('First Load Inc');

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'review');
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText('Filter by state'), 'completed');
    await waitFor(() => expect(pending).toHaveLength(3));

    expect(pending[1]!.url).toContain('state=review');
    expect(pending[2]!.url).toContain('state=completed');

    // The newest reply first, then the abandoned one on top of it.
    pending[2]!.resolve(listBody('Completed Co'));
    await screen.findAllByText('Completed Co');
    pending[1]!.resolve(listBody('Review Co'));

    await waitFor(() => expect(screen.getAllByText('Completed Co').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('Review Co')).toHaveLength(0);
  });

  it('does not raise a load error from the filter the user already left', async () => {
    // The failure half: an abandoned request that 500s would otherwise put
    // "Could not load valuations." over rows that loaded perfectly well.
    const pending = deferredFetch((path) => {
      if (path.includes('/valuations/counts')) return COUNTS;
      if (path.includes('/users/options')) return { options: [] };
      if (path.includes('/partners')) return { partners: [] };
      if (path.includes('/valuations?')) return 'defer';
      return {};
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/valuations']}>
        <ValuationsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(listBody('First Load Inc'));
    await screen.findAllByText('First Load Inc');

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'review');
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText('Filter by state'), 'completed');
    await waitFor(() => expect(pending).toHaveLength(3));

    pending[2]!.resolve(listBody('Completed Co'));
    await screen.findAllByText('Completed Co');
    pending[1]!.resolve({ detail: 'gone' }, 500);

    await waitFor(() => expect(screen.getAllByText('Completed Co').length).toBeGreaterThan(0));
    expect(screen.queryByText(/Could not load valuations/)).toBeNull();
  });

  it('keeps the tab counts belonging to the filter the tabs are describing', async () => {
    // The counts load is separate from the rows and is re-issued by the same
    // filter changes, so it races the same way. Its stale reply repaints the
    // scope tab badges for a filter set that is no longer on screen.
    const pending = deferredFetch((path) => {
      if (path.includes('/valuations/counts')) return 'defer';
      if (path.includes('/users/options')) return { options: [] };
      if (path.includes('/partners')) return { partners: [] };
      if (path.includes('/valuations?')) return listBody('Acme Corp');
      return {};
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/valuations']}>
        <ValuationsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(COUNTS);
    await screen.findByRole('tab', { name: /In review/ });

    await user.selectOptions(screen.getByLabelText('Filter by kind'), '409a');
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText('Filter by kind'), 'fmv');
    await waitFor(() => expect(pending).toHaveLength(3));

    pending[2]!.resolve({
      counts: { all: 7, open: 0, in_review: 7, drafted: 0, published: 0, closed: 0 },
      buckets: COUNTS.buckets,
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: /In review/ })).toHaveTextContent('7'));

    pending[1]!.resolve({
      counts: { all: 99, open: 0, in_review: 99, drafted: 0, published: 0, closed: 0 },
      buckets: COUNTS.buckets,
    });
    await waitFor(() => expect(screen.getByRole('tab', { name: /In review/ })).toHaveTextContent('7'));
    expect(screen.getByRole('tab', { name: /In review/ })).not.toHaveTextContent('99');
  });
});

/**
 * R147: the same race, in the spelling the census could not read.
 *
 * Both pages below delegate to a `useCallback` and assemble the varying part of
 * the address into a `URLSearchParams` before the template literal sees it, so
 * the scan that found the six above reported them clean. What they do at
 * runtime is exactly what `ValuationsPage` did.
 */

const CLIENT_ROW = (company: string) => ({
  company_name: company,
  engagements: 1,
  active: 1,
  latest_valuation_id: VAL_A,
  latest_state: 'in_review',
  latest_created_at: '2026-06-01T00:00:00Z',
  next_due_date: null,
  last_published_at: null,
});

const FIRM_DASHBOARD = {
  firm: { id: '01N409FIRM0000000000000AA', name: 'Meridian Valuations' },
  summary: {
    total: 1,
    active: 1,
    published: 0,
    closed: 0,
    waiting_on_client: 0,
    overdue: 0,
    due_soon: 0,
    unassigned: 0,
    by_state: {},
  },
  team: [],
  attention: [],
  attention_total: 0,
  attention_counts: { overdue: 0, unassigned: 0, stalled_with_client: 0, stalled_in_review: 0, due_soon: 0 },
};

describe('FirmDashboardPage — the book of clients under two outstanding searches', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the newest search’s clients when the previous search replies last', async () => {
    const pending = deferredFetch((path) => {
      if (path.includes('/firm/dashboard')) return FIRM_DASHBOARD;
      if (path.includes('/firm/intake-links')) return { links: [] };
      if (path.includes('/firm/clients')) return 'defer';
      return {};
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/firm']}>
        <FirmDashboardPage />
      </MemoryRouter>,
    );

    // The debounced first load, released so the table has a book to be wrong about.
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve({ clients: [CLIENT_ROW('Opening Book Ltd')], total: 1 });
    await screen.findByText('Opening Book Ltd');

    const box = screen.getByLabelText('Search clients');
    await user.type(box, 'ac');
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.type(box, 'me');
    await waitFor(() => expect(pending).toHaveLength(3));

    expect(decodeURIComponent(pending[1]!.url)).toContain('search=ac');
    expect(decodeURIComponent(pending[2]!.url)).toContain('search=acme');

    // The newest reply first, then the abandoned one on top of it.
    pending[2]!.resolve({ clients: [CLIENT_ROW('Acme Corp')], total: 1 });
    await screen.findByText('Acme Corp');
    pending[1]!.resolve({ clients: [CLIENT_ROW('Acorn Holdings')], total: 9 });

    await waitFor(() => expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0));
    expect(screen.queryByText('Acorn Holdings')).not.toBeInTheDocument();
    // The count rides on the same reply, so it is the other half of the lie.
    expect(screen.queryByText(/9 clients/)).not.toBeInTheDocument();
  });

  it('does not raise a load error from the search the user already left', async () => {
    const pending = deferredFetch((path) => {
      if (path.includes('/firm/dashboard')) return FIRM_DASHBOARD;
      if (path.includes('/firm/intake-links')) return { links: [] };
      if (path.includes('/firm/clients')) return 'defer';
      return {};
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/firm']}>
        <FirmDashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve({ clients: [CLIENT_ROW('Opening Book Ltd')], total: 1 });
    await screen.findByText('Opening Book Ltd');

    const box = screen.getByLabelText('Search clients');
    await user.type(box, 'ac');
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.type(box, 'me');
    await waitFor(() => expect(pending).toHaveLength(3));

    // The newest search lands, and lands well.
    pending[2]!.resolve({ clients: [CLIENT_ROW('Acme Corp')], total: 1 });
    await screen.findByText('Acme Corp');

    // The abandoned one then 500s. Unguarded, its failure takes the book the
    // reader is looking at off the screen and replaces it with an error about
    // a search they already left, with nothing coming to put it back.
    pending[1]!.resolve({ title: 'The client list is unavailable.' }, 500);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('The client list is unavailable.')).not.toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });
});

const JOB_ROW = (id: string, company: string) => ({
  id,
  source: 'ai_job',
  status: 'failed',
  detail: 'failed',
  name: 'extract',
  valuation_id: VAL_A,
  valuation_number: '1766',
  company_name: company,
  error: null,
  attempts: null,
  created_at: '2026-08-08T08:00:00Z',
  due_at: '2026-08-08T08:00:00Z',
  finished_at: '2026-08-08T08:01:00Z',
  duration_ms: 60_000,
});

const JOB_STATS = {
  since_hours: 24,
  totals: { active: 0, failed: 1, succeeded: 0, skipped: 0 },
  by_source: [],
};

describe('AdminJobsPage — the queue under two outstanding loads', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the newest queue filter’s jobs when the previous filter replies last', async () => {
    const pending = deferredFetch((path) => {
      if (path.includes('/admin/jobs/stats')) return JOB_STATS;
      if (path.includes('/admin/jobs/alerts')) return { alerts: [], rules: [], open: 0 };
      if (path.includes('/admin/jobs?')) return 'defer';
      return {};
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/admin/jobs']}>
        <AdminJobsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve({ jobs: [JOB_ROW('J0', 'First Load Inc')], total: 1 });
    await screen.findByText('First Load Inc');

    const queue = screen.getByLabelText('Filter by queue');
    await user.selectOptions(queue, 'email');
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.selectOptions(queue, 'webhook_delivery');
    await waitFor(() => expect(pending).toHaveLength(3));

    expect(pending[1]!.url).toContain('source=email');
    expect(pending[2]!.url).toContain('source=webhook_delivery');

    pending[2]!.resolve({ jobs: [JOB_ROW('J2', 'Webhook Co')], total: 1 });
    await screen.findByText('Webhook Co');
    // The abandoned reply, landing last — and carrying a total the pager would
    // otherwise take as the truth about the queue on screen.
    pending[1]!.resolve({ jobs: [JOB_ROW('J1', 'Email Co')], total: 77 });

    await waitFor(() => expect(screen.getAllByText('Webhook Co').length).toBeGreaterThan(0));
    expect(screen.queryByText('Email Co')).not.toBeInTheDocument();
    expect(screen.queryByText(/77 jobs/)).not.toBeInTheDocument();
  });
});
