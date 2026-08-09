import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

const PARAMS = {
  valuation_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  rolling_forward: false,
  inception_date: null,
  fiscal_year_end: null,
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: '0.1',
  dloc_method: null,
  control_premium: null,
  dloc_synergy_share: null,
  dloc_statistic: null,
  dlom: null,
  dlom_method: null,
  dlom_methods: null,
  dlom_qualitative: null,
  dlom_statistic: null,
  revenue_status: null,
  development_stage: null,
  exit_timeline: null,
  last_round_date: null,
  last_year_revenue_cents: null,
  ytd_revenue_cents: null,
  runway_months: null,
  market_method: null,
  market_horizon: null,
  asset_method: null,
  allocation_method: 'opm',
  business_overview: null,
  updated_at: '2026-07-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every PATCH body so a test can assert on what the form would save. */
function mockApi(params: Record<string, unknown> = {}) {
  const row = { ...PARAMS, ...params };
  const patched: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      patched.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ params: row });
    }
    if (path.includes('/engine-inputs')) return jsonResponse({ engine_inputs: {} });
    return jsonResponse({ params: row });
  });
  return patched;
}

const saveButton = () => screen.getByRole('button', { name: /save methodology/i });

/** The body of the only PATCH the form should have sent. `noUncheckedIndexedAccess` */
function onlyPatch(patched: Array<Record<string, unknown>>): Record<string, unknown> {
  expect(patched).toHaveLength(1);
  const body = patched[0];
  if (!body) throw new Error('unreachable');
  return body;
}

/** The nth match, narrowed — the same rule applies to query results. */
function nth<T>(items: T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`expected at least ${i + 1} matches`);
  return item;
}

describe('ParamsPanel — DLOM', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers every DLOM method the engine implements', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    const select = (await screen.findByTestId('dlom-method')) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    // The form used to offer three of the seven; the missing four were
    // reachable only through the API.
    expect(values).toEqual([
      '',
      'chaffee',
      'finnerty',
      'ghaidarov',
      'longstaff',
      'restricted_stock',
      'pre_ipo',
      'qualitative',
    ]);
  });

  it('asks for the qualitative figure, and blocks the save without it', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dlom-method'), 'qualitative');

    await userEvent.click(saveButton());
    expect(patched).toHaveLength(0);
    expect(screen.getByText(/required for the qualitative method/i)).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('dlom-qualitative'), '0.3');
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dlom_method).toBe('qualitative');
    expect(onlyPatch(patched).dlom_qualitative).toBe(0.3);
  });

  it('offers the study statistic only when a study family is selected', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dlom-method'), 'chaffee');
    expect(screen.queryByTestId('dlom-statistic')).toBeNull();

    await userEvent.selectOptions(screen.getByTestId('dlom-method'), 'pre_ipo');
    expect(screen.getByTestId('dlom-statistic')).toBeInTheDocument();
  });

  it('seeds a blend from the concluded method and clears the single form', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dlom-method'), 'longstaff');
    await userEvent.click(screen.getByTestId('dlom-form-blend'));

    // Two legs at 0.5, the first being the method already chosen.
    expect(screen.getByTestId('dlom-blend')).toBeInTheDocument();
    expect(screen.queryByTestId('dlom-method')).toBeNull();

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    // Both halves travel in one request: the CHECK refuses a row carrying a
    // method and a blend, so clearing has to happen in the same save.
    expect(onlyPatch(patched).dlom_method).toBeNull();
    expect(onlyPatch(patched).dlom_methods).toEqual([
      { method: 'longstaff', weight: 0.5 },
      { method: 'finnerty', weight: 0.5 },
    ]);
  });

  it('refuses a blend whose weights do not sum to one', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.click(await screen.findByTestId('dlom-form-blend'));

    const first = nth(screen.getAllByLabelText('Weight'), 0);
    await userEvent.clear(first);
    await userEvent.type(first, '0.4');

    expect(screen.getByText(/must sum to 1\.0000/i)).toBeInTheDocument();
    await userEvent.click(saveButton());
    expect(patched).toHaveLength(0);
  });

  it('refuses a blend that weights one method twice', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.click(await screen.findByTestId('dlom-form-blend'));
    // Both legs on the same method: 0.5 + 0.5 still sums to one, so only the
    // duplicate check catches it.
    await userEvent.selectOptions(nth(screen.getAllByLabelText(/^Method 2$/), 0), 'chaffee');
    expect(screen.getByText(/weighted twice/i)).toBeInTheDocument();
  });

  it('loads an existing blend from the API', async () => {
    mockApi({
      dlom_methods: [
        { method: 'restricted_stock', weight: 0.6 },
        { method: 'chaffee', weight: 0.4 },
      ],
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await screen.findByTestId('dlom-blend');
    expect((screen.getByTestId('dlom-form-blend') as HTMLInputElement).checked).toBe(true);
    // A study family is weighted, so the shared statistic is on offer.
    expect(screen.getByTestId('dlom-statistic')).toBeInTheDocument();
  });
});

describe('ParamsPanel — DLOC', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('defaults to a stated figure and sends no method', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    const select = (await screen.findByTestId('dloc-method')) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.queryByTestId('control-premium')).toBeNull();

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dloc_method).toBeNull();
    expect(onlyPatch(patched).dloc).toBe(0.1);
  });

  it('takes a control premium instead of the discount, and requires it', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dloc-method'), 'control_premium');

    // The engine inverts the premium, so the discount is not the analyst's to
    // type while this derivation is selected.
    expect(screen.getByTestId('dloc')).toBeDisabled();
    await userEvent.click(saveButton());
    expect(patched).toHaveLength(0);

    await userEvent.type(screen.getByTestId('control-premium'), '0.25');
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dloc_method).toBe('control_premium');
    expect(onlyPatch(patched).control_premium).toBe(0.25);
  });

  it('needs the stated discount when the derivation is qualitative', async () => {
    const patched = mockApi({ dloc: null });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dloc-method'), 'qualitative');
    await userEvent.click(saveButton());
    expect(patched).toHaveLength(0);
    expect(screen.getByText(/required for the qualitative method/i)).toBeInTheDocument();
  });

  it('swaps the discount box for the study statistic', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dloc-method'), 'studies');
    // 'studies' concludes the discount itself, so there is nothing to state.
    expect(screen.queryByTestId('dloc')).toBeNull();
    expect(screen.getByTestId('dloc-statistic')).toBeInTheDocument();
  });
});

describe('ParamsPanel — engagement basics', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('round-trips the fields no screen used to offer', async () => {
    const patched = mockApi({
      rolling_forward: true,
      inception_date: '2019-04-02',
      last_year_revenue_cents: 425_000_00,
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await waitFor(() =>
      expect((screen.getByTestId('rolling-forward') as HTMLInputElement).checked).toBe(true),
    );
    // Cents on the wire, whole units in the box.
    expect((screen.getByTestId('last-year-revenue') as HTMLInputElement).value).toBe('425000');

    await userEvent.clear(screen.getByTestId('ytd-revenue'));
    await userEvent.type(screen.getByTestId('ytd-revenue'), '150000');
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).ytd_revenue_cents).toBe(150_000_00);
    expect(onlyPatch(patched).rolling_forward).toBe(true);
    expect(onlyPatch(patched).inception_date).toBe('2019-04-02');
  });
});
