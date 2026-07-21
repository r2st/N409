import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FundPortfolioPage } from '../src/pages/FundPortfolioPage';

const fund = { id: 'f1', name: 'Growth Fund I', fund_type: 'vc', currency: 'USD', vintage_year: 2021 };
const position = {
  id: 'p1',
  company_name: 'Acme',
  security_type: 'preferred',
  quantity: '1000',
  cost_basis: '500000',
  mark_method: 'calibrated_opm',
  latest_mark: { id: 'm1', measurement_date: '2026-03-31', method: 'calibrated_opm', fair_value: '750000', level: 3 },
};
const detail = { fund, lp_terms: null, positions: [position] };
const nav = {
  net_asset_value: 750000,
  gross_asset_value: 750000,
  total_cost_basis: 500000,
  total_unrealized_gain: 250000,
  liabilities: 0,
  level_breakdown: { level_1: 0, level_2: 0, level_3: 750000 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/positions/') && path.endsWith('/marks')) return jsonResponse({ marks: [] });
    if (path.endsWith('/nav')) return jsonResponse({ nav });
    if (/\/funds\/[^/]+$/.test(path)) return jsonResponse(detail);
    return jsonResponse({ funds: [fund] });
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FundPortfolioPage />
    </MemoryRouter>,
  );
}

describe('FundPortfolioPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockApi();
  });

  it('renders a contextual HelpIcon that opens the fund-holdings article', async () => {
    const user = userEvent.setup();
    renderPage();

    const help = await screen.findByRole('button', { name: /Help: Fund holdings & ASC 820/ });
    await user.click(help);
    await screen.findByRole('dialog', { name: /Fund holdings & ASC 820/ });
    expect(screen.getByRole('link', { name: /Open in Help Center/ })).toHaveAttribute(
      'href',
      '/help/fund-holdings-overview',
    );
  });

  it('explains the LP waterfall tiers and carry with tooltips', async () => {
    renderPage();
    // WaterfallCard renders once the fund detail loads.
    expect(await screen.findByRole('button', { name: 'About the LP waterfall' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Carry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Pref return' })).toBeInTheDocument();
  });

  it('explains the fair-value level on the mark method when adding a position', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'About Carry' });

    await user.click(screen.getByRole('button', { name: 'Add position' }));
    const tip = screen.getByRole('button', { name: 'About Default mark method' });
    await user.hover(tip);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Level 1/);
  });

  it('explains the calibration date on the mark form', async () => {
    const user = userEvent.setup();
    renderPage();

    // Expand the position to reveal the record-mark form.
    const row = await screen.findByRole('button', { name: /Acme/ });
    await user.click(row);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'About Date' })).toBeInTheDocument(),
    );
  });
});
