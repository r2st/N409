import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

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
