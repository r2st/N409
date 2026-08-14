import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { HealthTab } from '../src/pages/valuation/HealthTab';
import type { Valuation } from '../src/lib/types';

/**
 * The states the health tab spends most of its life in.
 *
 * The banner is the thing to get right: it always speaks about the *latest*
 * calculation, so "no calculation yet", "these checks are of an older
 * calculation" and "passed" are three different sentences and only one of them
 * is the happy path. HealthTab.test.tsx covers that one.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const run = (over: Record<string, unknown> = {}) => ({
  id: '01JHEALTHAAAAAAAAAAAAAAAAA',
  calculation_id: 'c1',
  severity: 'ok' as const,
  blocking: false,
  counts: { ok: 5, info: 0, warning: 0, error: 0 },
  checks: [
    {
      key: 'weights_sum',
      category: 'mathematical',
      label: 'Approach weights sum to 100%',
      severity: 'ok',
      detail: 'Weights total 100%',
    },
  ],
  created_at: '2026-07-02T00:00:00Z',
  ...over,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

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

const banner = () => screen.getByTestId('health-gate-banner');

describe('HealthTab — before there is a calculation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says the checks are not open yet, and does not read as a failure', async () => {
    // Neutral, not red: nothing is blocked, the work simply has not started.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [],
        latest_calculation_id: null,
        gate: { satisfied: false, health_check_id: null, severity: null, blocking: null },
      }),
    );
    renderTab();

    await waitFor(() => expect(banner()).toHaveTextContent(/No completed calculation yet/));
    expect(banner()).not.toHaveTextContent(/blocked/i);
    expect(banner().className).not.toMatch(/red/);
    // Running the checks against nothing is not offered.
    expect(screen.getByRole('button', { name: /Run health checks/i })).toBeDisabled();
    expect(screen.getByText('No health checks yet')).toBeInTheDocument();
  });

  it('offers the empty state once a calculation exists but nothing has been run', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [],
        latest_calculation_id: 'c1',
        gate: { satisfied: false, health_check_id: null, severity: null, blocking: null },
      }),
    );
    renderTab();

    expect(await screen.findByText('No health checks yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run health checks/i })).toBeEnabled();
  });
});

describe('HealthTab — a passing gate', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the verdict rather than only saying it is ready', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [run()],
        latest_calculation_id: 'c1',
        gate: {
          satisfied: true,
          health_check_id: '01JHEALTHAAAAAAAAAAAAAAAAA',
          severity: 'ok',
          blocking: false,
        },
      }),
    );
    renderTab();

    await waitFor(() => expect(banner()).toHaveTextContent('Ready to finalize'));
    expect(banner()).toHaveTextContent('ok verdict');
  });
});

describe('HealthTab — checks that are not of the latest calculation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('marks the run stale, because the banner speaks about the latest one', async () => {
    // A recalculation invalidates a prior run. Without the badge the page shows
    // a green set of checks beside a banner about a calculation they never saw.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [run({ calculation_id: 'c0' })],
        latest_calculation_id: 'c1',
        gate: { satisfied: false, health_check_id: null, severity: null, blocking: null },
      }),
    );
    renderTab();

    expect(await screen.findByText(/stale — checks an older calculation/)).toBeInTheDocument();
  });

  it('does not mark it stale when it is the latest', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [run()],
        latest_calculation_id: 'c1',
        gate: { satisfied: true, health_check_id: null, severity: 'ok', blocking: false },
      }),
    );
    renderTab();

    await screen.findByText('Mathematical consistency');
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });
});

describe('HealthTab — earlier runs', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists the previous runs under the latest, and only when there are some', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [
          run(),
          run({
            id: '01JHEALTHBBBBBBBBBBBBBBBBB',
            severity: 'error',
            counts: { ok: 1, info: 0, warning: 2, error: 3 },
            created_at: '2026-07-01T00:00:00Z',
          }),
        ],
        latest_calculation_id: 'c1',
        gate: { satisfied: true, health_check_id: null, severity: 'ok', blocking: false },
      }),
    );
    renderTab();

    expect(await screen.findByText('History')).toBeInTheDocument();
    expect(screen.getByText(/1 checks · 3 error \/ 2 warning/)).toBeInTheDocument();
  });

  it('omits the history section when the latest run is the only one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        health_checks: [run()],
        latest_calculation_id: 'c1',
        gate: { satisfied: true, health_check_id: null, severity: 'ok', blocking: false },
      }),
    );
    renderTab();

    await screen.findByText('Mathematical consistency');
    expect(screen.queryByText('History')).not.toBeInTheDocument();
  });
});

describe('HealthTab — failures', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replaces the tab with the load failure, rather than an empty checklist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      problem(503, 'Health checks are unavailable.'),
    );
    renderTab();

    expect(await screen.findByText('Health checks are unavailable.')).toBeInTheDocument();
    expect(screen.queryByTestId('health-gate-banner')).not.toBeInTheDocument();
  });

  it('keeps the previous run on screen when a re-run fails', async () => {
    // The failure is about the run that did not happen; the checks already on
    // screen are still the true record of the one that did.
    let posted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        posted = true;
        return problem(409, 'A calculation is still running.');
      }
      return jsonResponse({
        health_checks: [run()],
        latest_calculation_id: 'c1',
        gate: { satisfied: true, health_check_id: null, severity: 'ok', blocking: false },
      });
    });
    renderTab();

    await screen.findByText('Mathematical consistency');
    await userEvent.click(screen.getByRole('button', { name: /Run health checks/i }));

    expect(await screen.findByText('A calculation is still running.')).toBeInTheDocument();
    expect(posted).toBe(true);
    expect(screen.getByText('Mathematical consistency')).toBeInTheDocument();
    expect(banner()).toHaveTextContent('Ready to finalize');
    // And the button is usable again.
    expect(screen.getByRole('button', { name: /Run health checks/i })).toBeEnabled();
  });
});
