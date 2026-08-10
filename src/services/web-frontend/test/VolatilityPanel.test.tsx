import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VolatilityPanel } from '../src/components/valuation/VolatilityPanel';

/**
 * Where the expected volatility comes from.
 *
 * The panel's whole reason to exist is that sigma used to be a number somebody
 * typed. So the assertions are about provenance, not layout:
 *
 *   * estimating and adopting are separate — pressing "Estimate" must not move
 *     the figure the engagement is calculating on;
 *   * a derivation that exists and disagrees with the applied figure has to be
 *     visible as a disagreement, not two numbers side by side;
 *   * a peer whose price feed failed is in the set and not in the median, so
 *     the count reported after a run is the measured one;
 *   * a pinned percentage is validated before it is sent, because 6200 typed
 *     for 62 is a plausible slip that would otherwise reach the engine.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Estimate {
  id: string;
  method: string;
  periods_per_year: number;
  window_start: string;
  window_end: string;
  time_to_exit_years: number | null;
  recommended: number;
  median_volatility: number | null;
  mean_volatility: number | null;
  min_volatility: number | null;
  max_volatility: number | null;
  coefficient_of_variation: number | null;
  confidence: string;
  manual_override: number | null;
  companies: Array<{ ticker: string; volatility: number; used: boolean; observations?: number }>;
  excluded: Array<{ ticker: string; reason: string }>;
  measured_count: number;
  applied_at: string | null;
  created_at: string;
}

const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  id: 'est-1',
  method: 'historical',
  periods_per_year: 252,
  window_start: '2025-08-01',
  window_end: '2026-08-01',
  time_to_exit_years: 3,
  recommended: 0.62,
  median_volatility: 0.62,
  mean_volatility: 0.64,
  min_volatility: 0.48,
  max_volatility: 0.81,
  coefficient_of_variation: 0.18,
  confidence: 'high',
  manual_override: null,
  companies: [
    { ticker: 'AAA', volatility: 0.48, used: true, observations: 250 },
    { ticker: 'BBB', volatility: 0.81, used: true, observations: 248 },
    { ticker: 'CCC', volatility: 0.9, used: false },
  ],
  excluded: [],
  measured_count: 2,
  applied_at: null,
  created_at: '2026-08-02T10:00:00.000Z',
  ...over,
});

interface State {
  estimates?: Estimate[];
  applied_volatility?: number | null;
  eligible_tickers?: string[];
  can_edit?: boolean;
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(
  state: State,
  opts: { loadStatus?: number; writeStatus?: number; estimateResult?: Estimate; recalc?: boolean } = {},
) {
  const calls: Call[] = [];
  const body = {
    estimates: state.estimates ?? [],
    applied_volatility: state.applied_volatility ?? null,
    eligible_tickers: state.eligible_tickers ?? ['AAA', 'BBB', 'CCC'],
    can_edit: state.can_edit ?? true,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'GET') {
      if (opts.loadStatus) return jsonResponse({ status: opts.loadStatus, detail: 'Nope' }, opts.loadStatus);
      return jsonResponse(body);
    }
    if (opts.writeStatus) {
      return jsonResponse({ status: opts.writeStatus, detail: 'Refused upstream.' }, opts.writeStatus);
    }
    if (path.endsWith('/estimate')) {
      return jsonResponse({ estimate: opts.estimateResult ?? estimate() }, 201);
    }
    return jsonResponse({ recalculation_required: opts.recalc ?? true });
  });
  return calls;
}

const renderPanel = () => render(<VolatilityPanel valuationId="val-1" />);

describe('VolatilityPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says nobody has set a volatility when none is applied', async () => {
    mockApi({});
    renderPanel();

    await screen.findByText('Engine default — nobody has set one');
    expect(screen.getByText('No volatility derivation recorded')).toBeInTheDocument();
  });

  it('reports the load failure rather than spinning forever', async () => {
    mockApi({}, { loadStatus: 500 });
    renderPanel();

    await screen.findByText('Nope');
    expect(screen.queryByText('Estimator')).not.toBeInTheDocument();
  });

  it('sends the chosen estimator and window, and does not adopt the result', async () => {
    const calls = mockApi({});
    renderPanel();
    await screen.findByText('No volatility derivation recorded');

    await userEvent.selectOptions(screen.getByLabelText('Estimator'), 'ewma');
    await userEvent.selectOptions(screen.getByLabelText(/Observation window/), '730');
    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await screen.findByText(/Not yet adopted as the valuation assumption/);
    const post = calls.find((c) => c.path.endsWith('/estimate'));
    expect(post?.body).toEqual({ method: 'ewma', window_days: 730 });
    // Estimating is not adopting: no apply call went out on its own.
    expect(calls.some((c) => c.path.includes('/apply'))).toBe(false);
  });

  it('counts the companies actually measured, not the size of the set', async () => {
    // Three peers were screened in; one feed failed. Reporting "3" would
    // overstate the breadth of a median taken over two.
    mockApi(
      {},
      {
        estimateResult: estimate({
          measured_count: 2,
          excluded: [{ ticker: 'CCC', reason: 'no price history in the window' }],
        }),
      },
    );
    renderPanel();
    await screen.findByText('No volatility derivation recorded');

    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await screen.findByText(/62\.0% from 2 companies\. Not measured: CCC\./);
  });

  it('says "company", singular, when only one peer was measured', async () => {
    mockApi({}, { estimateResult: estimate({ measured_count: 1 }) });
    renderPanel();
    await screen.findByText('No volatility derivation recorded');

    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await screen.findByText(/from 1 company\./);
  });

  it('sends a pinned figure as a fraction, not as the percentage typed', async () => {
    const calls = mockApi({});
    renderPanel();
    await screen.findByText('No volatility derivation recorded');

    await userEvent.type(screen.getByLabelText(/Pin a figure/), '72.5');
    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/estimate'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/estimate'))?.body).toMatchObject({ manual_override: 0.725 });
  });

  it.each([
    ['6200', 'a decimal point slipped'],
    ['0', 'zero volatility'],
    ['-5', 'a negative sigma'],
    ['abc', 'not a number at all'],
  ])('refuses to send %s (%s) to the engine', async (typed) => {
    const calls = mockApi({});
    renderPanel();
    await screen.findByText('No volatility derivation recorded');

    await userEvent.type(screen.getByLabelText(/Pin a figure/), typed);
    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await screen.findByText('A pinned volatility is a percentage between 0 and 500.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('reports an estimator the engine could not run', async () => {
    mockApi({}, { writeStatus: 502 });
    renderPanel();
    await screen.findByText('No volatility derivation recorded');

    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await screen.findByText('Refused upstream.');
  });

  it('will not offer to estimate when no included peer carries a ticker', async () => {
    mockApi({ eligible_tickers: [] });
    renderPanel();

    await screen.findByText(/No included comparable carries a ticker/);
    expect(screen.getByRole('button', { name: 'Estimate' })).toBeDisabled();
  });

  it('shows the applied figure beside the derived one, and calls out the disagreement', async () => {
    mockApi({ estimates: [estimate()], applied_volatility: 0.65 });
    renderPanel();

    await screen.findByText(/The valuation applies 65\.0% against a derived 62\.0%/);
    expect(screen.getByText('Applied in the valuation')).toBeInTheDocument();
    expect(screen.getByText('Derived from peers')).toBeInTheDocument();
    expect(screen.getByText(/not adopted/)).toBeInTheDocument();
  });

  it('does not cry divergence when the applied figure is the derived one', async () => {
    mockApi({ estimates: [estimate({ applied_at: '2026-08-03' })], applied_volatility: 0.62 });
    renderPanel();

    await screen.findByText('valuation_params.volatility');
    expect(screen.queryByText(/against a derived/)).not.toBeInTheDocument();
    expect(screen.getByText('Adopted 2026-08-03')).toBeInTheDocument();
  });

  it('adopts an estimate and warns that the calculation has not caught up', async () => {
    const calls = mockApi({ estimates: [estimate()], applied_volatility: 0.65 }, { recalc: true });
    renderPanel();
    await screen.findByText('Adopt');

    await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));

    await screen.findByText(/Applied 62\.0%\. Re-run the calculation/);
    expect(calls.some((c) => c.path.endsWith('/volatility/est-1/apply'))).toBe(true);
  });

  it('says the calculation already ran on the figure when no re-run is needed', async () => {
    mockApi({ estimates: [estimate()], applied_volatility: 0.62 }, { recalc: false });
    renderPanel();
    await screen.findByText('Adopt');

    await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));

    await screen.findByText(/The calculation already ran on this figure/);
  });

  it('reports an adoption the server refused', async () => {
    mockApi({ estimates: [estimate()] }, { writeStatus: 409 });
    renderPanel();
    await screen.findByText('Adopt');

    await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));

    await screen.findByText('Refused upstream.');
  });

  it('ranks the per-company table by volatility and marks who was left out', async () => {
    mockApi({ estimates: [estimate()] });
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Per-company volatility' });
    const rows = within(table).getAllByRole('row').slice(1); // drop the header
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'CCC',
      'BBB',
      'AAA',
      'Median — selected',
    ]);
    expect(within(rows[0]!).getByText('Excluded')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Included')).toBeInTheDocument();
    // A peer with no observation count is a dash, not a zero.
    expect(within(rows[0]!).getAllByRole('cell')[2]?.textContent).toBe('—');
    // The footer states the dispersion the confidence grade came from.
    expect(within(rows[3]!).getByText('48.0%–81.0%')).toBeInTheDocument();
  });

  it('lists the peers considered and not measured, with the reason', async () => {
    mockApi({
      estimates: [estimate({ excluded: [{ ticker: 'DDD', reason: 'delisted mid-window' }] })],
    });
    renderPanel();

    await screen.findByText('Considered and not measured');
    expect(screen.getByText('delisted mid-window', { exact: false })).toBeInTheDocument();
  });

  it('keeps every run in the history, with its estimator spelled out', async () => {
    mockApi({
      estimates: [
        estimate({ id: 'est-2', method: 'parkinson', confidence: 'low', created_at: '2026-08-05T00:00:00Z' }),
        estimate({ id: 'est-1', applied_at: '2026-08-01', confidence: 'manual' }),
      ],
    });
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Volatility derivation history' });
    expect(within(table).getByText('Parkinson high-low range')).toBeInTheDocument();
    expect(within(table).getByText('Close-to-close (daily log returns)')).toBeInTheDocument();
    expect(within(table).getByText('low')).toBeInTheDocument();
    // An adopted run cannot be adopted again.
    expect(within(table).getAllByRole('button', { name: 'Adopt' })).toHaveLength(1);
  });

  it('falls back to the raw name for an estimator the panel does not know', async () => {
    mockApi({ estimates: [estimate({ method: 'garch', confidence: 'unheard-of' })] });
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Volatility derivation history' });
    expect(within(table).getByText('garch')).toBeInTheDocument();
    expect(within(table).getByText('unheard-of')).toBeInTheDocument();
  });

  it('shows a reader the derivation without offering to change it', async () => {
    mockApi({ estimates: [estimate()], applied_volatility: 0.62, can_edit: false });
    renderPanel();

    await screen.findByRole('table', { name: 'Volatility derivation history' });
    expect(screen.queryByRole('button', { name: 'Estimate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adopt' })).not.toBeInTheDocument();
  });
});
