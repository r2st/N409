import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RollforwardPanel } from '../src/components/valuation/RollforwardPanel';

/**
 * The roll-forward panel.
 *
 * The endpoints behind it shipped without a caller, so this suite is the first
 * thing that exercises the flow end to end from the outside. The assertions
 * follow the two rules the route is built around, and one the panel adds:
 *
 *   * Running and adopting are separate presses. Pressing "Run rollforward"
 *     must not move the anchor the engagement is calculating on.
 *   * The applied anchor and the rolled value are shown together, and a
 *     disagreement between them reads as a disagreement.
 *   * A percentage typed into a percent box is sent as a fraction. 1800 for 18
 *     is the slip that would otherwise reach the engine as an 1800× accretion.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface CalibrationStep {
  step: string;
  value: number;
  annual_rate?: number;
  years?: number;
  factor?: number;
  label?: string;
}

interface MaterialChange {
  field: string;
  material: boolean;
  detail: string;
  delta_pct?: number;
}

interface Run {
  id: string;
  prior_valuation_id: string | null;
  prior_calculation_id: string | null;
  prior_valuation_number: string | null;
  prior_valuation_date: string;
  new_valuation_date: string;
  years_elapsed: number;
  prior_equity_value: number;
  rolled_equity_value: number;
  annual_accretion: number;
  new_round_post_money: number | null;
  calibration_steps: CalibrationStep[];
  material_changes: MaterialChange[];
  requires_full_revaluation: boolean;
  material_change_count: number;
  applied_at: string | null;
  created_at: string;
}

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run-1',
  prior_valuation_id: '01JPRIOR0000000000000000001',
  prior_calculation_id: 'calc-1',
  prior_valuation_number: 'V-2025-004',
  prior_valuation_date: '2025-07-01',
  new_valuation_date: '2026-07-01',
  years_elapsed: 1,
  prior_equity_value: 45_000_000,
  rolled_equity_value: 52_500_000,
  annual_accretion: 0.1667,
  new_round_post_money: null,
  calibration_steps: [
    { step: 'prior_equity_value', value: 45_000_000 },
    { step: 'time_accretion', value: 52_500_000, annual_rate: 0.1667, years: 1, factor: 1.1667 },
  ],
  material_changes: [
    {
      field: 'revenue',
      material: false,
      detail: 'Revenue moved 4%, below the 20% threshold',
      delta_pct: 0.04,
    },
  ],
  requires_full_revaluation: false,
  material_change_count: 0,
  applied_at: null,
  created_at: '2026-07-02T09:00:00.000Z',
  ...over,
});

const CANDIDATES = [
  {
    id: '01JPRIOR0000000000000000001',
    number: 'V-2025-004',
    created_at: '2025-07-01T10:00:00Z',
    fmv_per_share: '1.10',
  },
  {
    id: '01JPRIOR0000000000000000002',
    number: 'V-2024-002',
    created_at: '2024-07-01T10:00:00Z',
    fmv_per_share: null,
  },
];

interface State {
  runs?: Run[];
  applied_anchor?: number | null;
  new_valuation_date?: string | null;
  rolling_forward?: boolean;
  can_edit?: boolean;
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(
  state: State = {},
  opts: {
    loadStatus?: number;
    writeStatus?: number;
    runResult?: Run;
    recalc?: boolean;
    /** Status for `/bridge-candidates` alone — the panel loads it separately. */
    candidatesStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  const body = {
    runs: state.runs ?? [],
    applied_anchor: state.applied_anchor ?? null,
    new_valuation_date: state.new_valuation_date === undefined ? '2026-07-01' : state.new_valuation_date,
    rolling_forward: state.rolling_forward ?? false,
    can_edit: state.can_edit ?? true,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path.includes('/bridge-candidates')) {
      if (opts.candidatesStatus) {
        return jsonResponse({ status: opts.candidatesStatus, detail: 'Nope' }, opts.candidatesStatus);
      }
      return jsonResponse({ candidates: CANDIDATES });
    }
    if (method === 'GET') {
      if (opts.loadStatus) return jsonResponse({ status: opts.loadStatus, detail: 'Nope' }, opts.loadStatus);
      return jsonResponse(body);
    }
    if (opts.writeStatus) {
      return jsonResponse({ status: opts.writeStatus, detail: 'Refused upstream.' }, opts.writeStatus);
    }
    if (path.endsWith('/rollforward')) return jsonResponse({ run: opts.runResult ?? run() }, 201);
    return jsonResponse({ recalculation_required: opts.recalc ?? true });
  });
  return calls;
}

const renderPanel = (props: Partial<React.ComponentProps<typeof RollforwardPanel>> = {}) =>
  render(<RollforwardPanel valuationId="val-1" {...props} />);

/** Choose the first candidate in the prior-valuation dropdown. */
const pickPrior = (id = CANDIDATES[0]!.id) =>
  userEvent.selectOptions(screen.getByLabelText('Prior valuation'), id);

const postBody = (calls: Call[]) =>
  calls.find((c) => c.method === 'POST' && c.path.endsWith('/rollforward'))?.body;

describe('RollforwardPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says no anchor is set and no roll-forward is recorded', async () => {
    mockApi();
    renderPanel();

    await screen.findByText('No anchor set on the engine inputs');
    expect(screen.getByText('No roll-forward recorded')).toBeInTheDocument();
  });

  it('reports the load failure rather than spinning forever', async () => {
    mockApi({}, { loadStatus: 500 });
    renderPanel();

    await screen.findByText('Nope');
    expect(screen.queryByLabelText('Prior valuation')).not.toBeInTheDocument();
  });

  it('offers every completed valuation of the company as the prior one', async () => {
    mockApi();
    renderPanel();

    const select = await screen.findByLabelText('Prior valuation');
    const options = within(select).getAllByRole('option');
    expect(options[0]).toHaveTextContent(/Select the prior valuation/);
    expect(options[1]).toHaveTextContent('V-2025-004');
    expect(options[2]).toHaveTextContent('V-2024-002');
  });

  it('takes the candidate list from its host rather than fetching a second copy', async () => {
    const calls = mockApi();
    renderPanel({ candidates: [CANDIDATES[1]!] });

    const select = await screen.findByLabelText('Prior valuation');
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((c) => c.path.includes('/bridge-candidates'))).toBe(false);
  });

  it('will not run without a prior valuation chosen', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('Choose the prior valuation this engagement rolls forward from.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends only the prior valuation when nothing else is stated, and does not adopt', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText(/Not yet adopted as the backsolve anchor/);
    // Omitting the accretion is what lets the service use the prior appraisal's
    // own concluded cost of capital; sending a default here would override it.
    expect(postBody(calls)).toEqual({ prior_valuation_id: CANDIDATES[0]!.id });
    expect(calls.some((c) => c.path.includes('/apply'))).toBe(false);
  });

  it('states the bridge it just struck, with the rate and the elapsed time', async () => {
    mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText(/\$45,000,000 rolled to \$52,500,000 over 1\.00 years at 16\.7%\./);
  });

  it('sends a typed accretion as a fraction, not as the percentage typed', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.type(screen.getByLabelText(/Annual accretion/), '18.5');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await waitFor(() => expect(postBody(calls)).toBeDefined());
    expect(postBody(calls)).toMatchObject({ annual_accretion: 0.185 });
  });

  it.each([
    ['-100', 'a total wipeout stated as a rate'],
    ['-150', 'below a total wipeout'],
    ['1800', 'a decimal point slipped'],
    ['abc', 'not a number at all'],
  ])('refuses to send an accretion of %s (%s)', async (typed) => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.type(screen.getByLabelText(/Annual accretion/), typed);
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('The annual accretion is a percentage above -100 and no more than 1000.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends a new round post-money with the separators stripped', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.type(screen.getByLabelText(/New round post-money/), '60,000,000');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await waitFor(() => expect(postBody(calls)).toBeDefined());
    expect(postBody(calls)).toMatchObject({ new_round_post_money: 60_000_000 });
  });

  it.each([
    ['0', 'a round priced at nothing'],
    ['-5000000', 'a negative post-money'],
    ['soon', 'not a number at all'],
  ])('refuses to send a new round post-money of %s (%s)', async (typed) => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.type(screen.getByLabelText(/New round post-money/), typed);
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('A new round post-money is an amount above zero.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('sends value adjustments with their percentages as fractions', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 1 label'), 'Lost anchor customer');
    await userEvent.type(screen.getByLabelText('Adjustment 1 percent'), '-15');
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 2 label'), 'Settled litigation');
    await userEvent.type(screen.getByLabelText('Adjustment 2 amount'), '-2,500,000');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await waitFor(() => expect(postBody(calls)).toBeDefined());
    expect(postBody(calls)).toMatchObject({
      value_adjustments: [
        { label: 'Lost anchor customer', pct: -0.15 },
        { label: 'Settled litigation', amount: -2_500_000 },
      ],
    });
  });

  it('refuses an adjustment with no label or no figure', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 1 percent'), '-15');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('Every adjustment needs a label and either a percentage or an amount.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses an adjustment percentage that is a slipped decimal point', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 1 label'), 'Markdown');
    await userEvent.type(screen.getByLabelText('Adjustment 1 percent'), '-9900');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('"Markdown" is a percentage between -99 and 1000.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses an adjustment amount that is not a number', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 1 label'), 'Haircut');
    await userEvent.type(screen.getByLabelText('Adjustment 1 amount'), 'a lot');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('"Haircut" is not an amount.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('removes an adjustment row without disturbing the one beside it', async () => {
    const calls = mockApi();
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 1 label'), 'First');
    await userEvent.type(screen.getByLabelText('Adjustment 1 percent'), '-10');
    await userEvent.click(screen.getByRole('button', { name: 'Add an adjustment' }));
    await userEvent.type(screen.getByLabelText('Adjustment 2 label'), 'Second');
    await userEvent.type(screen.getByLabelText('Adjustment 2 percent'), '-20');

    await userEvent.click(screen.getByRole('button', { name: 'Remove 1' }));

    // The survivor keeps its own values rather than inheriting the dropped
    // row's — the reason the rows are keyed off a counter, not their index.
    expect(screen.getByLabelText('Adjustment 1 label')).toHaveValue('Second');
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await waitFor(() => expect(postBody(calls)).toBeDefined());
    expect(postBody(calls)).toMatchObject({ value_adjustments: [{ label: 'Second', pct: -0.2 }] });
  });

  it('will not offer to run when the engagement states no valuation date', async () => {
    mockApi({ new_valuation_date: null });
    renderPanel();

    await screen.findByText(/This engagement states no valuation date/);
    expect(screen.getByRole('button', { name: 'Run rollforward' })).toBeDisabled();
  });

  it('will not offer to run when the company has no other completed valuation', async () => {
    mockApi();
    renderPanel({ candidates: [] });

    await screen.findByText(/No other valuation of this company has a completed calculation/);
    expect(screen.getByRole('button', { name: 'Run rollforward' })).toBeDisabled();
  });

  it('does not read a failed candidate load as the company having no prior 409A', async () => {
    /*
     * The failure was `.catch(() => setFetched([]))`, and an empty candidate
     * list is not a fact about the request — the panel prints it as a
     * conclusion about the company, and an analyst who reads "no prior
     * concluded equity value to carry forward" stops looking for the prior
     * appraisal and values from scratch.
     */
    mockApi({}, { candidatesStatus: 503 });
    renderPanel();

    await screen.findByText(/list of prior valuations could not be loaded/);
    expect(screen.queryByText(/No other valuation of this company has a completed calculation/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Run rollforward' })).toBeDisabled();
  });

  it('still says nothing to carry forward when the list really is empty', async () => {
    // The other half: the sentence above is correct when it is earned, and the
    // fix must not have made it unreachable.
    mockApi();
    renderPanel({ candidates: [] });

    await screen.findByText(/No other valuation of this company has a completed calculation/);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it('reports a roll-forward the service refused', async () => {
    mockApi({}, { writeStatus: 422 });
    renderPanel();
    await screen.findByText('No roll-forward recorded');

    await pickPrior();
    await userEvent.click(screen.getByRole('button', { name: 'Run rollforward' }));

    await screen.findByText('Refused upstream.');
  });

  it('shows the applied anchor beside the rolled value and calls out the disagreement', async () => {
    mockApi({ runs: [run()], applied_anchor: 45_000_000 });
    renderPanel();

    await screen.findByText(/The engagement anchors on \$45,000,000 against a rolled \$52,500,000/);
    expect(screen.getByText('Applied backsolve anchor')).toBeInTheDocument();
    expect(screen.getByText('Rolled forward')).toBeInTheDocument();
    expect(screen.getByText(/not adopted/)).toBeInTheDocument();
  });

  it('does not cry divergence when the anchor is the rolled value', async () => {
    mockApi({
      runs: [run({ applied_at: '2026-07-03T09:00:00.000Z' })],
      applied_anchor: 52_500_000,
      rolling_forward: true,
    });
    renderPanel();

    await screen.findByText(/inputs\.last_round_post_money/);
    expect(screen.queryByText(/against a rolled/)).not.toBeInTheDocument();
    expect(screen.getByText(/marked as rolling forward/)).toBeInTheDocument();
    expect(screen.getByText('Adopted 2026-07-03')).toBeInTheDocument();
  });

  it('says nothing is adopted, so Exhibit B-2 will not print', async () => {
    mockApi({ runs: [run()] });
    renderPanel();

    await screen.findByText(/No run has been adopted/);
  });

  it('adopts a run and warns that the calculation has not caught up', async () => {
    const calls = mockApi({ runs: [run()], applied_anchor: 45_000_000 }, { recalc: true });
    renderPanel();
    await screen.findByRole('button', { name: 'Adopt run' });

    await userEvent.click(screen.getByRole('button', { name: 'Adopt run' }));

    await screen.findByText(/Adopted \$52,500,000 as the backsolve anchor\. Re-run the calculation/);
    expect(calls.some((c) => c.path.endsWith('/rollforward/run-1/apply'))).toBe(true);
  });

  it('says the calculation already ran on the anchor when no re-run is needed', async () => {
    mockApi({ runs: [run()], applied_anchor: 52_500_000 }, { recalc: false });
    renderPanel();
    await screen.findByRole('button', { name: 'Adopt run' });

    await userEvent.click(screen.getByRole('button', { name: 'Adopt run' }));

    await screen.findByText(/The calculation already ran on this anchor/);
  });

  it('reports an adoption the server refused', async () => {
    mockApi({ runs: [run()] }, { writeStatus: 409 });
    renderPanel();
    await screen.findByRole('button', { name: 'Adopt run' });

    await userEvent.click(screen.getByRole('button', { name: 'Adopt run' }));

    await screen.findByText('Refused upstream.');
  });

  it('prints the calibration trail as running arithmetic', async () => {
    mockApi({
      runs: [
        run({
          calibration_steps: [
            { step: 'prior_equity_value', value: 45_000_000 },
            { step: 'time_accretion', value: 52_500_000, annual_rate: 0.1667, years: 1, factor: 1.1667 },
            { step: 'adjustment', label: 'Lost anchor customer', value: 44_625_000 },
            { step: 'unheard_of', value: 44_625_000 },
          ],
        }),
      ],
    });
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Calibration trail' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Prior concluded equity value',
      'Time accretion',
      // An adjustment names itself; "Adjustment" three times is not a trail.
      'Lost anchor customer',
      // A step the panel has no gloss for prints its own name rather than a gap.
      'unheard_of',
    ]);
    expect(within(rows[1]!).getByText('16.7% for 1.00 years (×1.1667)')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('$44,625,000')).toBeInTheDocument();
  });

  it('keeps the immaterial changes, because the question was asked and answered', async () => {
    mockApi({
      runs: [
        run({
          material_changes: [
            { field: 'revenue', material: true, detail: 'Revenue up 140%', delta_pct: 1.4 },
            { field: 'share_classes', material: false, detail: 'No new class since the prior valuation' },
          ],
          requires_full_revaluation: true,
          material_change_count: 1,
        }),
      ],
    });
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Changes since the prior valuation' });
    expect(within(table).getByText('Revenue')).toBeInTheDocument();
    expect(within(table).getByText('Material')).toBeInTheDocument();
    expect(within(table).getByText('Share classes')).toBeInTheDocument();
    expect(within(table).getByText('Not material')).toBeInTheDocument();
    // A change with no measured move is a dash, not a zero percent.
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[1]!).getAllByRole('cell')[2]?.textContent).toBe('—');
    expect(screen.getByText(/1 material change since the prior valuation/)).toBeInTheDocument();
  });

  it('pluralises the material-change warning', async () => {
    mockApi({
      runs: [run({ requires_full_revaluation: true, material_change_count: 3 })],
    });
    renderPanel();

    await screen.findByText(/3 material changes since the prior valuation/);
  });

  it('lists every run, and marks a superseding round as such', async () => {
    mockApi({
      runs: [
        run({ id: 'run-2', new_round_post_money: 60_000_000, rolled_equity_value: 60_000_000 }),
        run({ id: 'run-1', applied_at: '2026-07-02T09:00:00.000Z', prior_valuation_number: null }),
      ],
    });
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Roll-forward history' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('new round')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('16.7%')).toBeInTheDocument();
    // A prior valuation since deleted still has a date on the run itself.
    expect(within(rows[1]!).getByText('2025-07-01')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Adopted 2026-07-02')).toBeInTheDocument();
    // An adopted run cannot be adopted again.
    expect(within(table).getAllByRole('button', { name: 'Adopt run' })).toHaveLength(1);
  });

  it('shows a reader the bridge without offering to change it', async () => {
    mockApi({ runs: [run()], applied_anchor: 52_500_000, can_edit: false });
    renderPanel();

    await screen.findByRole('table', { name: 'Roll-forward history' });
    expect(screen.queryByRole('button', { name: 'Run rollforward' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adopt run' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Prior valuation')).not.toBeInTheDocument();
  });

  it('renders the engagement currency rather than assuming dollars', async () => {
    mockApi({ runs: [run()], applied_anchor: 52_500_000 });
    renderPanel({ currency: 'EUR' });

    await screen.findByRole('table', { name: 'Roll-forward history' });
    expect(screen.getAllByText(/€52,500,000/).length).toBeGreaterThan(0);
  });
});
