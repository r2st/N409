import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSensitivityPanel } from '../src/components/valuation/ModelSensitivityPanel';

const RESULT = {
  base: { fmv_per_share: 2.05, equity_value: 20_000_000, parameters: { volatility: 0.6, time_to_exit: 3 } },
  span: 0.2,
  steps: 5,
  one_way: [
    {
      parameter: 'volatility',
      base_value: 0.6,
      points: [
        { value: 0.48, fmv_per_share: 1.8, equity_value: 19_000_000, delta_from_base: -0.12 },
        { value: 0.6, fmv_per_share: 2.05, equity_value: 20_000_000, delta_from_base: 0 },
        { value: 0.72, fmv_per_share: 2.3, equity_value: 21_000_000, delta_from_base: 0.12 },
      ],
    },
  ],
  two_way: [
    {
      row_parameter: 'volatility',
      col_parameter: 'time_to_exit',
      row_base: 0.6,
      col_base: 3,
      row_values: [0.48, 0.6, 0.72],
      col_values: [2.4, 3, 3.6],
      rows: [
        [
          { fmv_per_share: 1.7, delta_from_base: -0.17 },
          { fmv_per_share: 1.8, delta_from_base: -0.12 },
          { fmv_per_share: 1.9, delta_from_base: -0.07 },
        ],
        [
          { fmv_per_share: 1.95, delta_from_base: -0.05 },
          { fmv_per_share: 2.05, delta_from_base: 0 },
          { fmv_per_share: 2.15, delta_from_base: 0.05 },
        ],
        [
          { fmv_per_share: 2.2, delta_from_base: 0.07 },
          { fmv_per_share: 2.3, delta_from_base: 0.12 },
          { fmv_per_share: 2.4, delta_from_base: 0.17 },
        ],
      ],
    },
  ],
  currency: 'USD',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ModelSensitivityPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs the engine sensitivity and renders one-way tables + a heatmap', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ sensitivity: RESULT }));
    render(<ModelSensitivityPanel valuationId="01JZZZZZZZZZZZZZZZZZZZZZZZ" />);

    await userEvent.click(screen.getByRole('button', { name: /run model sensitivity/i }));

    await screen.findByText(/Base FMV/i, {}, { timeout: 5000 });
    // Two-way heatmap heading present.
    expect(screen.getByText('Volatility × Time to exit')).toBeInTheDocument();
    // One-way table shows the +12% delta.
    expect(screen.getByText('+12.0%')).toBeInTheDocument();
    // It posted default two-way pairs.
    const call = fetchSpy.mock.calls[0]!;
    expect(String(call[0])).toContain('/sensitivity/model');
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.two_way).toEqual([
      ['volatility', 'time_to_exit'],
      ['discount_rate', 'exit_multiple'],
    ]);
  });

  it('surfaces a 403 as an ops-only message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ title: 'Forbidden', detail: 'no' }, 403),
    );
    render(<ModelSensitivityPanel valuationId="01JZZZZZZZZZZZZZZZZZZZZZZZ" />);
    await userEvent.click(screen.getByRole('button', { name: /run model sensitivity/i }));
    await screen.findByText(/operations-only/i, {}, { timeout: 5000 });
  });
});
