import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

/**
 * Study *selection* — the half of the two empirical DLOM methods and the
 * studies DLOC method that had no control at all. The columns, the route
 * schema, the engine's blenders and the report exhibits all existed; the only
 * way to say which studies to blend was the API.
 */

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
  dloc_studies: null,
  dloc_statistic: null,
  dloc_study_table: null,
  dlom: null,
  dlom_method: null,
  dlom_methods: null,
  dlom_qualitative: null,
  dlom_studies: null,
  dlom_statistic: null,
  dlom_study_table: null,
  dlom_pre_ipo_studies: null,
  dlom_pre_ipo_table: null,
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

/**
 * Records every PATCH body, and echoes it back as the stored row — the panel
 * reloads its state from the response, so a mock that answered with the
 * unchanged row would look to the form like a save that was ignored.
 */
function mockApi(params: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = { ...PARAMS, ...params };
  const patched: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patched.push(body);
      row = { ...row, ...body };
      return jsonResponse({ params: row });
    }
    if (path.includes('/engine-inputs')) return jsonResponse({ engine_inputs: {} });
    return jsonResponse({ params: row });
  });
  return patched;
}

const saveButton = () => screen.getByRole('button', { name: /save methodology/i });

function onlyPatch(patched: Array<Record<string, unknown>>): Record<string, unknown> {
  expect(patched).toHaveLength(1);
  const body = patched[0];
  if (!body) throw new Error('unreachable');
  return body;
}

/** Selects the DLOM method and waits for the family's picker to appear. */
async function chooseDlom(method: string, testId: string) {
  await userEvent.selectOptions(await screen.findByTestId('dlom-method'), method);
  return screen.findByTestId(testId);
}

describe('ParamsPanel — DLOM study selection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers each family its own set, and only when that family is in play', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dlom-method'), 'chaffee');
    expect(screen.queryByTestId('dlom-studies')).toBeNull();
    expect(screen.queryByTestId('dlom-pre-ipo-studies')).toBeNull();

    await chooseDlom('restricted_stock', 'dlom-studies');
    // The two tables share no study names, so only one picker at a time.
    expect(screen.queryByTestId('dlom-pre-ipo-studies')).toBeNull();

    await chooseDlom('pre_ipo', 'dlom-pre-ipo-studies');
    expect(screen.queryByTestId('dlom-studies')).toBeNull();
  });

  it('shows both pickers when a blend weights both families', async () => {
    mockApi({
      dlom_methods: [
        { method: 'restricted_stock', weight: 0.5 },
        { method: 'pre_ipo', weight: 0.5 },
      ],
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    expect(await screen.findByTestId('dlom-studies')).toBeInTheDocument();
    expect(screen.getByTestId('dlom-pre-ipo-studies')).toBeInTheDocument();
  });

  it('sends null for an untouched set — the engine default — and the names once chosen', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await chooseDlom('restricted_stock', 'dlom-studies');
    expect(screen.getByTestId('dlom-studies-default-note')).toHaveTextContent(
      /Columbia Financial Advisors \(post-amendment\)/,
    );

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dlom_studies).toBeNull();
    expect(onlyPatch(patched).dlom_study_table).toBeNull();

    patched.length = 0;
    await userEvent.click(screen.getByRole('checkbox', { name: /Gelman/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /^Johnson/ }));
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dlom_studies).toEqual(['Gelman', 'Johnson']);
  });

  it('fills the checkboxes from the engine default set on request', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await chooseDlom('pre_ipo', 'dlom-pre-ipo-studies');
    await userEvent.click(screen.getByTestId('dlom-pre-ipo-studies-default-set'));

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dlom_pre_ipo_studies).toEqual([
      'Emory 1997-2000',
      'Emory 1980-2000 (combined)',
      'Willamette 1994-1996',
      'Willamette 1997',
    ]);
  });

  it('loads a stored selection and warns when it straddles the Rule 144 amendment', async () => {
    mockApi({
      dlom_method: 'restricted_stock',
      dlom_studies: ['Gelman', 'Columbia Financial Advisors (post-amendment)'],
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await screen.findByTestId('dlom-studies');
    expect((screen.getByRole('checkbox', { name: /Gelman/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /^Moroney/ }) as HTMLInputElement).checked).toBe(false);
    // 1968-1970 alongside 1997-1998: two different securities in one blend.
    expect(screen.getByTestId('dlom-studies-caveat')).toHaveTextContent(/1997 Rule 144 amendment/);
    // Two studies is under the engine's own THIN_STUDY_SET.
    expect(screen.getByTestId('dlom-studies-thin')).toBeInTheDocument();
  });

  it('flags a pre-IPO window that closed before the modern IPO market', async () => {
    mockApi({ dlom_method: 'pre_ipo', dlom_pre_ipo_studies: ['Emory 1980-1981'] });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await screen.findByTestId('dlom-pre-ipo-studies');
    expect(screen.getByTestId('dlom-pre-ipo-studies-caveat')).toHaveTextContent(/Emory 1980-1981/);
  });

  it('keeps a selection across a method switch, so the set is not retyped', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await chooseDlom('restricted_stock', 'dlom-studies');
    await userEvent.click(screen.getByRole('checkbox', { name: /^Johnson/ }));

    // Away to a model method and back: the engine ignores the configuration
    // while it is not reading it, and so does the form — but it does not
    // discard it, and the save carries it either way.
    await userEvent.selectOptions(screen.getByTestId('dlom-method'), 'chaffee');
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dlom_studies).toEqual(['Johnson']);

    await chooseDlom('restricted_stock', 'dlom-studies');
    expect((screen.getByRole('checkbox', { name: /^Johnson/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('ParamsPanel — custom study tables', () => {
  beforeEach(() => vi.restoreAllMocks());

  it("replaces the engine's table with the firm's own rows", async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await chooseDlom('restricted_stock', 'dlom-studies');
    // A built-in name selected first: switching tables must not carry it over,
    // because the engine resolves names against whichever table it is given.
    await userEvent.click(screen.getByRole('checkbox', { name: /Gelman/ }));
    await userEvent.click(screen.getByTestId('dlom-studies-custom-toggle'));
    expect(screen.queryByRole('checkbox', { name: /Gelman/ })).toBeNull();

    await userEvent.type(screen.getByTestId('dlom-studies-row-0-study'), 'Stout 2020-2024');
    await userEvent.type(screen.getByTestId('dlom-studies-row-0-value'), '0.185');
    await userEvent.click(screen.getByTestId('dlom-studies-add-row'));
    await userEvent.type(screen.getByTestId('dlom-studies-row-1-study'), 'Stout 2015-2019');
    await userEvent.type(screen.getByTestId('dlom-studies-row-1-value'), '0.21');
    await userEvent.click(screen.getByRole('checkbox', { name: /Stout 2020-2024/ }));

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    const body = onlyPatch(patched);
    // Periods left blank are omitted, not sent as null: the route's row schema
    // is strict, and its optional keys are `.optional()`, not `.nullable()`.
    expect(body.dlom_study_table).toEqual([
      { study: 'Stout 2020-2024', discount: 0.185 },
      { study: 'Stout 2015-2019', discount: 0.21 },
    ]);
    expect(body.dlom_studies).toEqual(['Stout 2020-2024']);
  });

  it('refuses a row with no discount, and says which', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await chooseDlom('restricted_stock', 'dlom-studies');
    await userEvent.click(screen.getByTestId('dlom-studies-custom-toggle'));
    await userEvent.type(screen.getByTestId('dlom-studies-row-0-study'), 'Our data');

    expect(screen.getByText(/"Our data" needs a discount/)).toBeInTheDocument();
    await userEvent.click(saveButton());
    expect(patched).toHaveLength(0);

    await userEvent.type(screen.getByTestId('dlom-studies-row-0-value'), '0.19');
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
  });

  it('refuses a table that lists one study twice', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await chooseDlom('pre_ipo', 'dlom-pre-ipo-studies');
    await userEvent.click(screen.getByTestId('dlom-pre-ipo-studies-custom-toggle'));
    await userEvent.type(screen.getByTestId('dlom-pre-ipo-studies-row-0-study'), 'Ours');
    await userEvent.type(screen.getByTestId('dlom-pre-ipo-studies-row-0-value'), '0.4');
    await userEvent.click(screen.getByTestId('dlom-pre-ipo-studies-add-row'));
    await userEvent.type(screen.getByTestId('dlom-pre-ipo-studies-row-1-study'), 'Ours');
    await userEvent.type(screen.getByTestId('dlom-pre-ipo-studies-row-1-value'), '0.5');

    expect(screen.getByText(/"Ours" is listed twice/)).toBeInTheDocument();
  });

  it('loads a stored custom table back into the editor', async () => {
    mockApi({
      dlom_method: 'restricted_stock',
      dlom_study_table: [
        {
          study: 'Stout 2020-2024',
          discount: 0.185,
          period_start: 2020,
          period_end: 2024,
          statistic: 'median',
        },
      ],
      dlom_studies: ['Stout 2020-2024'],
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await screen.findByTestId('dlom-studies-table');
    expect((screen.getByTestId('dlom-studies-row-0-study') as HTMLInputElement).value).toBe(
      'Stout 2020-2024',
    );
    expect((screen.getByTestId('dlom-studies-row-0-value') as HTMLInputElement).value).toBe('0.185');
    expect((screen.getByRole('checkbox', { name: /Stout 2020-2024/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('drops a selection whose row is renamed out from under it', async () => {
    const patched = mockApi({
      dlom_method: 'restricted_stock',
      dlom_study_table: [{ study: 'Ours', discount: 0.19 }],
      dlom_studies: ['Ours'],
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await screen.findByTestId('dlom-studies-table');
    await userEvent.clear(screen.getByTestId('dlom-studies-row-0-study'));
    await userEvent.type(screen.getByTestId('dlom-studies-row-0-study'), 'Ours (v2)');

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    // Sending the old name would earn an "unknown studies" refusal from the
    // engine's pre-flight naming a study nothing on screen mentions.
    expect(onlyPatch(patched).dlom_studies).toBeNull();
    expect(onlyPatch(patched).dlom_study_table).toEqual([{ study: 'Ours (v2)', discount: 0.19 }]);
  });
});

describe('ParamsPanel — DLOC study selection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('appears with the studies derivation and sends the chosen premiums', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dloc-method'), 'control_premium');
    expect(screen.queryByTestId('dloc-studies')).toBeNull();

    await userEvent.selectOptions(screen.getByTestId('dloc-method'), 'studies');
    await screen.findByTestId('dloc-studies');
    await userEvent.click(screen.getByRole('checkbox', { name: /US public targets, 2020s/ }));
    // Every built-in row is a decade summary rather than the year-and-industry
    // extraction an appraiser would cite, and the engine says so on the result.
    expect(screen.getByTestId('dloc-studies-caveat')).toHaveTextContent(/indicative decade medians/);

    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dloc_studies).toEqual(['US public targets, 2020s']);
    expect(onlyPatch(patched).dloc_method).toBe('studies');
  });

  it("takes a firm's own premium rows, without a per-row statistic", async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dloc-method'), 'studies');
    await userEvent.click(await screen.findByTestId('dloc-studies-custom-toggle'));
    // The DLOC row schema is strict and has no `statistic` key — offering one
    // would earn a 422 on a field the analyst was invited to fill in.
    expect(screen.queryByLabelText(/^Statistic 1$/)).toBeNull();

    await userEvent.type(screen.getByTestId('dloc-studies-row-0-study'), 'BVR SIC 7372, 2024');
    await userEvent.type(screen.getByTestId('dloc-studies-row-0-value'), '0.28');
    await userEvent.click(saveButton());
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(onlyPatch(patched).dloc_study_table).toEqual([{ study: 'BVR SIC 7372, 2024', premium: 0.28 }]);
  });

  it('refuses a negative premium — a discount paid for control is not evidence for a DLOC', async () => {
    const patched = mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByTestId('dloc-method'), 'studies');
    await userEvent.click(await screen.findByTestId('dloc-studies-custom-toggle'));
    await userEvent.type(screen.getByTestId('dloc-studies-row-0-study'), 'Odd one');
    await userEvent.type(screen.getByTestId('dloc-studies-row-0-value'), '-0.1');

    expect(screen.getByText(/cannot be negative/)).toBeInTheDocument();
    await userEvent.click(saveButton());
    expect(patched).toHaveLength(0);
  });
});

describe('ParamsPanel — study selection, read-only', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the set without letting a viewer change it', async () => {
    mockApi({ dlom_method: 'restricted_stock', dlom_studies: ['Johnson'] });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={true} />);
    await screen.findByTestId('dlom-studies');
    expect(screen.getByRole('checkbox', { name: /^Johnson/ })).toBeDisabled();
    expect(screen.getByTestId('dlom-studies-custom-toggle')).toBeDisabled();
    expect(screen.queryByTestId('dlom-studies-default-set')).toBeNull();
  });
});
