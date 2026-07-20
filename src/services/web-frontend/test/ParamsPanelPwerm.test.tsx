import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

const PARAMS = {
  valuation_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  rolling_forward: false,
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: '0.1',
  dlom: null,
  dlom_method: null,
  dlom_qualitative: null,
  revenue_status: null,
  exit_timeline: null,
  last_round_date: null,
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

function mockApi(engineInputs: unknown = { engine_inputs: {} }) {
  const patched: Array<{ path: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      patched.push({ path, body: JSON.parse(String(init.body)) });
      return jsonResponse({ params: PARAMS });
    }
    if (path.includes('/engine-inputs')) return jsonResponse(engineInputs);
    return jsonResponse({ params: PARAMS });
  });
  return patched;
}

describe('ParamsPanel — PWERM', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the scenario editor only when PWERM is selected', async () => {
    mockApi();
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await screen.findByLabelText('Allocation method');
    expect(screen.queryByTestId('pwerm-scenarios')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Allocation method'), 'pwerm');
    expect(screen.getByTestId('pwerm-scenarios')).toBeInTheDocument();
  });

  it('loads existing scenarios from engine-inputs', async () => {
    mockApi({
      engine_inputs: {
        pwerm: {
          scenarios: [
            { name: 'IPO', type: 'ipo', probability: 0.4, equity_value: 20_000_000, time_to_exit_years: 2 },
            { name: 'Liq', type: 'liquidation', probability: 0.6, equity_value: 5_000_000, time_to_exit_years: 1 },
          ],
        },
      },
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByLabelText('Allocation method'), 'pwerm');
    expect((screen.getByLabelText('Scenario 1 name') as HTMLInputElement).value).toBe('IPO');
    expect(screen.getByTestId('pwerm-probability-total').textContent).toContain('1.0000');
  });

  it('flags a probability total that does not sum to one and blocks save', async () => {
    mockApi({
      engine_inputs: { pwerm: { scenarios: [{ name: 'IPO', probability: 0.4, equity_value: 20_000_000, time_to_exit_years: 2 }] } },
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByLabelText('Allocation method'), 'pwerm');
    expect(screen.getByText(/must sum to 1/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save scenarios/i })).toBeDisabled();
  });

  it('saves scenarios to the engine-inputs endpoint', async () => {
    const patched = mockApi({
      engine_inputs: { pwerm: { scenarios: [{ name: 'IPO', probability: 1, equity_value: 20_000_000, time_to_exit_years: 2 }] } },
    });
    render(<ParamsPanel valuationId={PARAMS.valuation_id} readOnly={false} />);
    await userEvent.selectOptions(await screen.findByLabelText('Allocation method'), 'pwerm');
    await userEvent.click(screen.getByRole('button', { name: /save scenarios/i }));
    await waitFor(() => expect(patched.some((p) => p.path.includes('/engine-inputs'))).toBe(true));
    const call = patched.find((p) => p.path.includes('/engine-inputs'))!;
    expect(call.body).toMatchObject({ pwerm: { scenarios: [{ probability: 1, equity_value: 20_000_000 }] } });
  });
});
