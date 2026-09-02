import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectionPanel } from '../src/components/valuation/ProjectionPanel';

/**
 * The cash-flow projection panel.
 *
 * Three behaviours carry the claim the feature makes:
 *
 *   * the assumptions leave the form as the engine takes them — percentages as
 *     fractions, and a field left blank omitted rather than asserted as zero;
 *   * projecting does not adopt, so a run cannot move a concluded value on its
 *     own;
 *   * a stream the calculation is discounting that no run produced is called
 *     out, because a hand-typed column is exactly what this replaces.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const YEAR = (year: number, revenue: number, fcff: number) => ({
  year,
  revenue,
  cogs: revenue * 0.4,
  opex: revenue * 0.3,
  ebitda: revenue * 0.3,
  da: revenue * 0.05,
  ebit: revenue * 0.25,
  nopat: revenue * 0.2,
  capex: revenue * 0.06,
  delta_nwc: 10_000,
  fcff,
});

const RUN = {
  id: '01J0PROJECTION000000000001',
  method: 'growth' as const,
  years: 2,
  tax_rate: 0.21,
  projections: [YEAR(1, 10_000_000, 1_500_000), YEAR(2, 12_000_000, 1_900_000)],
  free_cash_flows: [1_500_000, 1_900_000],
  terminal_method: null,
  terminal_value: null,
  terminal_ebitda: 3_600_000,
  applied_at: null,
  created_at: '2026-08-01T12:00:00.000Z',
};

/** GET returns `state`; POSTs are recorded and answered plausibly. */
function mockApi(state: {
  projections: unknown[];
  applied_free_cash_flows: number[] | null;
  applied_matches_run: boolean;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (!init || init.method === undefined || init.method === 'GET') return jsonResponse(state);
    if (path.endsWith('/projection/run')) return jsonResponse({ projection: RUN }, 201);
    return jsonResponse({
      projection: { ...RUN, applied_at: '2026-08-02T09:00:00.000Z' },
      applied_free_cash_flows: RUN.free_cash_flows,
      recalculation_required: true,
    });
  });
}

const EMPTY = { projections: [], applied_free_cash_flows: null, applied_matches_run: false };

const panel = (readOnly = false) =>
  render(<ProjectionPanel valuationId="v1" currency="USD" readOnly={readOnly} />);

const posted = (fetchMock: ReturnType<typeof mockApi>, suffix: string) => {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => init?.method === 'POST' && String(url).endsWith(suffix),
  );
  return call ? (JSON.parse(String(call[1]!.body)) as Record<string, unknown>) : null;
};

describe('ProjectionPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends percentages as fractions and omits the fields left blank', async () => {
    const fetchMock = mockApi(EMPTY);
    panel();

    await userEvent.type(await screen.findByLabelText('Base revenue'), '8000000');
    await userEvent.type(screen.getByLabelText('Revenue growth (%)'), '25');
    await userEvent.type(screen.getByLabelText('COGS (% of revenue)'), '40');
    await userEvent.clear(screen.getByLabelText('Forecast years'));
    await userEvent.type(screen.getByLabelText('Forecast years'), '4');

    await userEvent.click(screen.getByRole('button', { name: 'Project' }));

    await waitFor(() => expect(posted(fetchMock, '/projection/run')).toBeTruthy());
    const body = posted(fetchMock, '/projection/run')!;
    expect(body).toMatchObject({
      method: 'growth',
      years: 4,
      base_revenue: 8_000_000,
      revenue_growth: 0.25,
      cogs_pct: 0.4,
      tax_rate: 0.21,
    });
    // OpEx was never typed. Sending 0 would read in the stored assumptions as a
    // company somebody asserted has no operating expense.
    expect(body).not.toHaveProperty('opex_pct');
    expect(body).not.toHaveProperty('capex_pct');
    expect(body).not.toHaveProperty('terminal_method');
  });

  it('refuses a Gordon terminal value the discount rate cannot support, without a round trip', async () => {
    const fetchMock = mockApi(EMPTY);
    panel();

    await userEvent.type(await screen.findByLabelText('Base revenue'), '8000000');
    await userEvent.type(screen.getByLabelText('Revenue growth (%)'), '25');
    await userEvent.selectOptions(screen.getByLabelText('Terminal value'), 'gordon');
    await userEvent.type(screen.getByLabelText('Terminal growth (%)'), '12');
    await userEvent.type(screen.getByLabelText('Discount rate (%)'), '10');

    await userEvent.click(screen.getByRole('button', { name: 'Project' }));

    expect(await screen.findByText('The discount rate must exceed terminal growth.')).toBeInTheDocument();
    expect(posted(fetchMock, '/projection/run')).toBeNull();
  });

  it('projects without adopting, and adopts on its own action', async () => {
    const fetchMock = mockApi(EMPTY);
    panel();

    await userEvent.type(await screen.findByLabelText('Base revenue'), '8000000');
    await userEvent.type(screen.getByLabelText('Revenue growth (%)'), '25');
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));

    // The run happened and said so, and nothing was adopted by it.
    expect(await screen.findByText(/Not yet adopted as the valuation’s cash flows/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/apply'))).toBe(false);

    // The reload after the run now shows the recorded forecast.
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url);
      if (!init || init.method === undefined || init.method === 'GET') {
        return jsonResponse({
          projections: [RUN],
          applied_free_cash_flows: null,
          applied_matches_run: false,
        });
      }
      if (path.endsWith('/projection/run')) return jsonResponse({ projection: RUN }, 201);
      return jsonResponse({
        projection: { ...RUN, applied_at: '2026-08-02T09:00:00.000Z' },
        applied_free_cash_flows: RUN.free_cash_flows,
        recalculation_required: true,
      });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Project' }));

    const adopt = await screen.findByRole('button', { name: 'Adopt as the valuation’s cash flows' });
    await userEvent.click(adopt);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/projection/${RUN.id}/apply`))).toBe(
        true,
      ),
    );
    // Adopting changes the inputs and not the results; saying so is the point.
    expect(await screen.findByText(/Re-run the calculation/)).toBeInTheDocument();
  });

  /*
   * Round 360 (M5). A forecast whose terminal year has no positive EBITDA
   * cannot carry an exit multiple, so the apply route clears
   * `terminal_metric`/`terminal_metric_basis` on the engagement and reports it
   * on `terminal_metric_warning`. This panel read `recalculation_required` and
   * nothing else, so an analyst who had adopted a terminal metric had it
   * removed — moving the terminal value from an exit multiple to Gordon, and
   * so the concluded value — under the single word "Adopted."
   */
  it('says when adopting cleared the terminal metric', async () => {
    const warning =
      'The terminal year’s EBITDA is -250000, which an exit multiple cannot be struck against. ' +
      'Any previously adopted terminal metric has been cleared; a Gordon terminal value is the ' +
      'method this forecast supports.';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (!init || init.method === undefined || init.method === 'GET')
        return jsonResponse({
          projections: [RUN],
          applied_free_cash_flows: null,
          applied_matches_run: false,
        });
      if (path.endsWith('/projection/run')) return jsonResponse({ projection: RUN }, 201);
      return jsonResponse({
        projection: { ...RUN, applied_at: '2026-08-02T09:00:00.000Z' },
        applied_free_cash_flows: RUN.free_cash_flows,
        recalculation_required: true,
        adopted_terminal_metric: null,
        terminal_metric_warning: warning,
      });
    });
    panel();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Adopt as the valuation’s cash flows' }),
    );

    // The adoption still happened and still says so...
    expect(await screen.findByText(/Re-run the calculation/)).toBeInTheDocument();
    // ...and the change nobody asked for is announced rather than left to the
    // next Calculate.
    const said = await screen.findByText(new RegExp('exit multiple cannot be struck against'));
    expect(said).toHaveAttribute('role', 'alert');
  });

  it('renders the per-year build behind the stream', async () => {
    mockApi({ projections: [RUN], applied_free_cash_flows: RUN.free_cash_flows, applied_matches_run: true });
    panel();

    const table = await screen.findByLabelText('Projected free cash flow');
    const fcf = within(table).getByText('Free cash flow').closest('tr')!;
    expect(within(fcf).getByText('$1,500,000')).toBeInTheDocument();
    expect(within(fcf).getByText('$1,900,000')).toBeInTheDocument();
    // The build is the substance a reviewer questions — the stream alone is a
    // typed column with extra steps.
    expect(within(table).getByText('EBITDA')).toBeInTheDocument();
    expect(within(table).getByText('Δ NWC')).toBeInTheDocument();
  });

  it('calls out a stream the calculation is discounting that no run produced', async () => {
    mockApi({
      projections: [RUN],
      applied_free_cash_flows: [999_999, 888_888],
      applied_matches_run: false,
    });
    panel();

    expect(await screen.findByText(/it was entered by hand/)).toBeInTheDocument();
  });

  it('offers no controls to a reader who cannot edit the engagement', async () => {
    mockApi({ projections: [RUN], applied_free_cash_flows: RUN.free_cash_flows, applied_matches_run: true });
    panel(true);

    // The build is still readable — "where did year two come from" is a fair
    // question from the client whose report rests on it.
    expect(await screen.findByLabelText('Projected free cash flow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adopt' })).toBeNull();
  });
});
