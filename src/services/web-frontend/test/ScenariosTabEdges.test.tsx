import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ScenariosTab } from '../src/pages/valuation/ScenariosTab';
import type { Valuation } from '../src/lib/types';

/**
 * The edges of the what-if sandbox: reset, the knobs the happy path never
 * touches, every failure the four endpoints can answer with, and the shapes a
 * boot response is allowed to be missing.
 *
 * Separate from ScenariosTab.test.tsx, which pins the debounce/ordering
 * behaviour of the preview loop, because these share almost none of that
 * file's fixtures — the interesting ones here are the responses it never sends.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const BASELINE = {
  calculation_id: 'c1',
  created_at: '2026-07-01T00:00:00Z',
  equity_value: 20_000_000,
  fmv_per_share: 2,
};

const BOOT = {
  baseline: BASELINE,
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

/** Halves the value — the delta badge reads ▼ $10,000,000. */
const PREVIEW_DOWN = {
  scenario: { equity_value: 10_000_000, fmv_per_share: 1 },
  baseline: BASELINE,
  delta: { equity_value: -10_000_000, fmv_per_share: -1 },
  currency: 'USD',
};

const emptyList = { scenarios: [], baseline: BASELINE, currency: 'USD', max_scenarios: 12 };

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

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Overrides {
  boot?: unknown;
  bootStatus?: number;
  list?: unknown;
  listStatus?: number;
  preview?: unknown;
  previewStatus?: number;
  saveStatus?: number;
  deleteStatus?: number;
}

function mockApi(o: Overrides = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes('/scenarios/baseline')) {
      return o.bootStatus ? problem(o.bootStatus, 'Baseline unavailable.') : jsonResponse(o.boot ?? BOOT);
    }
    if (path.includes('/scenarios/preview')) {
      return o.previewStatus
        ? problem(o.previewStatus, 'That scenario could not be computed.')
        : jsonResponse(o.preview ?? PREVIEW_DOWN);
    }
    if (init?.method === 'POST') {
      return o.saveStatus ? problem(o.saveStatus, 'Scenario limit reached.') : jsonResponse({}, 201);
    }
    if (init?.method === 'DELETE') {
      return o.deleteStatus
        ? problem(o.deleteStatus, 'That scenario is gone.')
        : new Response(null, { status: 204 });
    }
    return o.listStatus ? problem(o.listStatus, 'nope') : jsonResponse(o.list ?? emptyList);
  });
}

/** The POSTed preview bodies, oldest first. */
function previewBodies(mock: ReturnType<typeof mockApi>): Array<Record<string, unknown>> {
  return mock.mock.calls
    .filter(([u, init]) => init?.method === 'POST' && String(u).includes('preview'))
    .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);
}

describe('ScenariosTab — reset', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the knobs back and drops the preview', async () => {
    const fetchMock = mockApi();
    renderTab();

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await userEvent.type(dr, '50');
    await waitFor(() => {
      expect(screen.getByText('$1.00')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Reset to baseline' }));

    expect(dr).toHaveValue('25');
    // The scenario cards fall back to the baseline, and the delta badge goes
    // with them — there is no longer a scenario to be a delta from.
    expect(screen.queryByText('$1.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/▼/)).not.toBeInTheDocument();
    expect(previewBodies(fetchMock)).toHaveLength(1);
  });

  it('does not let a preview already in flight land on top of the reset', async () => {
    // Clearing the debounce timer only stops a preview that has not been sent.
    // One already sent still resolves, and if nothing marks it obsolete it
    // repaints the scenario numbers over knobs the client can see are back at
    // the baseline — a sandbox showing a figure for assumptions that are not on
    // screen, which is the single thing this tab must never do.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.includes('/scenarios/baseline')) return jsonResponse(BOOT);
      if (path.includes('/scenarios/preview')) {
        await held;
        return jsonResponse(PREVIEW_DOWN);
      }
      if (init?.method === 'POST') return jsonResponse({}, 201);
      return jsonResponse(emptyList);
    });

    renderTab();
    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await userEvent.type(dr, '50');

    // The preview is out and unanswered: "Recomputing…" is on screen.
    await waitFor(() => {
      expect(screen.getByText('Recomputing…')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Reset to baseline' }));
    expect(dr).toHaveValue('25');
    // Reset also abandons the request, so nothing is still being computed.
    expect(screen.queryByText('Recomputing…')).not.toBeInTheDocument();

    release!();

    // Give the resolved response every chance to be applied before asserting
    // that it was not: a bare assertion here would pass on a component that
    // simply had not re-rendered yet.
    await waitFor(() => {
      expect(screen.getAllByText('$2.00').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText('$1.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/▼/)).not.toBeInTheDocument();
    expect(screen.queryByText('Recomputing…')).not.toBeInTheDocument();
  });
});

describe('ScenariosTab — the other knobs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends revenue, multiples and the growth rate as the engine expects them', async () => {
    const fetchMock = mockApi();
    renderTab();

    const revenue = await screen.findByLabelText(/^Revenue/);
    await userEvent.clear(revenue);
    await userEvent.type(revenue, '7500000');
    await waitFor(() => {
      expect(previewBodies(fetchMock).at(-1)).toEqual({ revenue: 7_500_000 });
    });

    const multiples = screen.getByLabelText(/Comparable multiples/);
    await userEvent.clear(multiples);
    await userEvent.type(multiples, '3, 5.5 , 9');
    await waitFor(() => {
      // Whitespace around each entry is the user's, not the engine's.
      expect(previewBodies(fetchMock).at(-1)).toEqual({
        revenue: 7_500_000,
        multiples: [3, 5.5, 9],
      });
    });

    const growth = screen.getByLabelText(/Terminal growth rate/);
    await userEvent.clear(growth);
    await userEvent.type(growth, '-2');
    await waitFor(() => {
      // Rates are edited as percentages and sent as decimals. A negative
      // terminal growth rate is an ordinary assumption, unlike a negative
      // discount rate or revenue, so it is not rejected on its way out.
      const last = previewBodies(fetchMock).at(-1)!;
      expect(last.growth_rate).toBeCloseTo(-0.02, 12);
    });
  });

  it('withholds the preview while an assumption is unusable, and says so on save', async () => {
    const fetchMock = mockApi();
    renderTab();

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await userEvent.type(dr, '-5');

    await userEvent.type(screen.getByLabelText('Scenario name'), 'Impossible');
    await userEvent.click(screen.getByRole('button', { name: 'Save scenario' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fix the highlighted assumptions before saving.',
    );
    // Neither the preview nor the save went out with a negative cost of capital.
    expect(previewBodies(fetchMock).every((b) => b.discount_rate === undefined)).toBe(true);
    expect(
      fetchMock.mock.calls.some(([u, init]) => init?.method === 'POST' && String(u).endsWith('/scenarios')),
    ).toBe(false);
  });

  it('rejects revenue that is zero or not a number', async () => {
    const fetchMock = mockApi();
    renderTab();

    const revenue = await screen.findByLabelText(/^Revenue/);
    await userEvent.clear(revenue);
    await userEvent.type(revenue, '0');
    await userEvent.clear(screen.getByLabelText(/Comparable multiples/));
    await userEvent.type(screen.getByLabelText(/Comparable multiples/), '4, oops');

    // 400ms of debounce plus a margin — long enough that a preview would have
    // been sent by now if either entry were going to be accepted.
    await new Promise((r) => setTimeout(r, 700));
    expect(previewBodies(fetchMock).every((b) => Object.keys(b).length === 0)).toBe(true);
  });

  it('says so when no approach on the valuation has an adjustable assumption', async () => {
    mockApi({
      boot: {
        ...BOOT,
        approaches: { asset: true, opm_backsolve: true, income: false, market: false },
      },
    });
    renderTab();

    expect(
      await screen.findByText(/weighted entirely on approaches without adjustable assumptions/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Discount rate/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Revenue/)).not.toBeInTheDocument();
  });

  it('shows every knob when the boot response names no approaches', async () => {
    // `approaches: null` is what an older calculation answers with. Hiding the
    // knobs on it would be the wrong default — the sandbox would look broken.
    mockApi({ boot: { ...BOOT, approaches: null } });
    renderTab();

    expect(await screen.findByLabelText(/Discount rate/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Revenue/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Comparable multiples/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Terminal growth rate/)).toBeInTheDocument();
  });

  it('starts the knobs empty, with example placeholders, when the defaults are blank', async () => {
    mockApi({
      boot: {
        ...BOOT,
        defaults: {
          revenue: null,
          growth_rate: null,
          discount_rate: null,
          multiples: null,
          volatility: null,
        },
      },
    });
    renderTab();

    const revenue = await screen.findByLabelText(/^Revenue/);
    expect(revenue).toHaveValue('');
    expect(revenue).toHaveAttribute('placeholder', 'e.g. 5000000');
    expect(screen.getByLabelText(/Comparable multiples/)).toHaveAttribute('placeholder', 'e.g. 4.5, 6, 8');
    expect(screen.getByLabelText(/Discount rate/)).toHaveAttribute('placeholder', 'e.g. 25');
    expect(screen.getByLabelText(/Terminal growth rate/)).toHaveAttribute('placeholder', 'e.g. 3');
  });
});

describe('ScenariosTab — failures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces a boot failure instead of an empty sandbox', async () => {
    mockApi({ bootStatus: 503 });
    renderTab();
    expect(await screen.findByText('Baseline unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/Sandbox only/)).not.toBeInTheDocument();
  });

  it('surfaces a preview failure and keeps the knobs editable', async () => {
    mockApi({ previewStatus: 422 });
    renderTab();

    const dr = await screen.findByLabelText(/Discount rate/);
    await userEvent.clear(dr);
    await userEvent.type(dr, '50');

    expect(await screen.findByText('That scenario could not be computed.')).toBeInTheDocument();
    // The cards stay on the baseline rather than showing a half-applied figure.
    expect(screen.getAllByText('$2.00').length).toBeGreaterThanOrEqual(1);
    expect(dr).toHaveValue('50');
  });

  it('surfaces a save failure next to the save box', async () => {
    mockApi({ saveStatus: 409 });
    renderTab();

    await userEvent.type(await screen.findByLabelText('Scenario name'), 'Bull case');
    await userEvent.click(screen.getByRole('button', { name: 'Save scenario' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Scenario limit reached.');
    // The name is kept, so the client can retry without retyping it.
    expect(screen.getByLabelText('Scenario name')).toHaveValue('Bull case');
  });

  it('surfaces a delete failure', async () => {
    mockApi({
      list: {
        scenarios: [
          {
            id: '01JSCENARIOAAAAAAAAAAAAAAA',
            name: 'Bear case',
            label: 'bear',
            inputs: {},
            equity_value: '10000000',
            fmv_per_share: '1',
            created_at: '2026-07-02T00:00:00Z',
          },
        ],
        baseline: BASELINE,
        currency: 'USD',
        max_scenarios: 12,
      },
      deleteStatus: 404,
    });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete scenario Bear case' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That scenario is gone.');
  });

  it('hides the comparison rather than failing the tab when the list cannot be read', async () => {
    mockApi({ listStatus: 500 });
    renderTab();

    expect(await screen.findByText(/Sandbox only/)).toBeInTheDocument();
    expect(screen.queryByTestId('scenario-comparison')).not.toBeInTheDocument();
  });
});

describe('ScenariosTab — comparison table', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const scenario = (over: Record<string, unknown>) => ({
    id: '01JSCENARIOAAAAAAAAAAAAAAA',
    name: 'A case',
    label: 'bull',
    inputs: {},
    equity_value: '30000000',
    fmv_per_share: '3',
    created_at: '2026-07-02T00:00:00Z',
    ...over,
  });

  it('marks a scenario above the baseline with an upward delta', async () => {
    mockApi({
      list: { scenarios: [scenario({})], baseline: BASELINE, currency: 'USD', max_scenarios: 12 },
    });
    renderTab();

    const table = await screen.findByTestId('scenario-comparison');
    expect(table).toHaveTextContent('▲');
    expect(table).toHaveTextContent('$10,000,000');
    expect(table).not.toHaveTextContent('▼');
    // The count sits in the section header, above the table.
    expect(screen.getByText('1 of 12')).toBeInTheDocument();
  });

  it('shows a dash rather than a delta when the scenario never produced a value', async () => {
    mockApi({
      list: {
        scenarios: [scenario({ equity_value: null, fmv_per_share: null, label: 'custom' })],
        baseline: BASELINE,
        currency: 'USD',
        max_scenarios: 12,
      },
    });
    renderTab();

    const table = await screen.findByTestId('scenario-comparison');
    expect(table).not.toHaveTextContent('▲');
    expect(table).not.toHaveTextContent('▼');
    expect(table).toHaveTextContent('custom');
  });

  it('shows a dash when the scenario lands exactly on the baseline', async () => {
    mockApi({
      list: {
        scenarios: [scenario({ equity_value: '20000000', fmv_per_share: '2', label: 'base' })],
        baseline: BASELINE,
        currency: 'USD',
        max_scenarios: 12,
      },
    });
    renderTab();

    const table = await screen.findByTestId('scenario-comparison');
    expect(table).not.toHaveTextContent('▲');
    expect(table).not.toHaveTextContent('▼');
  });

  it('omits the baseline row when the list has no baseline to compare against', async () => {
    mockApi({
      list: {
        scenarios: [scenario({})],
        baseline: null,
        currency: 'USD',
        max_scenarios: 12,
      },
    });
    renderTab();

    const table = await screen.findByTestId('scenario-comparison');
    expect(table).not.toHaveTextContent('Baseline (official)');
    expect(table).toHaveTextContent('A case');
    // No baseline is no delta — not a delta against zero.
    expect(table).not.toHaveTextContent('▲');
  });
});
