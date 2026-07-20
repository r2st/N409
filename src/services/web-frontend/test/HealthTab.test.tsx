import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { HealthTab } from '../src/pages/valuation/HealthTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const RUN = {
  id: '01JHEALTHAAAAAAAAAAAAAAAAA',
  calculation_id: 'c1',
  severity: 'error' as const,
  blocking: true,
  counts: { ok: 3, info: 0, warning: 1, error: 1 },
  checks: [
    { key: 'weights_sum', category: 'mathematical', label: 'Approach weights sum to 100%', severity: 'error', detail: 'Weights sum to 125.0% — must total 100%' },
    { key: 'dlom_range', category: 'assumptions', label: 'DLOM within market norms', severity: 'warning', detail: 'DLOM 45.0% exceeds the 35% benchmark' },
    { key: 'common_shares_present', category: 'completeness', label: 'Common share count is set', severity: 'ok', detail: '8,000,000 common shares' },
    { key: 'opm_volatility_present', category: 'methodology', label: 'OPM has a volatility input', severity: 'ok', detail: 'OPM volatility 60.0%' },
    { key: 'exit_after_valuation', category: 'temporal', label: 'Expected exit is after the valuation date', severity: 'ok', detail: 'Expected exit is in the future' },
  ],
  created_at: '2026-07-02T00:00:00Z',
};

const RESPONSE = {
  health_checks: [RUN],
  latest_calculation_id: 'c1',
  gate: { satisfied: false, health_check_id: RUN.id, severity: 'error', blocking: true },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/health']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/health" element={<HealthTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('HealthTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows a blocking banner and groups checks by category', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();

    await waitFor(() => expect(screen.getByTestId('health-gate-banner')).toHaveTextContent(/blocked/i));
    expect(screen.getByText('Methodology consistency')).toBeInTheDocument();
    expect(screen.getByText('Assumption reasonableness')).toBeInTheDocument();
    expect(screen.getByText('Data completeness')).toBeInTheDocument();
    expect(screen.getByText('Mathematical consistency')).toBeInTheDocument();
    expect(screen.getByText('Temporal consistency')).toBeInTheDocument();
    expect(screen.getByText(/Weights sum to 125.0%/)).toBeInTheDocument();
  });

  it('runs health checks via POST', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();
    await screen.findByText('Methodology consistency');
    await userEvent.click(screen.getByRole('button', { name: /run health checks/i }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          (c) => String(c[0]).includes('/health-checks') && (c[1] as RequestInit)?.method === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('shows a satisfied banner when nothing blocks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ...RESPONSE,
        health_checks: [{ ...RUN, severity: 'warning', blocking: false }],
        gate: { satisfied: true, health_check_id: RUN.id, severity: 'warning', blocking: false },
      }),
    );
    renderTab();
    await waitFor(() => expect(screen.getByTestId('health-gate-banner')).toHaveTextContent(/Ready to finalize/i));
  });
});
