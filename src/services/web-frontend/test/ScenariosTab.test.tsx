import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ScenariosTab } from '../src/pages/valuation/ScenariosTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const BOOT = {
  baseline: {
    calculation_id: 'c1',
    created_at: '2026-07-01T00:00:00Z',
    equity_value: 20_000_000,
    fmv_per_share: 2,
  },
  defaults: {
    revenue: 5_000_000,
    growth_rate: 0.03,
    discount_rate: 0.25,
    multiples: [4, 6],
    volatility: 0.6,
  },
  approaches: { asset: false, opm_backsolve: true, income: true, market: true },
  currency: 'USD',
};

const PREVIEW = {
  scenario: { equity_value: 10_000_000, fmv_per_share: 1 },
  baseline: BOOT.baseline,
  delta: { equity_value: -10_000_000, fmv_per_share: -1 },
  currency: 'USD',
};

const SAVED_BEAR = {
  id: '01JSCENARIOAAAAAAAAAAAAAAA',
  name: 'Bear case',
  label: 'bear',
  inputs: { discount_rate: 0.5 },
  equity_value: '10000000',
  fmv_per_share: '1',
  created_at: '2026-07-02T00:00:00Z',
};

const emptyList = { scenarios: [], baseline: BOOT.baseline, currency: 'USD', max_scenarios: 12 };

function WithWorkspace() {
  return <Outlet context={{ valuation, reload: async () => {} }} />;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/scenarios']}>
      <Routes>
        <Route element={<WithWorkspace />}>
          <Route path="/scenarios" element={<ScenariosTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Routes the sandbox boot, preview, and saved-scenario endpoints. */
function mockApi(overrides: { boot?: unknown; list?: unknown } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes('/scenarios/baseline')) return jsonResponse(overrides.boot ?? BOOT);
    if (path.includes('/scenarios/preview')) return jsonResponse(PREVIEW);
    if (init?.method === 'POST') return jsonResponse({ scenario: SAVED_BEAR }, 201);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse(overrides.list ?? emptyList);
  });
}

describe('ScenariosTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('boots with baseline numbers, knobs, and the read-only note', async () => {
    mockApi();
    renderTab();

    expect(await screen.findByText(/Sandbox only/)).toBeInTheDocument();
    expect(screen.getByText('Scenario FMV / share')).toBeInTheDocument();
    // Baseline values fill the stat cards before any preview.
    expect(screen.getAllByText('$2.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(/Discount rate/)).toHaveValue('25');
    expect(screen.getByLabelText(/Terminal growth rate/)).toHaveValue('3');
    expect(screen.getByLabelText(/Comparable multiples/)).toHaveValue('4, 6');
    expect(screen.getByLabelText(/^Revenue/)).toHaveValue('5000000');
  });

  it('previews after a knob change and shows the delta', async () => {
    const fetchMock = mockApi();
    renderTab();

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await userEvent.type(dr, '50');

    await waitFor(
      () => {
        expect(screen.getByText('$1.00')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getAllByText(/▼/).length).toBeGreaterThanOrEqual(1);

    const post = fetchMock.mock.calls.find(
      ([u, init]) => init?.method === 'POST' && String(u).includes('preview'),
    );
    expect(post).toBeTruthy();
    expect(String(post![0])).toContain(`/valuations/${valuation.id}/scenarios/preview`);
    expect(JSON.parse(String(post![1]!.body))).toEqual({ discount_rate: 0.5 });
  });

  it('shows an empty state when there is no baseline calculation', async () => {
    mockApi({
      boot: { baseline: null, defaults: null, approaches: null, currency: 'USD' },
      list: { scenarios: [], baseline: null, currency: 'USD', max_scenarios: 12 },
    });
    renderTab();
    expect(await screen.findByText('No calculation to explore yet')).toBeInTheDocument();
  });

  it('saves the current knobs as a named scenario (§5.7)', async () => {
    const fetchMock = mockApi();
    renderTab();

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await userEvent.type(dr, '50');

    await userEvent.type(screen.getByLabelText('Scenario name'), 'Bear case');
    await userEvent.selectOptions(screen.getByLabelText('Scenario label'), 'bear');
    await userEvent.click(screen.getByRole('button', { name: 'Save scenario' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) => init?.method === 'POST' && String(u).endsWith('/scenarios'),
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body))).toEqual({
        discount_rate: 0.5,
        name: 'Bear case',
        label: 'bear',
      });
    });
  });

  it('renders the side-by-side comparison with deltas and supports delete', async () => {
    const fetchMock = mockApi({
      list: { scenarios: [SAVED_BEAR], baseline: BOOT.baseline, currency: 'USD', max_scenarios: 12 },
    });
    renderTab();

    const table = await screen.findByTestId('scenario-comparison');
    expect(table).toHaveTextContent('Baseline (official)');
    expect(table).toHaveTextContent('Bear case');
    expect(table).toHaveTextContent('bear');
    expect(table).toHaveTextContent('$1.00'); // scenario FMV/share
    expect(table).toHaveTextContent('$10,000,000'); // scenario equity vs 20M baseline
    expect(table).toHaveTextContent('▼'); // negative delta badge

    await userEvent.click(screen.getByRole('button', { name: 'Delete scenario Bear case' }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(String(del![0])).toContain(`/scenarios/${SAVED_BEAR.id}`);
    });
  });

  it('disables saving until a name is entered', async () => {
    mockApi();
    renderTab();
    const button = await screen.findByRole('button', { name: 'Save scenario' });
    expect(button).toBeDisabled();
  });
});
