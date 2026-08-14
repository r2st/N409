import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectionPanel } from '../src/components/valuation/ProjectionPanel';

/**
 * The half of the projection panel the first test file did not reach: bottom-up
 * mode, the exit-multiple terminal, and every way the panel can fail.
 *
 * Bottom-up is the mode an analyst uses when the company's own model is the
 * source — each line typed year by year — and it carries the one rule that is
 * silently destructive if it goes wrong: the engine takes a list the length of
 * the revenue list, so a line with holes in it must be sent zero-filled rather
 * than compacted. Dropping the blanks would shift every later year up one and
 * discount a stream nobody entered.
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
  terminal_method: null as 'gordon' | 'exit_multiple' | null,
  terminal_value: null as number | null,
  terminal_ebitda: null as number | null,
  applied_at: null as string | null,
  created_at: '2026-08-01T12:00:00.000Z',
};

interface State {
  projections: unknown[];
  applied_free_cash_flows: number[] | null;
  applied_matches_run: boolean;
}

const EMPTY: State = { projections: [], applied_free_cash_flows: null, applied_matches_run: false };

/**
 * GET returns `state`; writes are answered from `writes`, keyed by the path
 * suffix, so a case can fail exactly one call. A handler that throws stands in
 * for the network being down.
 */
function mockApi(state: State, writes: Record<string, () => Response> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (!init?.method || init.method === 'GET') {
      const get = writes.GET;
      return get ? get() : jsonResponse(state);
    }
    for (const [suffix, handler] of Object.entries(writes)) {
      if (suffix !== 'GET' && path.endsWith(suffix)) return handler();
    }
    if (path.endsWith('/projection/run')) return jsonResponse({ projection: RUN }, 201);
    return jsonResponse({ recalculation_required: true });
  });
}

const panel = (readOnly = false) =>
  render(<ProjectionPanel valuationId="v1" currency="USD" readOnly={readOnly} />);

const posted = (fetchMock: ReturnType<typeof mockApi>, suffix: string) => {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => init?.method === 'POST' && String(url).endsWith(suffix),
  );
  return call ? (JSON.parse(String(call[1]!.body)) as Record<string, unknown>) : null;
};

/** Switch to bottom-up and wait for the grid to replace the ratio fields. */
async function toDriver(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText('Method'), 'driver');
  return screen.findByLabelText('Projection drivers by year');
}

describe('ProjectionPanel — bottom-up mode', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lays out one column per forecast year and one row per line', async () => {
    const user = userEvent.setup();
    mockApi(EMPTY);
    panel();

    const grid = await toDriver(user);
    // Five years by default, and the six lines the engine's FCFF identity needs.
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(6); // "Line" + 5 years
    for (const line of ['Revenue', 'COGS', 'OpEx', 'D&A', 'CapEx', 'NWC']) {
      expect(within(grid).getByRole('cell', { name: line })).toBeInTheDocument();
    }
    expect(within(grid).getByLabelText('Revenue year 5')).toBeInTheDocument();
    // The top-down ratio fields are gone — the two modes are alternatives, and
    // a percentage still on screen would look like it still applies.
    expect(screen.queryByLabelText('COGS (% of revenue)')).toBeNull();
  });

  it('sends one list per line and omits a line nobody touched', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await toDriver(user);
    await user.selectOptions(screen.getByLabelText('Forecast years'), '3');

    await user.type(screen.getByLabelText('Revenue year 1'), '10000000');
    await user.type(screen.getByLabelText('Revenue year 2'), '12,000,000');
    await user.type(screen.getByLabelText('Revenue year 3'), '14000000');
    // COGS only in year 1 — a line with holes in it.
    await user.type(screen.getByLabelText('COGS year 1'), '4000000');

    await user.click(screen.getByRole('button', { name: 'Project' }));

    await waitFor(() => expect(posted(fetchMock, '/projection/run')).toBeTruthy());
    const body = posted(fetchMock, '/projection/run')!;
    expect(body.method).toBe('driver');
    // Thousands separators are what a spreadsheet paste carries; they are not
    // a different number.
    expect(body.revenue).toEqual([10_000_000, 12_000_000, 14_000_000]);
    // The partially-filled line is zero-filled to the same length rather than
    // compacted — compacting would shift year 2 into year 1's slot.
    expect(body.cogs).toEqual([4_000_000, 0, 0]);
    // Lines never touched are absent, not zero: the engine defaults them, and a
    // sent zero reads in the stored assumptions as an asserted figure.
    expect(body).not.toHaveProperty('opex');
    expect(body).not.toHaveProperty('capex');
    expect(body).not.toHaveProperty('nwc');
    // Top-down's fields have no business in a bottom-up run.
    expect(body).not.toHaveProperty('base_revenue');
    expect(body).not.toHaveProperty('revenue_growth');
  });

  it('keeps what has already been typed when the grid is resized', async () => {
    const user = userEvent.setup();
    mockApi(EMPTY);
    panel();

    await toDriver(user);
    await user.type(screen.getByLabelText('Revenue year 1'), '1000');
    await user.type(screen.getByLabelText('Revenue year 5'), '5000');

    // Shrinking drops the columns that no longer exist…
    await user.selectOptions(screen.getByLabelText('Forecast years'), '3');
    expect(screen.getByLabelText('Revenue year 1')).toHaveValue('1000');
    expect(screen.queryByLabelText('Revenue year 5')).toBeNull();

    // …and growing again brings back blanks, not the dropped figures. A number
    // that reappears from a column the analyst deliberately removed is worse
    // than one they have to retype.
    await user.selectOptions(screen.getByLabelText('Forecast years'), '6');
    expect(screen.getByLabelText('Revenue year 1')).toHaveValue('1000');
    expect(screen.getByLabelText('Revenue year 5')).toHaveValue('');
    expect(screen.getByLabelText('Revenue year 6')).toHaveValue('');
  });

  it('refuses to project a grid with no revenue in it, without a round trip', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await toDriver(user);
    // Every other line filled in; revenue is the one the engine sizes by.
    await user.type(screen.getByLabelText('OpEx year 1'), '300000');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    expect(
      await screen.findByText('Bottom-up needs a revenue figure for at least the first year.'),
    ).toBeInTheDocument();
    expect(posted(fetchMock, '/projection/run')).toBeNull();
  });
});

describe('ProjectionPanel — terminal value and pre-flight', () => {
  beforeEach(() => vi.restoreAllMocks());

  const fillTopDown = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(await screen.findByLabelText('Base revenue'), '8000000');
    await user.type(screen.getByLabelText('Revenue growth (%)'), '25');
  };

  it('carries an exit multiple and the metric it is struck on', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await fillTopDown(user);
    await user.selectOptions(screen.getByLabelText('Terminal value'), 'exit_multiple');
    await user.type(screen.getByLabelText('Exit multiple'), '8.5');
    await user.selectOptions(screen.getByLabelText('Struck on'), 'revenue');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    await waitFor(() => expect(posted(fetchMock, '/projection/run')).toBeTruthy());
    expect(posted(fetchMock, '/projection/run')).toMatchObject({
      terminal_method: 'exit_multiple',
      exit_multiple: 8.5,
      exit_metric: 'revenue',
    });
  });

  it('will not send an exit-multiple terminal with no multiple', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await fillTopDown(user);
    await user.selectOptions(screen.getByLabelText('Terminal value'), 'exit_multiple');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    expect(
      await screen.findByText('An exit-multiple terminal value needs the multiple.'),
    ).toBeInTheDocument();
    expect(posted(fetchMock, '/projection/run')).toBeNull();
  });

  it('will not capitalise a Gordon terminal without the rate it capitalises at', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await fillTopDown(user);
    await user.selectOptions(screen.getByLabelText('Terminal value'), 'gordon');
    await user.type(screen.getByLabelText('Terminal growth (%)'), '3');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    expect(
      await screen.findByText('A Gordon terminal value needs the discount rate it capitalises at.'),
    ).toBeInTheDocument();
    expect(posted(fetchMock, '/projection/run')).toBeNull();
  });

  it('sends a Gordon terminal as fractions once it holds together', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await fillTopDown(user);
    // The working-capital pair, which the engine reads differently from the
    // other ratios: a level held and the level it is measured from, with ΔNWC
    // derived between them.
    await user.type(screen.getByLabelText('NWC (% of revenue)'), '15');
    await user.type(screen.getByLabelText('Prior-year NWC'), '1200000');
    await user.selectOptions(screen.getByLabelText('Terminal value'), 'gordon');
    await user.type(screen.getByLabelText('Terminal growth (%)'), '2.5');
    await user.type(screen.getByLabelText('Discount rate (%)'), '14');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    await waitFor(() => expect(posted(fetchMock, '/projection/run')).toBeTruthy());
    expect(posted(fetchMock, '/projection/run')).toMatchObject({
      nwc_pct: 0.15,
      prior_nwc: 1_200_000,
      terminal_method: 'gordon',
      terminal_growth: 0.025,
      discount_rate: 0.14,
    });
  });

  it('names the top-down assumption that is missing rather than failing at the engine', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await user.click(await screen.findByRole('button', { name: 'Project' }));
    expect(await screen.findByText('Top-down needs a base revenue to grow from.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Base revenue'), '8000000');
    await user.click(screen.getByRole('button', { name: 'Project' }));
    expect(await screen.findByText('Top-down needs a revenue growth rate.')).toBeInTheDocument();

    expect(posted(fetchMock, '/projection/run')).toBeNull();
  });

  it('holds the forecast period to a whole number of years', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await user.type(await screen.findByLabelText('Base revenue'), '8000000');
    await user.type(screen.getByLabelText('Revenue growth (%)'), '25');

    const years = screen.getByLabelText('Forecast years');
    for (const bad of ['7.5', '0', '250']) {
      await user.clear(years);
      await user.type(years, bad);
      await user.click(screen.getByRole('button', { name: 'Project' }));
      expect(
        await screen.findByText('The forecast period is a whole number of years, from 1 to 100.'),
      ).toBeInTheDocument();
    }
    expect(posted(fetchMock, '/projection/run')).toBeNull();
  });

  it('leaves a blank tax rate to the engine rather than asserting zero', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(EMPTY);
    panel();

    await user.type(await screen.findByLabelText('Base revenue'), '8000000');
    await user.type(screen.getByLabelText('Revenue growth (%)'), '25');
    await user.clear(screen.getByLabelText('Tax rate (%)'));
    await user.click(screen.getByRole('button', { name: 'Project' }));

    await waitFor(() => expect(posted(fetchMock, '/projection/run')).toBeTruthy());
    expect(posted(fetchMock, '/projection/run')).not.toHaveProperty('tax_rate');
  });
});

describe('ProjectionPanel — failures and the run it reports', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports a projection that will not load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    panel();

    expect(await screen.findByText('Could not load the cash-flow projection.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('prefers the server’s own words when the load is refused', async () => {
    mockApi(EMPTY, {
      GET: () =>
        jsonResponse(
          { title: 'Forbidden', detail: 'The income approach is not in scope here.', status: 403 },
          403,
        ),
    });
    panel();

    expect(await screen.findByText('The income approach is not in scope here.')).toBeInTheDocument();
  });

  it('reports a rejected run and keeps the form on screen to fix', async () => {
    const user = userEvent.setup();
    mockApi(EMPTY, {
      '/projection/run': () =>
        jsonResponse({ title: 'Unprocessable', detail: 'NWC ratio exceeds 1.', status: 422 }, 422),
    });
    panel();

    await user.type(await screen.findByLabelText('Base revenue'), '8000000');
    await user.type(screen.getByLabelText('Revenue growth (%)'), '25');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    expect(await screen.findByText('NWC ratio exceeds 1.')).toBeInTheDocument();
    expect(screen.getByLabelText('Base revenue')).toHaveValue('8000000');
    expect(screen.getByRole('button', { name: 'Project' })).toBeEnabled();
  });

  it('falls back to its own wording when a run fails without a problem document', async () => {
    const user = userEvent.setup();
    mockApi(EMPTY, {
      '/projection/run': () => {
        throw new TypeError('network down');
      },
    });
    panel();

    await user.type(await screen.findByLabelText('Base revenue'), '8000000');
    await user.type(screen.getByLabelText('Revenue growth (%)'), '25');
    await user.click(screen.getByRole('button', { name: 'Project' }));

    expect(await screen.findByText('Could not project the cash flows.')).toBeInTheDocument();
  });

  it('reports a refused adoption', async () => {
    const user = userEvent.setup();
    mockApi(
      { projections: [RUN], applied_free_cash_flows: null, applied_matches_run: false },
      {
        '/apply': () =>
          jsonResponse(
            { title: 'Conflict', detail: 'The valuation is locked for review.', status: 409 },
            409,
          ),
      },
    );
    panel();

    await user.click(await screen.findByRole('button', { name: 'Adopt as the valuation’s cash flows' }));
    expect(await screen.findByText('The valuation is locked for review.')).toBeInTheDocument();
  });

  it('says so when the calculation already ran on the cash flows just adopted', async () => {
    const user = userEvent.setup();
    mockApi(
      { projections: [RUN], applied_free_cash_flows: null, applied_matches_run: false },
      { '/apply': () => jsonResponse({ recalculation_required: false }) },
    );
    panel();

    await user.click(await screen.findByRole('button', { name: 'Adopt as the valuation’s cash flows' }));
    // The distinction matters: one of these leaves the concluded value stale
    // and the other does not, and only the panel knows which.
    expect(
      await screen.findByText('Adopted. The calculation already ran on these cash flows.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Re-run the calculation/)).toBeNull();
  });

  it('reports the terminal value and its basis alongside the run', async () => {
    mockApi({
      projections: [
        {
          ...RUN,
          terminal_method: 'exit_multiple',
          terminal_value: 24_000_000,
          terminal_ebitda: 3_600_000,
        },
      ],
      applied_free_cash_flows: null,
      applied_matches_run: false,
    });
    panel();

    expect(await screen.findByText(/Struck at a 21\.0% tax rate/)).toBeInTheDocument();
    expect(screen.getByText(/exit-multiple terminal value \$24,000,000/)).toBeInTheDocument();
    expect(
      screen.getByText(/terminal EBITDA \$3,600,000 carried as the exit-multiple basis/),
    ).toBeInTheDocument();
  });

  it('names a Gordon terminal as Gordon', async () => {
    mockApi({
      projections: [{ ...RUN, terminal_method: 'gordon', terminal_value: 31_000_000 }],
      applied_free_cash_flows: null,
      applied_matches_run: false,
    });
    panel();

    expect(await screen.findByText(/Gordon terminal value \$31,000,000/)).toBeInTheDocument();
  });
});

describe('ProjectionPanel — the run history', () => {
  beforeEach(() => vi.restoreAllMocks());

  const ADOPTED = {
    ...RUN,
    id: '01J0PROJECTION000000000002',
    method: 'driver' as const,
    applied_at: '2026-07-20T08:00:00.000Z',
    created_at: '2026-07-19T08:00:00.000Z',
  };

  it('names each run’s method, size and standing', async () => {
    mockApi({
      projections: [RUN, ADOPTED],
      applied_free_cash_flows: RUN.free_cash_flows,
      applied_matches_run: true,
    });
    panel();

    const history = await screen.findByLabelText('Projection history');
    const rows = within(history).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Top-down')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Forecast only')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Bottom-up')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Adopted 2026-07-20')).toBeInTheDocument();
    // A run already adopted offers no second adoption.
    expect(within(rows[1]!).queryByRole('button', { name: 'Adopt' })).toBeNull();
  });

  it('adopts an earlier run from its own row', async () => {
    const user = userEvent.setup();
    const older = { ...ADOPTED, applied_at: null };
    const fetchMock = mockApi({
      projections: [RUN, older],
      applied_free_cash_flows: null,
      applied_matches_run: false,
    });
    panel();

    const history = await screen.findByLabelText('Projection history');
    const rows = within(history).getAllByRole('row').slice(1);
    await user.click(within(rows[1]!).getByRole('button', { name: 'Adopt' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/projection/${older.id}/apply`)),
      ).toBe(true),
    );
  });

  it('hides the adopt column entirely from a reader who cannot edit', async () => {
    mockApi({ projections: [RUN], applied_free_cash_flows: null, applied_matches_run: false });
    panel(true);

    const history = await screen.findByLabelText('Projection history');
    // Five columns, not six: an empty action column reads as a control that
    // failed to render.
    expect(within(history).getAllByRole('columnheader')).toHaveLength(5);
  });

  it('tells a first-time reader where cash flows come from', async () => {
    mockApi(EMPTY);
    panel();

    expect(await screen.findByText('No cash-flow projection recorded')).toBeInTheDocument();
    expect(screen.getByText(/The income approach has no cash flows yet/)).toBeInTheDocument();
  });

  it('tells a reader with a hand-typed stream and no runs what to do about it', async () => {
    mockApi({
      projections: [],
      applied_free_cash_flows: [500_000, 600_000],
      applied_matches_run: false,
    });
    panel();

    expect(await screen.findByText(/discounting cash flows somebody typed/)).toBeInTheDocument();
  });
});
