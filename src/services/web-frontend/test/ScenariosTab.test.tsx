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
    expect(screen.getAllByText('$2.0000').length).toBeGreaterThanOrEqual(1);
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

    const previewPosts = () =>
      fetchMock.mock.calls.filter(([u, init]) => init?.method === 'POST' && String(u).includes('preview'));

    // Previews are debounced, not queued behind the typing. Clearing the field
    // is itself a knob change, and an empty knob is sent as no override at all,
    // so a 400ms gap anywhere between the clear and the last keystroke — which
    // a loaded machine supplies for free — fires an interim preview of the
    // untouched baseline. What the sandbox promises is that the knobs it
    // settles on are the ones it previews, so wait for the last request rather
    // than asserting on the first and hoping there was only one.
    await waitFor(
      () => {
        const last = previewPosts().at(-1);
        expect(last).toBeTruthy();
        expect(JSON.parse(String(last![1]!.body))).toEqual({ discount_rate: 0.5 });
      },
      { timeout: 3000 },
    );
    expect(String(previewPosts().at(-1)![0])).toContain(`/valuations/${valuation.id}/scenarios/preview`);

    // Only now is the $1.0000 on screen necessarily this request's: the stubbed
    // preview answers every body with the same numbers, so the stat card alone
    // cannot tell which request it is showing.
    await waitFor(() => {
      expect(screen.getByText('$1.0000')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/▼/).length).toBeGreaterThanOrEqual(1);
  });

  it('previews the knobs it settled on, not the ones a mid-edit debounce caught', async () => {
    // The case above raced: whether the debounce fired between clearing the
    // field and finishing the number decided how many previews were sent, so
    // the interim preview only appeared on a machine slow enough to pause for
    // 400ms mid-edit. Here the pause is deliberate, which makes the interim
    // preview certain and this the case that actually pins the behaviour: a
    // preview in flight for the empty field must not be what the sandbox is
    // left showing once the edit is complete.
    const fetchMock = mockApi();
    renderTab();

    const previewPosts = () =>
      fetchMock.mock.calls.filter(([u, init]) => init?.method === 'POST' && String(u).includes('preview'));

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);

    // An empty knob is no override, so this one previews the untouched baseline.
    await waitFor(() => {
      expect(previewPosts()).toHaveLength(1);
    });
    expect(JSON.parse(String(previewPosts()[0]![1]!.body))).toEqual({});

    await userEvent.type(dr, '50');

    await waitFor(() => {
      expect(previewPosts().length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(String(previewPosts().at(-1)![1]!.body))).toEqual({ discount_rate: 0.5 });
    });

    await waitFor(() => {
      expect(screen.getByText('$1.0000')).toBeInTheDocument();
    });
    expect(dr).toHaveValue('50');
  });

  it('ignores a slow preview that lands after the one that replaced it', async () => {
    // Two previews are in flight whenever an edit outruns the debounce, and
    // nothing makes the first answer first — the empty-knob preview is the
    // cheap one to ask for and the expensive one to compute, since it runs the
    // full baseline. If a stale answer is allowed to land, the sandbox settles
    // on numbers for knobs the client can see they are no longer holding, which
    // in a tool whose whole purpose is "what would this change do" is the one
    // failure that matters. Responses are resolved here in the wrong order on
    // purpose; the request the client settled on has to win regardless.
    let releaseStale: (() => void) | undefined;
    const stalePosted = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.includes('/scenarios/baseline')) return jsonResponse(BOOT);
      if (path.includes('/scenarios/preview')) {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
        // The empty-knob preview is held open until the later one has answered.
        if (Object.keys(body).length === 0) {
          await stalePosted;
          return jsonResponse({
            scenario: BOOT.baseline,
            baseline: BOOT.baseline,
            delta: { equity_value: 0, fmv_per_share: 0 },
            currency: 'USD',
          });
        }
        return jsonResponse(PREVIEW);
      }
      if (init?.method === 'POST') return jsonResponse({ scenario: SAVED_BEAR }, 201);
      return jsonResponse(emptyList);
    });

    renderTab();

    const previewPosts = () =>
      fetchMock.mock.calls.filter(([u, init]) => init?.method === 'POST' && String(u).includes('preview'));

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await waitFor(() => {
      expect(previewPosts()).toHaveLength(1);
    });

    await userEvent.type(dr, '50');
    await waitFor(() => {
      expect(screen.getByText('$1.0000')).toBeInTheDocument();
    });

    // Only now does the baseline preview answer, out of order and obsolete.
    releaseStale!();

    // It must change nothing: $1.0000 is the scenario's, $2.0000 the baseline's.
    await waitFor(() => {
      expect(previewPosts().length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('$1.0000')).toBeInTheDocument();
    expect(screen.getAllByText(/▼/).length).toBeGreaterThanOrEqual(1);
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
    expect(table).toHaveTextContent('$1.0000'); // scenario FMV/share
    expect(table).toHaveTextContent('$10,000,000'); // scenario equity vs 20M baseline
    expect(table).toHaveTextContent('▼'); // negative delta badge

    await userEvent.click(screen.getByRole('button', { name: 'Delete scenario Bear case' }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(String(del![0])).toContain(`/scenarios/${SAVED_BEAR.id}`);
    });
  });

  /**
   * A case struck against a run that is no longer official has no delta to
   * draw. `scenario − baseline` measures the knobs only while both sides come
   * off the same calculation; once the engagement is recalculated the saved
   * figure answers the old run and the baseline row answers the new one, so
   * their difference is knob plus drift — and a bull case can print red
   * because the baseline moved up underneath it. The saved figures still show;
   * the column that would be wrong does not.
   */
  it('draws no delta for a case whose baseline has been superseded', async () => {
    mockApi({
      list: {
        scenarios: [{ ...SAVED_BEAR, superseded: true }],
        baseline: BOOT.baseline,
        currency: 'USD',
        max_scenarios: 12,
      },
    });
    renderTab();

    const table = await screen.findByTestId('scenario-comparison');
    expect(table).toHaveTextContent('$10,000,000'); // still the figure that was saved
    expect(table).toHaveTextContent('superseded baseline');
    expect(table).not.toHaveTextContent('▼');
    expect(table).not.toHaveTextContent('▲');
  });

  it('disables saving until a name is entered', async () => {
    mockApi();
    renderTab();
    const button = await screen.findByRole('button', { name: 'Save scenario' });
    expect(button).toBeDisabled();
  });
});
