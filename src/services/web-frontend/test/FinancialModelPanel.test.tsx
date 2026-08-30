import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FinancialModelPanel } from '../src/components/valuation/FinancialModelPanel';
import type { EngineInputs } from '../src/lib/pipeline';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const seeded: EngineInputs = {
  shares_outstanding_common: 8_000_000,
  volatility: 0.6,
  income: { free_cash_flows: [1_000_000, 2_000_000], discount_rate: 0.25, terminal_growth: 0.03 },
  market: { metric: 4_000_000, multiples: [3.5, 5] },
  share_classes: [{ kind: 'common', name: 'Common', shares: 8_000_000 }],
};

function mockGet(inputs: EngineInputs) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (!init || init.method === undefined || init.method === 'GET') {
      return jsonResponse({ engine_inputs: inputs });
    }
    return jsonResponse({ params: {} });
  });
}

describe('FinancialModelPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * The hint under Common shares, which is the whole defence against a
   * double-counted option pool.
   *
   * It read "Fully diluted common", which is the name of a different figure:
   * the engine adds this field to Options outstanding beside it
   * (`compute._opm_allocate`'s `fully_diluted_common = common_shares +
   * options`). An analyst who followed the hint entered the fully-diluted count
   * here and the pool again next door, and the denominator every per-share
   * figure divides by was overstated by the pool — 20% on an ordinary 20% pool.
   * Nothing downstream catches it: `cap_table_reconciles` only asks that the
   * cap table's common sit at or *below* this figure, which it still does.
   */
  it('tells the analyst this count excludes the option pool', async () => {
    mockGet(seeded);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    const common = await screen.findByLabelText('Common shares');
    const hint = common.closest('label')?.textContent ?? '';
    expect(hint).toContain('Options outstanding');
    expect(hint).not.toContain('Fully diluted');
  });

  it('loads and renders the saved model', async () => {
    mockGet(seeded);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    expect(await screen.findByLabelText('Common shares')).toHaveValue(8_000_000);
    expect(screen.getByLabelText('Year 1 free cash flow')).toHaveValue(1_000_000);
    expect(screen.getByLabelText('Year 2 free cash flow')).toHaveValue(2_000_000);
    expect(screen.getByLabelText('Discount rate (WACC)')).toHaveValue(0.25);
    expect(screen.getByLabelText('Multiple 1')).toHaveValue(3.5);
    expect(screen.getByLabelText('Share class 1 name')).toHaveValue('Common');
  });

  it('builds the engine_inputs patch body on save', async () => {
    const fetchMock = mockGet(seeded);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    const common = await screen.findByLabelText('Common shares');
    await userEvent.clear(common);
    await userEvent.type(common, '9000000');

    await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch![1]!.body));
      expect(body.shares_outstanding_common).toBe(9_000_000);
      expect(body.income.free_cash_flows).toEqual([1_000_000, 2_000_000]);
      expect(body.market.multiples).toEqual([3.5, 5]);
      expect(body.share_classes).toEqual([{ name: 'Common', kind: 'common', shares: 8_000_000 }]);
    });
    expect(await screen.findByText('Financial model saved.')).toBeInTheDocument();
  });

  it('offers a participation cap only once a class is marked participating', async () => {
    mockGet({
      ...seeded,
      share_classes: [
        { kind: 'common', name: 'Common', shares: 8_000_000 },
        { kind: 'preferred', name: 'Series A', shares: 4_000_000, preference: 10_000_000 },
      ],
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Share class 2 name');
    // A cap is meaningless on a non-participating class, and the engine refuses
    // one — so the field is not there to be filled in.
    expect(screen.queryByLabelText('Share class 2 participation cap')).toBeNull();

    await userEvent.click(screen.getAllByLabelText('Participating')[0]!);
    expect(await screen.findByLabelText('Share class 2 participation cap')).toBeInTheDocument();
  });

  it('sends the participation cap the analyst entered', async () => {
    const fetchMock = mockGet({
      ...seeded,
      share_classes: [
        { kind: 'common', name: 'Common', shares: 8_000_000 },
        {
          kind: 'preferred',
          name: 'Series A',
          shares: 4_000_000,
          preference: 10_000_000,
          participating: true,
          participation_cap: 20_000_000,
        },
      ],
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    expect(await screen.findByLabelText('Share class 2 participation cap')).toHaveValue(20_000_000);
    await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      const body = JSON.parse(String(patch![1]!.body));
      expect(body.share_classes[1].participation_cap).toBe(20_000_000);
    });
  });

  it('drops the cap when the class stops participating, rather than sending a 422', async () => {
    const fetchMock = mockGet({
      ...seeded,
      share_classes: [
        { kind: 'common', name: 'Common', shares: 8_000_000 },
        {
          kind: 'preferred',
          name: 'Series A',
          shares: 4_000_000,
          preference: 10_000_000,
          participating: true,
          participation_cap: 20_000_000,
        },
      ],
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Share class 2 participation cap');
    await userEvent.click(screen.getAllByLabelText('Participating')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      const body = JSON.parse(String(patch![1]!.body));
      expect(body.share_classes[1].participating).toBe(false);
      expect(body.share_classes[1].participation_cap).toBeNull();
    });
  });

  it('blocks saving when the discount rate is not above terminal growth', async () => {
    mockGet({ income: { discount_rate: 0.25, terminal_growth: 0.03 } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    const dr = await screen.findByLabelText('Discount rate (WACC)');
    await userEvent.clear(dr);
    await userEvent.type(dr, '0.02'); // now 0.02 <= 0.03 terminal growth

    expect(screen.getByText('DCF discount rate must exceed terminal growth.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save financial model' })).toBeDisabled();
  });

  it('lets an analyst add a projection year and a comparable multiple', async () => {
    mockGet({ income: { free_cash_flows: [1_000_000] } });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);

    await screen.findByLabelText('Year 1 free cash flow');
    await userEvent.click(screen.getByRole('button', { name: '+ Add year' }));
    expect(screen.getByLabelText('Year 2 free cash flow')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+ Add multiple' }));
    expect(screen.getByLabelText('Multiple 1')).toBeInTheDocument();
  });

  it('is read-only for non-ops viewers (no save button, inputs disabled)', async () => {
    mockGet(seeded);
    render(<FinancialModelPanel valuationId="v1" readOnly={true} />);

    expect(await screen.findByLabelText('Common shares')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save financial model' })).not.toBeInTheDocument();
  });
});
