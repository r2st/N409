import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

/**
 * The engagement-basics fields, the approach weights, the allocation methods
 * other than plain OPM, and the PWERM scenario grid.
 *
 * These are the inputs the report states as the analyst's judgement — the
 * incorporation date the age of the enterprise is computed from, the four
 * approach weights the concluded value is a weighted average of, the exit
 * scenarios a PWERM allocation *is*. A field that silently fails to reach the
 * API is a report that states a default as a conclusion.
 */

const VAL_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const PARAMS = {
  valuation_id: VAL_ID,
  rolling_forward: false,
  inception_date: null,
  fiscal_year_end: null,
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: null,
  dloc_method: null,
  dlom: null,
  dlom_method: null,
  dlom_qualitative: null,
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

interface Setup {
  /** What GET /engine-inputs answers with. */
  engineInputs?: unknown;
  /** Overrides merged into the loaded params row. */
  params?: Record<string, unknown>;
  /** Fail the params PATCH with this problem. */
  patchError?: { status: number; detail: string };
  /** Fail the engine-inputs PATCH with this problem. */
  scenarioError?: { status: number; detail: string };
}

function mockApi(setup: Setup = {}) {
  const patched: Array<{ path: string; body: Record<string, unknown> }> = [];
  const row = { ...PARAMS, ...setup.params };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      patched.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (path.includes('/engine-inputs')) {
        if (setup.scenarioError) return jsonResponse(setup.scenarioError, setup.scenarioError.status);
        return jsonResponse({});
      }
      if (setup.patchError) return jsonResponse(setup.patchError, setup.patchError.status);
      return jsonResponse({ params: row });
    }
    if (path.includes('/engine-inputs')) return jsonResponse(setup.engineInputs ?? { engine_inputs: {} });
    return jsonResponse({ params: row });
  });
  return patched;
}

/** The body of the params PATCH, once it has been sent. */
async function savedBody(patched: Array<{ path: string; body: Record<string, unknown> }>) {
  await waitFor(() => expect(patched.some((p) => p.path.includes('/params'))).toBe(true));
  return patched.find((p) => p.path.includes('/params'))!.body;
}

async function renderPanel(setup: Setup = {}, readOnly = false) {
  const patched = mockApi(setup);
  render(<ParamsPanel valuationId={VAL_ID} readOnly={readOnly} />);
  await screen.findByLabelText('Allocation method');
  return { patched, user: userEvent.setup() };
}

describe('ParamsPanel — engagement basics', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends the four engagement dates the report dates its analysis from', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByLabelText('Inception date'), '2019-03-04');
    await user.type(screen.getByLabelText('Fiscal year end'), '2026-12-31');
    await user.type(screen.getByLabelText('Expected exit'), '2029-06-30');
    await user.type(screen.getByLabelText('Last round date'), '2025-11-15');
    await user.click(screen.getByRole('button', { name: /save methodology/i }));

    expect(await savedBody(patched)).toMatchObject({
      inception_date: '2019-03-04',
      fiscal_year_end: '2026-12-31',
      exit_timeline: '2029-06-30',
      last_round_date: '2025-11-15',
    });
  });

  it('shows the dates already on file, trimmed of the time the API carries', async () => {
    await renderPanel({
      params: {
        inception_date: '2019-03-04T00:00:00.000Z',
        fiscal_year_end: '2026-12-31T00:00:00.000Z',
        exit_timeline: '2029-06-30T00:00:00.000Z',
        last_round_date: '2025-11-15T00:00:00.000Z',
      },
    });
    // A `<input type="date">` refuses a full ISO timestamp and renders blank,
    // so the analyst would see four empty boxes over four populated columns.
    expect(screen.getByLabelText('Inception date')).toHaveValue('2019-03-04');
    expect(screen.getByLabelText('Expected exit')).toHaveValue('2029-06-30');
  });

  /**
   * Money crosses the wire in cents and is typed in whole currency units. A
   * conversion that only runs one way shows $1,200,000 as $12,000 the next
   * time the tab is opened.
   */
  it('converts revenue to cents on the way out and back on the way in', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByTestId('last-year-revenue'), '1200000');
    await user.type(screen.getByTestId('ytd-revenue'), '450000');
    await user.click(screen.getByRole('button', { name: /save methodology/i }));

    expect(await savedBody(patched)).toMatchObject({
      last_year_revenue_cents: 120_000_000,
      ytd_revenue_cents: 45_000_000,
    });
  });

  it('renders stored cents back as whole currency units', async () => {
    await renderPanel({ params: { last_year_revenue_cents: 120_000_000, ytd_revenue_cents: 45_000_050 } });
    expect(screen.getByTestId('last-year-revenue')).toHaveValue(1_200_000);
    // Half a cent of a stored figure still renders — the column is cents, and
    // rounding it away here would show a number the report does not use.
    expect(screen.getByTestId('ytd-revenue')).toHaveValue(450_000.5);
  });

  it('sends an untouched revenue box as null, not zero', async () => {
    const { patched, user } = await renderPanel();
    await user.click(screen.getByRole('button', { name: /save methodology/i }));
    // Zero revenue is a claim about the company; blank is the absence of one.
    expect(await savedBody(patched)).toMatchObject({
      last_year_revenue_cents: null,
      ytd_revenue_cents: null,
      runway_months: null,
    });
  });

  it('refuses a negative revenue at the field, and says which field blocks the save', async () => {
    const { patched, user } = await renderPanel();

    // A number spinner cannot reach a negative, but a paste can.
    await user.type(screen.getByTestId('last-year-revenue'), '-500');
    expect(await screen.findByText('Revenue cannot be negative.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save methodology/i }));
    expect(screen.getByTestId('save-blocked')).toHaveTextContent(
      'Revenue needs fixing before this can be saved.',
    );
    // Blocked means not sent, not sent-and-rejected.
    expect(patched.filter((p) => p.path.includes('/params'))).toHaveLength(0);
  });

  it('sends the company profile selections, and the overview the comparables read', async () => {
    const { patched, user } = await renderPanel();

    await user.selectOptions(screen.getByLabelText('Revenue status'), 'post_revenue');
    await user.selectOptions(screen.getByLabelText('Market metric'), 'ebitda');
    await user.selectOptions(screen.getByLabelText('Market horizon'), 'ntm');
    await user.selectOptions(screen.getByLabelText('Asset method'), 'cost_to_replicate');
    await user.type(screen.getByLabelText('Business overview'), 'Makes industrial sensors.');
    await user.type(screen.getByLabelText('Runway (months)'), '18');
    await user.click(screen.getByRole('button', { name: /save methodology/i }));

    expect(await savedBody(patched)).toMatchObject({
      revenue_status: 'post_revenue',
      market_method: 'ebitda',
      market_horizon: 'ntm',
      asset_method: 'cost_to_replicate',
      business_overview: 'Makes industrial sensors.',
      runway_months: 18,
    });
  });

  it('reports a refused save and does not claim the methodology was stored', async () => {
    const { user } = await renderPanel({ patchError: { status: 409, detail: 'Valuation is published' } });
    await user.click(screen.getByRole('button', { name: /save methodology/i }));

    expect(await screen.findByText('Valuation is published')).toBeInTheDocument();
    expect(screen.queryByText('Methodology saved.')).toBeNull();
  });

  it('confirms a save, and withdraws the confirmation on the next edit', async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole('button', { name: /save methodology/i }));
    expect(await screen.findByText('Methodology saved.')).toBeInTheDocument();

    // Leaving it up over a changed form claims the edit is stored when it is not.
    await user.selectOptions(screen.getByLabelText('Revenue status'), 'pre_revenue');
    expect(screen.queryByText('Methodology saved.')).toBeNull();
  });

  it('reports a failed load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);
    expect(await screen.findByText('Could not load valuation params.')).toBeInTheDocument();
  });

  it('offers a reader without edit rights no save at all', async () => {
    await renderPanel({}, true);
    expect(screen.queryByRole('button', { name: /save methodology/i })).toBeNull();
    expect(screen.getByLabelText('Inception date')).toBeDisabled();
  });
});

describe('ParamsPanel — approach weights', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps the running total, and flags a set that does not sum to one', async () => {
    const { user } = await renderPanel();

    await user.type(screen.getByLabelText('Asset approach weight'), '0.3');
    await user.type(screen.getByLabelText('OPM backsolve weight'), '0.3');

    expect(await screen.findByText('Σ 0.6000')).toBeInTheDocument();
    expect(screen.getByTestId('save-blocked')).toBeInTheDocument();
  });

  /**
   * Sliders move in steps of 0.05 and land off 1.0000 constantly. The button
   * rescales what the analyst chose rather than inventing a split — which is
   * why it is here and emphatically not something the service does on its own.
   */
  it('rescales the chosen weights to exactly one, preserving their proportions', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByLabelText('Asset approach weight'), '0.3');
    await user.type(screen.getByLabelText('Income (DCF) weight'), '0.3');
    await user.click(await screen.findByTestId('normalise-weights'));

    await waitFor(() => expect(screen.getByText('Σ 1.0000')).toBeInTheDocument());
    expect(screen.getByLabelText('Asset approach weight')).toHaveValue(0.5);
    expect(screen.getByLabelText('Income (DCF) weight')).toHaveValue(0.5);

    // And the rescaled set is what saves — the button is not a display trick.
    await user.click(screen.getByRole('button', { name: /save methodology/i }));
    expect(await savedBody(patched)).toMatchObject({
      weight_asset: 0.5,
      weight_income: 0.5,
      weight_opm: 0,
      weight_market: 0,
    });
  });

  /**
   * The residual has to land on a weight big enough to take it (R343, M19).
   *
   * 1 / 1 / 4 / 0 scales to .1667 / .1667 / .6667 — 1.0001 — so absorbing the
   * remainder into the *last* box drove it to -0.0001. Σ then read 1.0000, the
   * rescale button disappeared, and the analyst who had just pressed "Scale to
   * 1.0000" was left holding a field error and no control that would clear it.
   */
  it('never scales a weight below zero when the roundings overshoot', async () => {
    const { user } = await renderPanel();

    await user.type(screen.getByLabelText('Asset approach weight'), '1');
    await user.type(screen.getByLabelText('OPM backsolve weight'), '1');
    await user.type(screen.getByLabelText('Income (DCF) weight'), '4');
    await user.click(await screen.findByTestId('normalise-weights'));

    await waitFor(() => expect(screen.getByText('Σ 1.0000')).toBeInTheDocument());
    expect(screen.getByLabelText('Market (comps) weight')).toHaveValue(0);
    expect(screen.getByLabelText('Income (DCF) weight')).toHaveValue(0.6666);
    expect(screen.queryByTestId('save-blocked')).toBeNull();
  });

  /**
   * The other direction of the same defect: 1 / 1 / 1 / 0 leaves 0.0001 over,
   * which the last box used to absorb — so an approach the analyst weighted at
   * zero came back weighted. The approach weights are disclosed on the report,
   * so that is a method listed on the exhibit that the file says was not used.
   */
  it('leaves an approach the analyst excluded at zero', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByLabelText('Asset approach weight'), '1');
    await user.type(screen.getByLabelText('OPM backsolve weight'), '1');
    await user.type(screen.getByLabelText('Income (DCF) weight'), '1');
    await user.click(await screen.findByTestId('normalise-weights'));

    await waitFor(() => expect(screen.getByText('Σ 1.0000')).toBeInTheDocument());
    expect(screen.getByLabelText('Market (comps) weight')).toHaveValue(0);

    await user.click(screen.getByRole('button', { name: /save methodology/i }));
    expect(await savedBody(patched)).toMatchObject({ weight_market: 0 });
  });

  it('has nothing to rescale when every weight is zero', async () => {
    const { user } = await renderPanel();
    await user.type(screen.getByLabelText('Asset approach weight'), '0');
    // Scaling 0/0/0/0 would have to invent a split out of nothing.
    await waitFor(() => expect(screen.queryByTestId('normalise-weights')).toBeNull());
  });

  it('offers no rescale to a reader without edit rights', async () => {
    await renderPanel({ params: { weight_asset: 0.3, weight_opm: 0.3 } }, true);
    expect(await screen.findByText('Σ 0.6000')).toBeInTheDocument();
    expect(screen.queryByTestId('normalise-weights')).toBeNull();
  });

  it('accepts a set that already sums to one without complaint', async () => {
    await renderPanel({
      params: { weight_asset: 0.25, weight_opm: 0.25, weight_income: 0.5, weight_market: 0 },
    });
    expect(await screen.findByText('Σ 1.0000')).toBeInTheDocument();
    expect(screen.queryByTestId('save-blocked')).toBeNull();
  });

  /**
   * The slider and the number box are two views of one weight. Each carries its
   * own label, so a screen-reader user is not offered "Market (comps)" twice
   * with no way to tell the coarse control from the exact one.
   */
  it('keeps the slider and the number box on the same value', async () => {
    const { user } = await renderPanel();
    await user.type(screen.getByLabelText('Market (comps) weight'), '0.35');
    await waitFor(() => expect(screen.getByLabelText('Market (comps) weight slider')).toHaveValue('0.35'));

    // Each of the four is addressable on its own, both ways.
    for (const label of ['Asset approach', 'OPM backsolve', 'Income (DCF)', 'Market (comps)']) {
      expect(screen.getByLabelText(`${label} weight`)).toBeInTheDocument();
      expect(screen.getByLabelText(`${label} weight slider`)).toBeInTheDocument();
    }
  });
});

describe('ParamsPanel — allocation methods', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('explains CVM where it is chosen, and offers no scenario grid', async () => {
    const { user } = await renderPanel();
    await user.selectOptions(screen.getByLabelText('Allocation method'), 'cvm');
    expect(screen.getByText(/CVM allocates the current equity value/)).toBeInTheDocument();
    expect(screen.queryByTestId('pwerm-scenarios')).toBeNull();
  });

  it('says plainly when Monte Carlo is worth reaching for', async () => {
    const { user } = await renderPanel();
    await user.selectOptions(screen.getByLabelText('Allocation method'), 'monte_carlo');
    expect(screen.getByTestId('monte-carlo-note')).toHaveTextContent(/needs the cap table/);
    expect(screen.queryByTestId('pwerm-scenarios')).toBeNull();
  });

  it('sends the chosen allocation method', async () => {
    const { patched, user } = await renderPanel();
    await user.selectOptions(screen.getByLabelText('Allocation method'), 'cvm');
    await user.click(screen.getByRole('button', { name: /save methodology/i }));
    expect(await savedBody(patched)).toMatchObject({ allocation_method: 'cvm' });
  });

  it('asks for both hybrid legs and flags a pair that does not sum to one', async () => {
    const { user } = await renderPanel();
    await user.selectOptions(screen.getByLabelText('Allocation method'), 'hybrid');

    // It opens on an even split, which sums to one and needs no warning.
    expect(screen.getByTestId('hybrid-weights')).toBeInTheDocument();
    expect(screen.queryByTestId('hybrid-weight-warning')).toBeNull();

    await user.clear(screen.getByLabelText('Hybrid OPM weight'));
    await user.type(screen.getByLabelText('Hybrid OPM weight'), '0.6');
    // 0.6 + 0.5 is a blend that double-counts a tenth of the equity.
    expect(await screen.findByTestId('hybrid-weight-warning')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Hybrid PWERM weight'));
    await user.type(screen.getByLabelText('Hybrid PWERM weight'), '0.4');
    await waitFor(() => expect(screen.queryByTestId('hybrid-weight-warning')).toBeNull());
  });

  it('reads the hybrid weights already saved to engine-inputs', async () => {
    await renderPanel({
      engineInputs: { engine_inputs: { hybrid: { opm_weight: 0.7, pwerm_weight: 0.3 } } },
    });
    await userEvent.selectOptions(screen.getByLabelText('Allocation method'), 'hybrid');
    expect(screen.getByLabelText('Hybrid OPM weight')).toHaveValue(0.7);
    expect(screen.getByLabelText('Hybrid PWERM weight')).toHaveValue(0.3);
  });

  /**
   * Hybrid is one conclusion, not two: the discrete near-term scenarios and the
   * weights they are blended with the OPM under have to land in the same
   * request, or an interrupted save leaves the engine reading scenarios against
   * the previous weights.
   */
  it('saves the hybrid weights together with the scenarios', async () => {
    const { patched, user } = await renderPanel({
      engineInputs: {
        engine_inputs: {
          hybrid: { opm_weight: 0.6, pwerm_weight: 0.4 },
          pwerm: {
            scenarios: [{ name: 'IPO', probability: 1, equity_value: 20_000_000, time_to_exit_years: 3 }],
          },
        },
      },
    });
    await user.selectOptions(screen.getByLabelText('Allocation method'), 'hybrid');
    await user.click(screen.getByRole('button', { name: /save scenarios/i }));

    await waitFor(() => expect(patched.some((p) => p.path.includes('/engine-inputs'))).toBe(true));
    expect(patched.find((p) => p.path.includes('/engine-inputs'))!.body).toMatchObject({
      hybrid: { opm_weight: 0.6, pwerm_weight: 0.4 },
      pwerm: { scenarios: [{ name: 'IPO', probability: 1 }] },
    });
  });

  it('sends no hybrid block from a plain PWERM engagement', async () => {
    const { patched, user } = await renderPanel({
      engineInputs: {
        engine_inputs: {
          pwerm: { scenarios: [{ name: 'IPO', probability: 1, equity_value: 1, time_to_exit_years: 1 }] },
        },
      },
    });
    await user.selectOptions(screen.getByLabelText('Allocation method'), 'pwerm');
    await user.click(screen.getByRole('button', { name: /save scenarios/i }));

    await waitFor(() => expect(patched.some((p) => p.path.includes('/engine-inputs'))).toBe(true));
    expect(patched.find((p) => p.path.includes('/engine-inputs'))!.body).not.toHaveProperty('hybrid');
  });
});

describe('ParamsPanel — PWERM scenario grid', () => {
  beforeEach(() => vi.restoreAllMocks());

  async function openPwerm(setup: Setup = {}, readOnly = false) {
    const ctx = await renderPanel(setup, readOnly);
    await ctx.user.selectOptions(screen.getByLabelText('Allocation method'), 'pwerm');
    return ctx;
  }

  it('starts empty, with nothing to save', async () => {
    await openPwerm();
    expect(screen.getByText(/No scenarios yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save scenarios/i })).toBeDisabled();
  });

  it('adds a blank row and sends every column the analyst filled in', async () => {
    const { patched, user } = await openPwerm();

    await user.click(screen.getByRole('button', { name: 'Add scenario' }));
    await user.type(screen.getByLabelText('Scenario 1 name'), 'Trade sale');
    await user.selectOptions(screen.getByLabelText('Scenario 1 type'), 'acquisition');
    await user.type(screen.getByLabelText('Scenario 1 probability'), '1');
    await user.type(screen.getByLabelText('Scenario 1 exit value'), '35000000');
    await user.type(screen.getByLabelText('Scenario 1 years'), '2.5');
    await user.type(screen.getByLabelText('Scenario 1 discount rate'), '0.22');

    await user.click(screen.getByRole('button', { name: /save scenarios/i }));
    await waitFor(() => expect(patched.some((p) => p.path.includes('/engine-inputs'))).toBe(true));
    expect(patched.find((p) => p.path.includes('/engine-inputs'))!.body).toEqual({
      pwerm: {
        scenarios: [
          {
            name: 'Trade sale',
            type: 'acquisition',
            probability: 1,
            equity_value: 35_000_000,
            time_to_exit_years: 2.5,
            discount_rate: 0.22,
          },
        ],
      },
    });
  });

  it('sends a blank discount rate as null, so the engagement default applies', async () => {
    const { patched, user } = await openPwerm();
    await user.click(screen.getByRole('button', { name: 'Add scenario' }));
    await user.type(screen.getByLabelText('Scenario 1 probability'), '1');
    // The exit value is required (R339): a blank one used to reach the server
    // as a zero, which is why this row now has to carry one to be saved at all.
    await user.type(screen.getByLabelText('Scenario 1 exit value'), '5000000');
    await user.click(screen.getByRole('button', { name: /save scenarios/i }));

    await waitFor(() => expect(patched.some((p) => p.path.includes('/engine-inputs'))).toBe(true));
    const body = patched.find((p) => p.path.includes('/engine-inputs'))!.body as {
      pwerm: { scenarios: Array<Record<string, unknown>> };
    };
    // Null asks for the default; 0 would discount nothing at all.
    expect(body.pwerm.scenarios[0]!.discount_rate).toBeNull();
    expect(body.pwerm.scenarios[0]!.name).toBeNull();
    expect(body.pwerm.scenarios[0]!.type).toBeNull();
  });

  it('removes the row the analyst pointed at, not the last one', async () => {
    const { user } = await openPwerm({
      engineInputs: {
        engine_inputs: {
          pwerm: {
            scenarios: [
              { name: 'IPO', probability: 0.3, equity_value: 50_000_000, time_to_exit_years: 4 },
              { name: 'Trade sale', probability: 0.5, equity_value: 20_000_000, time_to_exit_years: 2 },
              { name: 'Wind-down', probability: 0.2, equity_value: 0, time_to_exit_years: 1 },
            ],
          },
        },
      },
    });

    await user.click(screen.getByLabelText('Remove scenario 2'));
    expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('IPO');
    expect(screen.getByLabelText('Scenario 2 name')).toHaveValue('Wind-down');
    expect(screen.queryByLabelText('Scenario 3 name')).toBeNull();
  });

  it('re-totals the probabilities as rows change, and unblocks the save at one', async () => {
    const { user } = await openPwerm({
      engineInputs: {
        engine_inputs: {
          pwerm: {
            scenarios: [{ name: 'IPO', probability: 0.4, equity_value: 50_000_000, time_to_exit_years: 4 }],
          },
        },
      },
    });

    expect(screen.getByTestId('pwerm-probability-total')).toHaveTextContent('Σp 0.4000');
    expect(screen.getByRole('button', { name: /save scenarios/i })).toBeDisabled();

    await user.clear(screen.getByLabelText('Scenario 1 probability'));
    await user.type(screen.getByLabelText('Scenario 1 probability'), '1');
    await waitFor(() => expect(screen.getByTestId('pwerm-probability-total')).toHaveTextContent('Σp 1.0000'));
    expect(screen.getByRole('button', { name: /save scenarios/i })).toBeEnabled();
  });

  it('reads an enterprise value when the scenario carries no equity value', async () => {
    await openPwerm({
      engineInputs: {
        engine_inputs: {
          pwerm: {
            scenarios: [{ name: 'IPO', probability: 1, enterprise_value: 44_000_000, time_to_exit_years: 3 }],
          },
        },
      },
    });
    expect(screen.getByLabelText('Scenario 1 exit value')).toHaveValue(44_000_000);
  });

  it('confirms a scenario save, and withdraws it on the next edit', async () => {
    const { user } = await openPwerm();
    await user.click(screen.getByRole('button', { name: 'Add scenario' }));
    await user.type(screen.getByLabelText('Scenario 1 probability'), '1');
    await user.type(screen.getByLabelText('Scenario 1 exit value'), '5000000');
    await user.click(screen.getByRole('button', { name: /save scenarios/i }));
    expect(await screen.findByText('Scenarios saved.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Scenario 1 name'), 'IPO');
    expect(screen.queryByText('Scenarios saved.')).toBeNull();
  });

  it('reports a refused scenario save', async () => {
    const { user } = await openPwerm({
      engineInputs: {
        engine_inputs: {
          pwerm: { scenarios: [{ name: 'IPO', probability: 1, equity_value: 1, time_to_exit_years: 1 }] },
        },
      },
      scenarioError: { status: 422, detail: 'Exit value must be positive' },
    });
    await user.click(screen.getByRole('button', { name: /save scenarios/i }));

    expect(await screen.findByText('Exit value must be positive')).toBeInTheDocument();
    expect(screen.queryByText('Scenarios saved.')).toBeNull();
  });

  it('lets a reader without edit rights see the scenarios but change none of them', async () => {
    await openPwerm(
      {
        engineInputs: {
          engine_inputs: {
            pwerm: {
              scenarios: [{ name: 'IPO', probability: 1, equity_value: 50_000_000, time_to_exit_years: 4 }],
            },
          },
        },
        params: { allocation_method: 'pwerm' },
      },
      true,
    );
    expect(screen.getByLabelText('Scenario 1 name')).toBeDisabled();
    expect(screen.queryByLabelText('Remove scenario 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add scenario' })).toBeNull();
  });

  /**
   * A refused engine-inputs read must not take down the whole methodology
   * panel — that part was always right, and is what this case was written for.
   *
   * What it also asserted, until R340, was that the refusal left the scenario
   * table reading "No scenarios yet". Its premise was that the GET is ops-only
   * and 403s for an owner; it is not — only the PATCH is, and the GET guards on
   * `canReadValuation`, which the `/params` read that just succeeded has
   * already passed. So this status is a failure to read a document that may
   * well be populated, and the panel now says so rather than making a claim
   * about the model it could not read. See `ParamsPanelScenarioLoad.test.tsx`.
   */
  it('survives a refused engine-inputs read, and does not call the model empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/engine-inputs')
        ? jsonResponse({ status: 403, detail: 'Forbidden' }, 403)
        : jsonResponse({ params: { ...PARAMS, allocation_method: 'pwerm' } }),
    );
    render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);
    expect(await screen.findByTestId('scenario-load-error')).toBeInTheDocument();
    expect(screen.queryByText(/No scenarios yet/)).toBeNull();
    // The methodology form above it still rendered and is still usable.
    expect(screen.getByLabelText('Allocation method')).toBeInTheDocument();
    expect(screen.queryByText('Could not load valuation params.')).toBeNull();
  });
});
