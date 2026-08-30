import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FinancialModelPanel } from '../src/components/valuation/FinancialModelPanel';
import type { EngineInputs } from '../src/lib/pipeline';

/**
 * The hand-entered financial model, exercised through the edits an analyst
 * actually makes: removing a row, switching a class kind, filling in the
 * approaches the first test file never opened — and the empty cells that
 * `FinancialModelPanel.test.tsx` never saved.
 *
 * The blank-cell cases are the ones that matter. This form is the only writer
 * of `engine_inputs` that a human drives directly, and what it PATCHes is
 * stored verbatim and re-read by the compute engine and by the report's DCF
 * exhibit. A cell nobody filled in has to arrive as an absent figure, not as a
 * zero — see `numList`.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(inputs: EngineInputs, patchResponse: () => Response = () => jsonResponse({})) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (!init || init.method === undefined || init.method === 'GET') {
      return jsonResponse({ engine_inputs: inputs });
    }
    return patchResponse();
  });
}

/** The body of the PATCH the Save button sent. */
async function savedBody(fetchMock: ReturnType<typeof mockApi>): Promise<Record<string, unknown>> {
  await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));
  let body: Record<string, unknown> | null = null;
  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch).toBeTruthy();
    body = JSON.parse(String(patch![1]!.body)) as Record<string, unknown>;
  });
  return body!;
}

describe('FinancialModelPanel — empty cells are not zeros', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('saves no income section at all from a model nobody has filled in', async () => {
    // The panel always shows one projection row. Read as numbers, its two blank
    // cells used to make `incomeHas` true and PATCH a DCF of zero cash flows
    // against a valuation that has no income approach.
    const fetchMock = mockApi({ shares_outstanding_common: 8_000_000 });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Year 1 free cash flow');
    const body = await savedBody(fetchMock);

    expect(body.income).toBeNull();
    expect(body.market).toBeNull();
    expect(body.asset).toBeNull();
    expect(body.share_classes).toBeNull();
    expect(body.shares_outstanding_common).toBe(8_000_000);
  });

  it('does not invent a revenue line when the analyst only forecast cash flows', async () => {
    // A round trip through this form must not add figures the model never had:
    // the report's DCF exhibit prints a Revenue column as soon as it has one
    // revenue per forecast year, so a fabricated [0, 0] puts a column of zero
    // revenue into the signed 409A.
    const fetchMock = mockApi({
      income: { free_cash_flows: [1_000_000, 2_000_000], discount_rate: 0.25, terminal_growth: 0.03 },
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    expect(await screen.findByLabelText('Year 1 revenue')).toHaveValue(null);
    const body = await savedBody(fetchMock);

    const income = body.income as Record<string, unknown>;
    expect(income.free_cash_flows).toEqual([1_000_000, 2_000_000]);
    expect(income.revenues).toBeNull();
  });

  it('keeps a revenue line the analyst did enter', async () => {
    const fetchMock = mockApi({ income: { free_cash_flows: [1_000_000], revenues: [4_000_000] } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    expect(await screen.findByLabelText('Year 1 revenue')).toHaveValue(4_000_000);
    const body = await savedBody(fetchMock);

    expect((body.income as Record<string, unknown>).revenues).toEqual([4_000_000]);
  });

  it('drops an added-then-abandoned multiple rather than sending a 0 the engine refuses', async () => {
    // `market_multiples` raises on a list with no positive entry, so a blank
    // row left behind after "+ Add multiple" turned Save into a 422.
    const fetchMock = mockApi({});
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Year 1 free cash flow');
    await userEvent.click(screen.getByRole('button', { name: '+ Add multiple' }));
    expect(screen.getByLabelText('Multiple 1')).toHaveValue(null);

    const body = await savedBody(fetchMock);
    expect(body.market).toBeNull();
  });

  it('sends the metric alone when the multiples are blank', async () => {
    const fetchMock = mockApi({ market: { metric: 4_000_000 } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    expect(await screen.findByLabelText('Metric')).toHaveValue(4_000_000);
    const body = await savedBody(fetchMock);

    expect(body.market).toEqual({ metric: 4_000_000, multiples: null });
  });

  it('keeps a year whose revenue is blank from shifting the next year up', async () => {
    // Positional lists: an entry dropped from the middle would re-date every
    // figure after it. Only a trailing-blank column may collapse to null.
    const fetchMock = mockApi({ income: { revenues: [1, 2, 3], free_cash_flows: [10, 20, 30] } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    const y2 = await screen.findByLabelText('Year 2 revenue');
    await userEvent.clear(y2);

    const body = await savedBody(fetchMock);
    const income = body.income as Record<string, unknown>;
    // Two revenues against three years no longer describes the forecast, so
    // the exhibit drops the column rather than mis-labelling year 3 as year 2.
    expect(income.revenues).toEqual([1, 3]);
    expect((income.revenues as number[]).length).not.toBe((income.free_cash_flows as number[]).length);
  });
});

describe('FinancialModelPanel — editing the model', () => {
  beforeEach(() => vi.restoreAllMocks());

  const twoClasses: EngineInputs = {
    share_classes: [
      { kind: 'common', name: 'Common', shares: 8_000_000 },
      { kind: 'preferred', name: 'Series A', shares: 4_000_000, preference: 10_000_000 },
    ],
  };

  it('adds a class and removes the one the analyst picked, not the last', async () => {
    mockApi(twoClasses);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Share class 2 name');
    await userEvent.click(screen.getByRole('button', { name: '+ Add class' }));
    expect(screen.getAllByTestId('share-class-row')).toHaveLength(3);

    // Remove the first row; the survivors renumber and Series A stays.
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(screen.getAllByTestId('share-class-row')).toHaveLength(2);
    expect(screen.getByLabelText('Share class 1 name')).toHaveValue('Series A');
  });

  it('explains itself when every class has gone and the last one is not common', async () => {
    mockApi(twoClasses);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Share class 2 name');
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    expect(
      await screen.findByText('The cap table must include at least one common class.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save financial model' })).toBeDisabled();

    // Removing the preferred one too leaves no cap table, which is allowed —
    // the engine falls back to the aggregate single-breakpoint allocation.
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('The cap table must include at least one common class.')).toBeNull();
    expect(
      screen.getByText(/With no classes the engine uses the aggregate single-breakpoint allocation/),
    ).toBeInTheDocument();
  });

  it('swaps a class to an option pool and carries the strike into the body', async () => {
    const fetchMock = mockApi({
      share_classes: [
        { kind: 'common', name: 'Common', shares: 8_000_000 },
        { kind: 'common', name: 'Pool', shares: 1_000_000 },
      ],
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Share class 2 name');
    expect(screen.queryByLabelText('Share class 2 strike')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Share class 2 kind'), 'option');
    const strike = await screen.findByLabelText('Share class 2 strike');
    await userEvent.type(strike, '1.25');

    const body = await savedBody(fetchMock);
    expect((body.share_classes as Record<string, unknown>[])[1]).toEqual({
      name: 'Pool',
      kind: 'option',
      shares: 1_000_000,
      strike: 1.25,
    });
  });

  it('refuses to save a cap table whose only class has become an option pool', async () => {
    // Named classes but no common one is an allocation the waterfall cannot
    // run — caught here rather than as a 422 after the round trip.
    mockApi({ share_classes: [{ kind: 'common', name: 'Common', shares: 8_000_000 }] });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Share class 1 name');
    await userEvent.selectOptions(screen.getByLabelText('Share class 1 kind'), 'option');

    expect(
      await screen.findByText('The cap table must include at least one common class.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save financial model' })).toBeDisabled();
  });

  it('carries a preferred class’s seniority and conversion ratio', async () => {
    const fetchMock = mockApi(twoClasses);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    const seniority = await screen.findByLabelText('Share class 2 seniority');
    await userEvent.clear(seniority);
    await userEvent.type(seniority, '2');
    const ratio = screen.getByLabelText('Share class 2 conversion ratio');
    await userEvent.clear(ratio);
    await userEvent.type(ratio, '1.5');
    const preference = screen.getByLabelText('Share class 2 preference');
    await userEvent.clear(preference);
    await userEvent.type(preference, '12000000');

    const body = await savedBody(fetchMock);
    expect((body.share_classes as Record<string, unknown>[])[1]).toEqual({
      name: 'Series A',
      kind: 'preferred',
      shares: 4_000_000,
      preference: 12_000_000,
      seniority: 2,
      participating: false,
      participation_cap: null,
      conversion_ratio: 1.5,
    });
  });

  it('removes the projection year the analyst picked, and hides Remove on the last one', async () => {
    mockApi({ income: { free_cash_flows: [10, 20] } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Year 2 free cash flow');
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    expect(screen.getAllByTestId('projection-row')).toHaveLength(1);
    expect(screen.getByLabelText('Year 1 free cash flow')).toHaveValue(20);
    // A DCF with no rows at all cannot be re-entered, so the sole row is fixed.
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('removes the comparable multiple the analyst picked', async () => {
    const fetchMock = mockApi({ market: { metric: 4_000_000, multiples: [3.5, 5, 7] } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Multiple 3');
    await userEvent.click(screen.getByRole('button', { name: 'Remove multiple 2' }));

    expect(screen.queryByLabelText('Multiple 3')).toBeNull();
    const body = await savedBody(fetchMock);
    expect((body.market as Record<string, unknown>).multiples).toEqual([3.5, 7]);
  });

  it('edits a multiple in place', async () => {
    const fetchMock = mockApi({ market: { metric: 4_000_000, multiples: [3.5, 5] } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    const second = await screen.findByLabelText('Multiple 2');
    await userEvent.clear(second);
    await userEvent.type(second, '6.5');

    const body = await savedBody(fetchMock);
    expect((body.market as Record<string, unknown>).multiples).toEqual([3.5, 6.5]);
  });

  it('carries the asset approach and the backsolve round', async () => {
    const fetchMock = mockApi({});
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await userEvent.type(await screen.findByLabelText('Total assets'), '5000000');
    await userEvent.type(screen.getByLabelText('Total liabilities'), '1200000');
    await userEvent.type(screen.getByLabelText('Cost to replicate'), '3000000');
    await userEvent.type(screen.getByLabelText('Post-money valuation'), '40000000');
    await userEvent.type(screen.getByLabelText('Price per share'), '2.5');
    await userEvent.type(screen.getByLabelText('Last round class'), 'Series A');
    await userEvent.type(screen.getByLabelText('Valuation date'), '2026-03-31');

    const body = await savedBody(fetchMock);
    expect(body.asset).toEqual({
      total_assets: 5_000_000,
      total_liabilities: 1_200_000,
      cost_to_replicate: 3_000_000,
    });
    expect(body.last_round_post_money).toBe(40_000_000);
    expect(body.last_round_price_per_share).toBe(2.5);
    expect(body.last_round_class).toBe('Series A');
    expect(body.valuation_date).toBe('2026-03-31');
  });

  it('clears the saved banner as soon as the model is edited again', async () => {
    const fetchMock = mockApi({ shares_outstanding_common: 8_000_000 });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Common shares');
    await savedBody(fetchMock);
    expect(await screen.findByText('Financial model saved.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Debt'), '250000');
    // Still saying "saved" over an edited model would be a lie about what the
    // server holds.
    expect(screen.queryByText('Financial model saved.')).toBeNull();
  });
});

describe('FinancialModelPanel — when the server says no', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the load failure instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    expect(await screen.findByText('Could not load the financial model.')).toBeInTheDocument();
  });

  it('surfaces the validation message the API sent back', async () => {
    const fetchMock = mockApi({ shares_outstanding_common: 8_000_000 }, () =>
      jsonResponse({ title: 'Unprocessable Entity', detail: 'share_classes.0.shares must be positive' }, 422),
    );
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Common shares');
    await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));

    expect(await screen.findByText(/share_classes.0.shares must be positive/)).toBeInTheDocument();
    expect(screen.queryByText('Financial model saved.')).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
  });

  it('falls back to its own wording when the failure is not an API error', async () => {
    mockApi({ shares_outstanding_common: 8_000_000 }, () => {
      throw new TypeError('network down');
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Common shares');
    await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));

    expect(await screen.findByText(/Could not save the financial model\./)).toBeInTheDocument();
    // The button has to come back — a failed save the analyst cannot retry is
    // a lost model.
    expect(screen.getByRole('button', { name: 'Save financial model' })).toBeEnabled();
  });
});
