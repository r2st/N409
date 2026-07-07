import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SensitivityPage } from '../src/pages/SensitivityPage';

/** Gap 8 — price-only sensitivity table view toggle. */

const sensitivity = {
  currency: 'USD',
  dlom: 0.3,
  base: { volatility: 0.6, termYears: 3, riskFreeRate: 0.043, fmvPerShareCents: 123 },
  tables: {
    term_vol: {
      rowAxis: 'termYears',
      colAxis: 'volatility',
      rowValues: [2, 3],
      colValues: [0.4, 0.6],
      rows: [
        [
          { fmvPerShareCents: 100, deltaFromBase: -0.187 },
          { fmvPerShareCents: 110, deltaFromBase: -0.106 },
        ],
        [
          { fmvPerShareCents: 115, deltaFromBase: -0.065 },
          { fmvPerShareCents: 123, deltaFromBase: 0 },
        ],
      ],
    },
    rfr_vol: {
      rowAxis: 'riskFreeRate',
      colAxis: 'volatility',
      rowValues: [0.043],
      colValues: [0.6],
      rows: [[{ fmvPerShareCents: 123, deltaFromBase: 0 }]],
    },
    rfr_term: {
      rowAxis: 'riskFreeRate',
      colAxis: 'termYears',
      rowValues: [0.043],
      colValues: [3],
      rows: [[{ fmvPerShareCents: 123, deltaFromBase: 0 }]],
    },
  },
};

describe('SensitivityPage price-only view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('hides delta percentages when Prices only is checked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sensitivity }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/valuations/X/sensitivity']}>
        <Routes>
          <Route path="/valuations/:id/sensitivity" element={<SensitivityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Run stress tables|Compute|Run/ }));
    await screen.findByText(/Base FMV/);

    // deltas visible by default
    expect(screen.getByText('-18.7%')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Prices only'));
    expect(screen.queryByText('-18.7%')).not.toBeInTheDocument();
    // prices stay
    expect(screen.getByText('$1.00')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Prices only'));
    expect(screen.getByText('-18.7%')).toBeInTheDocument();
  });
});
