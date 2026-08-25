import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { BridgeTab } from '../src/pages/valuation/BridgeTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JBRIDGE000000000000000001',
  kind: '409a',
  state: 'completed',
  company_name: 'Acme Robotics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const CANDIDATES = [
  {
    id: '01JPRIOR0000000000000000001',
    number: 'V-2025-004',
    created_at: '2025-10-01T10:00:00Z',
    fmv_per_share: '1.10',
  },
  {
    id: '01JPRIOR0000000000000000002',
    number: 'V-2025-001',
    created_at: '2025-02-01T10:00:00Z',
    fmv_per_share: null,
  },
];

const BRIDGE = {
  bridge: {
    from_fmv: 1.1,
    to_fmv: 1.65,
    delta: 0.55,
    pct_change: 0.5,
    factors: [
      { key: 'revenue', label: 'Revenue growth', from: 4, to: 6, contribution: 0.4 },
      { key: 'dlom', label: 'DLOM', from: 0.25, to: 0.22, contribution: 0.15 },
    ],
    drivers: [
      { key: 'equity_value', label: 'Equity value', from: 11_000_000, to: 16_500_000, delta: 5_500_000 },
      { key: 'dlom', label: 'DLOM', from: 0.25, to: 0.22, delta: -0.03 },
      { key: 'volatility', label: 'Volatility', from: null, to: 0.62, delta: null },
      { key: 'revenue_ntm', label: 'NTM revenue multiple', from: 4.2, to: 5.1, delta: 0.9 },
    ],
    decomposable: true,
  },
  from: { number: 'V-2025-004', created_at: '2025-10-01T10:00:00Z' },
  to: { number: 'V-2026-002', created_at: '2026-07-01T10:00:00Z' },
  company_name: 'Acme Robotics',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function mockApi(options: { candidates?: unknown[]; bridge?: () => Response; bridgeable?: boolean } = {}) {
  const { candidates = CANDIDATES, bridge = () => jsonResponse(BRIDGE), bridgeable } = options;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    // `bridgeable` omitted is a reply from a build that predates the flag.
    if (path.includes('/bridge-candidates')) {
      return jsonResponse(bridgeable === undefined ? { candidates } : { candidates, bridgeable });
    }
    if (path.includes('/bridge/')) return bridge();
    // The roll-forward panel shares this tab and loads itself; it has its own
    // suite (RollforwardPanel.test.tsx), so an empty state is enough here.
    if (path.endsWith('/rollforward')) {
      return jsonResponse({
        runs: [],
        applied_anchor: null,
        new_valuation_date: '2026-07-01',
        rolling_forward: false,
        can_edit: true,
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
}

/** The bridge calls only — the panel's own traffic is not this suite's subject. */
const bridgeCalls = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('/bridge'));

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/bridge']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/bridge" element={<BridgeTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('BridgeTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the company the bridge is drawn against', async () => {
    mockApi();
    renderTab();
    await screen.findByLabelText('Compare against');
    expect(screen.getByText(/Acme Robotics/)).toBeInTheDocument();
  });

  it('lists each candidate with its number, date and prior FMV', async () => {
    mockApi();
    renderTab();
    const select = await screen.findByLabelText('Compare against');

    const options = within(select).getAllByRole('option');
    expect(options[0]).toHaveTextContent(/Select an earlier valuation/);
    expect(options[1]).toHaveTextContent('V-2025-004');
    expect(options[1]).toHaveTextContent('$1.10');
    // A candidate with no concluded FMV is still selectable — the bridge is
    // built server-side and may still have a figure to compare.
    expect(options[2]).toHaveTextContent('V-2025-001');
    expect(options[2]!.textContent).not.toContain('$');
  });

  it('says so when the company has no other valuation to bridge from', async () => {
    mockApi({ candidates: [] });
    renderTab();
    await screen.findByText(/No comparable valuations yet/i);
    expect(screen.queryByLabelText('Compare against')).not.toBeInTheDocument();
  });

  it('reports a failed candidate load', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderTab();
    await screen.findByText(/Could not load comparable valuations/i);
    // The roll-forward panel shares the tab and fails its own load a tick
    // later; wait for it to settle before claiming nothing is still spinning.
    await screen.findByText('Could not load the roll-forward.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('builds no bridge until a comparison is chosen', async () => {
    const fetchSpy = mockApi();
    renderTab();
    await screen.findByLabelText('Compare against');
    expect(bridgeCalls(fetchSpy)).toEqual([`/api/v1/valuations/${valuation.id}/bridge-candidates`]);
    expect(screen.queryByTestId('bridge-result')).not.toBeInTheDocument();
  });

  it('fetches and renders the bridge for the selected prior valuation', async () => {
    const fetchSpy = mockApi();
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);

    await screen.findByTestId('bridge-result');
    expect(bridgeCalls(fetchSpy)[1]).toBe(`/api/v1/valuations/${valuation.id}/bridge/${CANDIDATES[0]!.id}`);
    const result = within(screen.getByTestId('bridge-result'));
    expect(result.getByText('From (V-2025-004)')).toBeInTheDocument();
    expect(result.getByText('To (V-2026-002)')).toBeInTheDocument();
    // The waterfall repeats the opening figure as its baseline bar, so the
    // prior FMV legitimately appears twice.
    // The waterfall repeats the opening and closing figures as its bars, so
    // both legitimately appear more than once.
    expect(result.getAllByText('$1.10').length).toBeGreaterThan(0);
    expect(result.getAllByText('$1.65').length).toBeGreaterThan(0);
  });

  it('signs the change so a rise is never mistaken for a fall', async () => {
    mockApi();
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');
    expect(screen.getByText('+$0.55')).toBeInTheDocument();
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
  });

  it('signs a fall too', async () => {
    mockApi({
      bridge: () =>
        jsonResponse({
          ...BRIDGE,
          bridge: { ...BRIDGE.bridge, to_fmv: 0.9, delta: -0.2, pct_change: -0.1818 },
        }),
    });
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');
    // `money` carries the minus inside the figure; the "+" prefix is added
    // only for a rise, so a fall never reads as one.
    expect(screen.getByText('$-0.20')).toBeInTheDocument();
    expect(screen.getByText('-18.2%')).toBeInTheDocument();
  });

  it('omits the percentage when there is no meaningful base to divide by', async () => {
    mockApi({
      bridge: () => jsonResponse({ ...BRIDGE, bridge: { ...BRIDGE.bridge, pct_change: null } }),
    });
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');
    expect(screen.queryByText('% change')).not.toBeInTheDocument();
    // The absolute change is still reported (the drivers table also has a
    // "Change" header, so both are expected).
    expect(screen.getAllByText('Change')).toHaveLength(2);
  });

  it('formats each driver in its own units', async () => {
    mockApi();
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');

    // A rate is a percentage, a value is money, and a multiple is a bare
    // number — showing 0.22 next to 16,500,000 in the same column would make
    // the table unreadable.
    const dlom = screen.getAllByText('DLOM').at(-1)!.closest('tr')!;
    expect(dlom).toHaveTextContent('25.0%');
    expect(dlom).toHaveTextContent('22.0%');
    expect(dlom).toHaveTextContent('-3.0%');

    const equity = screen.getByText('Equity value').closest('tr')!;
    expect(equity).toHaveTextContent('$11,000,000');
    expect(equity).toHaveTextContent('$16,500,000');

    const multiple = screen.getByText('NTM revenue multiple').closest('tr')!;
    expect(multiple).toHaveTextContent('4.20');
    expect(multiple).toHaveTextContent('5.10');
  });

  it('renders a dash for a driver that has no prior value to compare against', async () => {
    mockApi();
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');

    const volatility = screen.getByText('Volatility').closest('tr')!;
    expect(volatility).toHaveTextContent('—');
    expect(volatility).toHaveTextContent('62.0%');
  });

  it('explains why no waterfall is drawn when the walk cannot be decomposed', async () => {
    mockApi({
      bridge: () => jsonResponse({ ...BRIDGE, bridge: { ...BRIDGE.bridge, decomposable: false } }),
    });
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');

    await screen.findByText(/factor attribution isn't available/i);
    expect(screen.queryByText('Per-share FMV bridge')).not.toBeInTheDocument();
    // The drivers table still stands — the raw deltas do not depend on the
    // attribution being possible.
    expect(screen.getByText('Equity value')).toBeInTheDocument();
  });

  it('surfaces a refused bridge and shows no stale result', async () => {
    mockApi({ bridge: () => problem(409, 'the prior valuation has no concluded FMV') });
    renderTab();
    await userEvent.selectOptions(await screen.findByLabelText('Compare against'), CANDIDATES[0]!.id);
    await screen.findByText('the prior valuation has no concluded FMV');
    expect(screen.queryByTestId('bridge-result')).not.toBeInTheDocument();
  });

  it('clears the bridge when the comparison is deselected', async () => {
    mockApi();
    renderTab();
    const select = await screen.findByLabelText('Compare against');
    await userEvent.selectOptions(select, CANDIDATES[0]!.id);
    await screen.findByTestId('bridge-result');

    await userEvent.selectOptions(select, '');
    await waitFor(() => expect(screen.queryByTestId('bridge-result')).not.toBeInTheDocument());
  });
});

/**
 * Two bridges in flight.
 *
 * "Compare against" is a dropdown an analyst flips through, and nothing orders
 * the replies. The stale one draws the decomposition against the comparable
 * they just left — from-FMV, to-FMV, every factor contribution — under the
 * label of the one now selected. A value bridge is a causal claim about which
 * assumptions moved the number, so attributing it to the wrong prior valuation
 * is not a cosmetic mismatch.
 */
describe('BridgeTab — the comparable that replies late', () => {
  beforeEach(() => vi.restoreAllMocks());

  function deferBridges() {
    const pending: Array<{ url: string; resolve: (res: Response) => void }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/bridge-candidates')) return jsonResponse({ candidates: CANDIDATES });
      if (path.includes('/bridge/')) {
        return new Promise<Response>((res) => pending.push({ url: path, resolve: res }));
      }
      if (path.endsWith('/rollforward')) {
        return jsonResponse({
          runs: [],
          applied_anchor: null,
          new_valuation_date: '2026-07-01',
          rolling_forward: false,
          can_edit: true,
        });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    return pending;
  }

  const bridgeFrom = (number: string) => ({ ...BRIDGE, from: { ...BRIDGE.from, number } });

  it('draws the bridge for the selected comparable, not the one that replied last', async () => {
    const user = userEvent.setup();
    const pending = deferBridges();
    renderTab();

    const select = await screen.findByLabelText('Compare against');
    await user.selectOptions(select, CANDIDATES[0]!.id);
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.selectOptions(select, CANDIDATES[1]!.id);
    await waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[0]!.url).toContain(CANDIDATES[0]!.id);
    expect(pending[1]!.url).toContain(CANDIDATES[1]!.id);

    pending[1]!.resolve(jsonResponse(bridgeFrom('V-SELECTED')));
    await screen.findAllByText(/V-SELECTED/);
    pending[0]!.resolve(jsonResponse(bridgeFrom('V-ABANDONED')));

    await waitFor(() => expect(screen.getAllByText(/V-SELECTED/).length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/V-ABANDONED/)).toHaveLength(0);
  });

  it('does not report a failure the abandoned bridge ran into', async () => {
    const user = userEvent.setup();
    const pending = deferBridges();
    renderTab();

    const select = await screen.findByLabelText('Compare against');
    await user.selectOptions(select, CANDIDATES[0]!.id);
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.selectOptions(select, CANDIDATES[1]!.id);
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]!.resolve(jsonResponse(bridgeFrom('V-SELECTED')));
    await screen.findAllByText(/V-SELECTED/);
    pending[0]!.resolve(problem(409, 'That valuation has no completed calculation.'));

    await waitFor(() => expect(screen.getAllByText(/V-SELECTED/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/no completed calculation/)).toBeNull();
  });

  /*
   * A specialty engine writes its result under `results.specialty` and none of
   * the four factors the bridge attributes across exist in it — but it does
   * fill the calculation's typed `fmv_per_share` column, which is what the
   * candidate list used to qualify on. So the tab offered the run, the click
   * returned a 500, and the empty state told a firm to wait for a comparable
   * valuation that would never be offered.
   */
  describe('a kind the bridge cannot explain', () => {
    it('says the kind is the reason, not that none exist yet', async () => {
      mockApi({ candidates: [], bridgeable: false });
      renderTab();

      await screen.findByText(/Not what this bridge explains/i);
      expect(screen.queryByText(/No comparable valuations yet/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Compare against')).not.toBeInTheDocument();
    });

    it('keeps the "none yet" wording when the server sends no flag', async () => {
      mockApi({ candidates: [] });
      renderTab();

      await screen.findByText(/No comparable valuations yet/i);
      expect(screen.queryByText(/Not what this bridge explains/i)).not.toBeInTheDocument();
    });

    it('still offers the picker when the kind is bridgeable', async () => {
      mockApi({ bridgeable: true });
      renderTab();

      expect(await screen.findByLabelText('Compare against')).toBeInTheDocument();
      expect(screen.queryByText(/Not what this bridge explains/i)).not.toBeInTheDocument();
    });
  });
});
