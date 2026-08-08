import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ComparablesTab } from '../src/pages/valuation/ComparablesTab';
import type { Valuation } from '../src/lib/types';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', roles: ['admin'] } }),
}));

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'review',
  company_name: 'Zorblatt Dynamics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const nullMultiples = {
  ev_revenue_ltm: null,
  ev_revenue_ntm: null,
  ev_ebitda_ltm: null,
  ev_ebitda_ntm: null,
};

const SET = {
  comparables: [
    {
      id: '01JCOMPAAAAAAAAAAAAAAAAAAA',
      ticker: 'AAA',
      name: 'Alpha Analytics',
      sic: '7372',
      source: 'market_feed',
      included: true,
      exclude_reason: null,
      ev: 1000,
      revenue_ltm: 100,
      revenue_ntm: null,
      ebitda_ltm: null,
      ebitda_ntm: null,
      score: 0.82,
      multiples: { ...nullMultiples, ev_revenue_ltm: 10 },
    },
    {
      id: '01JCOMPBBBBBBBBBBBBBBBBBBB',
      ticker: 'BBB',
      name: 'Beta Systems',
      sic: '7372',
      source: 'analyst',
      included: true,
      exclude_reason: null,
      ev: 1400,
      revenue_ltm: 100,
      revenue_ntm: null,
      ebitda_ltm: null,
      ebitda_ntm: null,
      score: null,
      multiples: { ...nullMultiples, ev_revenue_ltm: 14 },
    },
    {
      id: '01JCOMPZZZZZZZZZZZZZZZZZZZ',
      ticker: 'ZZZ',
      name: 'Zeta Mining',
      sic: '1000',
      source: 'market_feed',
      included: false,
      exclude_reason: 'different industry',
      ev: null,
      revenue_ltm: null,
      revenue_ntm: null,
      ebitda_ltm: null,
      ebitda_ntm: null,
      score: 0.05,
      multiples: { ...nullMultiples },
    },
  ],
  statistics: {
    ev_revenue_ltm: {
      key: 'ev_revenue_ltm',
      label: 'EV/LTM Revenue',
      count: 2,
      median: 12,
      min: 10,
      max: 14,
    },
    ev_revenue_ntm: {
      key: 'ev_revenue_ntm',
      label: 'EV/NTM Revenue',
      count: 0,
      median: null,
      min: null,
      max: null,
    },
    ev_ebitda_ltm: {
      key: 'ev_ebitda_ltm',
      label: 'EV/LTM EBITDA',
      count: 0,
      median: null,
      min: null,
      max: null,
    },
    ev_ebitda_ntm: {
      key: 'ev_ebitda_ntm',
      label: 'EV/NTM EBITDA',
      count: 0,
      median: null,
      min: null,
      max: null,
    },
  },
  primary_multiple: 'ev_revenue_ltm',
  market_method: 'revenue',
  market_horizon: 'ltm',
  can_edit: true,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(over: Partial<typeof SET> = {}, onWrite?: (path: string, init: RequestInit) => Response) {
  const body = { ...SET, ...over };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      return onWrite ? onWrite(path, init!) : jsonResponse({});
    }
    if (path.includes('/comparables')) return jsonResponse(body);
    throw new Error(`unexpected fetch ${path}`);
  });
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/comparables']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/comparables" element={<ComparablesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ComparablesTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists the peer set with each row’s source', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText('Alpha Analytics')).toBeInTheDocument();
    expect(screen.getByText('Beta Systems')).toBeInTheDocument();
    expect(screen.getByText('Analyst')).toBeInTheDocument();
  });

  /**
   * The excluded row is the point of the whole surface: it has to stay visible,
   * with the reason, or the tab is just a prettier version of the aggregate the
   * platform already stored.
   */
  it('keeps an excluded company on screen with the reason it was set aside', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText('Zeta Mining')).toBeInTheDocument();
    expect(screen.getByText(/Excluded — different industry/)).toBeInTheDocument();
  });

  it('names the multiple the market approach will strike, and its median', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText(/EV\/LTM Revenue — median/)).toBeInTheDocument();
    expect(screen.getByText('12.00x')).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 companies/)).toBeInTheDocument();
  });

  it('shows only the multiples the retained set actually has', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');
    const table = screen.getByRole('table', { name: 'Comparable companies' });
    expect(table).toHaveTextContent('EV/LTM Rev');
    // No retained comp reports EBITDA, so that column would be all dashes.
    expect(table).not.toHaveTextContent('EV/LTM EBITDA');
  });

  it('will not send an exclusion until a reason is given', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockApi({}, (_path, init) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' })[0]!);
    const reason = await screen.findByLabelText(/why is this company not comparable/i);
    // The field is required, so submitting empty never reaches the network.
    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' }).at(-1)!);
    expect(sent).toHaveLength(0);

    await userEvent.type(reason, 'acquired mid-period');
    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' }).at(-1)!);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ included: false, exclude_reason: 'acquired mid-period' });
  });

  /** A screened row is excluded, never deleted — so it offers no Remove. */
  it('offers Remove on analyst rows only', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    expect(removes).toHaveLength(1);
  });

  it('hides every edit control from a reader who cannot edit', async () => {
    mockApi({ can_edit: false });
    renderTab();
    await screen.findByText('Alpha Analytics');
    expect(screen.queryByRole('button', { name: 'Re-screen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exclude' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add peer' })).not.toBeInTheDocument();
  });

  it('explains the fallback when nothing has been screened', async () => {
    mockApi({ comparables: [] });
    renderTab();
    expect(await screen.findByText('No comparables recorded')).toBeInTheDocument();
    expect(screen.getByText(/AI comp-selection run/)).toBeInTheDocument();
  });
});
