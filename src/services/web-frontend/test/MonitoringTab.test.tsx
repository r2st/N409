import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { MonitoringTab } from '../src/pages/valuation/MonitoringTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JMONITOR00000000000000001',
  kind: '409a',
  state: 'completed',
  company_name: 'Acme Robotics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const BASELINE = {
  valuation_date: '2026-01-01',
  annual_revenue: 4_000_000,
  fully_diluted_shares: 10_000_000,
  last_round_date: '2025-06-01',
};

const OFF = { monitor: null, status: 'green' as const, triggers: [], monitorable: true };
const NOT_MONITORABLE = { ...OFF, monitorable: false };

const ON_GREEN = {
  monitor: { enabled: true, baseline: BASELINE, last_checked_at: '2026-07-01T09:00:00Z' },
  current: BASELINE,
  status: 'green' as const,
  triggers: [],
};

const ON_RED = {
  monitor: { enabled: true, baseline: BASELINE, last_checked_at: '2026-07-01T09:00:00Z' },
  current: { ...BASELINE, annual_revenue: 9_000_000, last_round_date: '2026-06-01' },
  status: 'red' as const,
  triggers: [
    { type: 'funding_round', level: 'red' as const, message: 'A Series B closed on 2026-06-01.' },
    { type: 'revenue_change', level: 'yellow' as const, message: 'Revenue is up 125% on baseline.' },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function mockApi(view: unknown, onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(String(url), init!);
      return jsonResponse({ ok: true });
    }
    return jsonResponse(view);
  });
}

/** Stands in for the valuation workspace the roll-forward navigates to. */
function Landed() {
  const { id } = useParams();
  return <div data-testid="landed">{id}</div>;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/monitor']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/monitor" element={<MonitoringTab />} />
        </Route>
        <Route path="/valuations/:id" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MonitoringTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers to enable monitoring on a valuation that qualifies', async () => {
    mockApi(OFF);
    renderTab();
    await screen.findByRole('button', { name: /Enable monitoring/i });
    expect(screen.getByText(/safe-harbor expiry/i)).toBeInTheDocument();
  });

  it('refuses to offer monitoring on a valuation that is not complete', async () => {
    // Monitoring a draft would be watching for drift from a number nobody has
    // concluded on.
    mockApi(NOT_MONITORABLE);
    renderTab();
    await screen.findByText(/Not ready to monitor/i);
    expect(screen.queryByRole('button', { name: /Enable monitoring/i })).not.toBeInTheDocument();
  });

  it('enables monitoring and reloads', async () => {
    const writes: string[] = [];
    mockApi(OFF, (path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Enable monitoring/i }));
    await waitFor(() => expect(writes).toEqual([`POST /api/v1/valuations/${valuation.id}/monitor`]));
  });

  it('reports a refused enable rather than leaving the button apparently inert', async () => {
    mockApi(OFF, () => problem(409, 'monitoring requires a completed valuation'));
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Enable monitoring/i }));
    await screen.findByText('monitoring requires a completed valuation');
  });

  it('reads all-clear with no triggers, and offers no roll-forward', async () => {
    mockApi(ON_GREEN);
    renderTab();
    await screen.findByText('All clear');
    expect(screen.getByText(/still current/i)).toBeInTheDocument();
    // Rolling forward a valuation nothing has invalidated is work for nothing.
    expect(screen.queryByRole('button', { name: /Start new valuation/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disable monitoring/i })).toBeInTheDocument();
  });

  it('lists each trigger with its type read as prose', async () => {
    mockApi(ON_RED);
    renderTab();
    await screen.findByText('Revaluation suggested');
    expect(screen.getByText('funding round:')).toBeInTheDocument();
    expect(screen.getByText(/A Series B closed on 2026-06-01/)).toBeInTheDocument();
    expect(screen.getByText('revenue change:')).toBeInTheDocument();
  });

  it('separates a red trigger from a yellow one visually', async () => {
    mockApi(ON_RED);
    renderTab();
    await screen.findByText('Revaluation suggested');

    const red = screen.getByText('funding round:').closest('li')!;
    const yellow = screen.getByText('revenue change:').closest('li')!;
    expect(red.className).toContain('red');
    expect(yellow.className).toContain('amber');
  });

  it('puts baseline beside current so the drift is legible', async () => {
    mockApi(ON_RED);
    renderTab();
    await screen.findByText('Baseline vs current');

    const revenue = screen.getByText('Annual revenue').closest('tr')!;
    expect(revenue).toHaveTextContent('4000000');
    expect(revenue).toHaveTextContent('9000000');
    // An absent figure reads as a dash, not as zero.
    const shares = screen.getByText('Fully diluted shares').closest('tr')!;
    expect(shares).toHaveTextContent('10000000');
  });

  it('renders a dash where a snapshot figure was never captured', async () => {
    mockApi({
      ...ON_GREEN,
      monitor: {
        enabled: true,
        baseline: { ...BASELINE, annual_revenue: null, last_round_date: null },
        last_checked_at: null,
      },
      current: { ...BASELINE, annual_revenue: null, last_round_date: null },
    });
    renderTab();
    await screen.findByText('Baseline vs current');
    expect(screen.getByText('Annual revenue').closest('tr')!).toHaveTextContent('—');
    // With no check recorded there is no "checked …" stamp to mislead.
    expect(screen.queryByText(/^checked /)).not.toBeInTheDocument();
  });

  it('rolls forward into the new valuation the server created', async () => {
    mockApi(ON_RED, () => jsonResponse({ valuation: { id: '01JNEWVALUATION0000000001' } }, 201));
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Start new valuation/i }));
    expect(await screen.findByTestId('landed')).toHaveTextContent('01JNEWVALUATION0000000001');
  });

  it('reports a refused roll-forward and re-enables the button', async () => {
    mockApi(ON_RED, () => problem(402, 'the roll-forward requires an active subscription'));
    renderTab();
    const button = await screen.findByRole('button', { name: /Start new valuation/i });
    await userEvent.click(button);
    await screen.findByText('the roll-forward requires an active subscription');
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByTestId('landed')).not.toBeInTheDocument();
  });

  it('disables monitoring', async () => {
    const writes: string[] = [];
    mockApi(ON_GREEN, (path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /Disable monitoring/i }));
    await waitFor(() => expect(writes).toEqual([`DELETE /api/v1/valuations/${valuation.id}/monitor`]));
  });

  it('reports a failed load rather than spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(403, 'monitoring is operations-only'));
    renderTab();
    await screen.findByText('monitoring is operations-only');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
