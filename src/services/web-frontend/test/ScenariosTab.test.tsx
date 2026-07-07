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

describe('ScenariosTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('boots with baseline numbers, knobs, and the read-only note', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(BOOT));
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse(PREVIEW);
      return jsonResponse(BOOT);
    });
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

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(String(post![0])).toContain(`/valuations/${valuation.id}/scenarios/preview`);
    expect(JSON.parse(String(post![1]!.body))).toEqual({ discount_rate: 0.5 });
  });

  it('shows an empty state when there is no baseline calculation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ baseline: null, defaults: null, approaches: null, currency: 'USD' }),
    );
    renderTab();
    expect(await screen.findByText('No calculation to explore yet')).toBeInTheDocument();
  });
});
