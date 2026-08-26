import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FundPortfolioPage } from '../src/pages/FundPortfolioPage';
import { DebtInstrumentsPage } from '../src/pages/DebtInstrumentsPage';

/**
 * A create button that stays live while its own POST is in flight.
 *
 * `funds`, `fund_positions` and `debt_instruments` carry no uniqueness of their
 * own — migrations 0086 and 0087 declare none — so the server has nothing to
 * refuse a second identical write with. The panel holding the form is closed by
 * the *success* branch, which means it stays on screen for the whole round
 * trip; a second click in that window posted a second row and the page then
 * reloaded and showed both.
 *
 * A duplicated fund or instrument is a mess someone has to clean up. A
 * duplicated *position* is worse than a mess: `/funds/:id/nav` sums the
 * positions, so the holding is counted twice and the fund's net asset value —
 * the number the ASC 820 marks feed — is overstated with nothing on screen
 * saying why.
 *
 * The three forms below were the only writes on those two pages without an
 * in-flight guard; `recording` on the mark form and `busy` on the LP-terms and
 * waterfall cards already had one.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fetch stub whose writes never answer, so the click under test happens while
 * the first POST is still outstanding — which is the whole window the bug lives
 * in. Reads answer normally so the page renders.
 */
function mockApiWithHangingWrites(read: (path: string) => Response) {
  const writes: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(path);
      // Never settles: the create is in flight for the rest of the test.
      return new Promise<Response>(() => {});
    }
    return read(path);
  });
  return writes;
}

const fund = { id: 'f1', name: 'Growth Fund I', fund_type: 'vc', currency: 'USD', vintage_year: 2021 };
const position = {
  id: 'p1',
  company_name: 'Acme',
  security_type: 'preferred',
  quantity: '1000',
  cost_basis: '500000',
  mark_method: 'cost',
  latest_mark: null,
};
const nav = {
  net_asset_value: 500000,
  gross_asset_value: 500000,
  total_cost_basis: 500000,
  total_unrealized_gain: 0,
  liabilities: 0,
  level_breakdown: { level_1: 0, level_2: 0, level_3: 500000 },
};

function fundReads(path: string): Response {
  if (path.includes('/positions/') && path.endsWith('/marks')) return jsonResponse({ marks: [] });
  if (path.endsWith('/nav')) return jsonResponse({ nav });
  if (/\/funds\/[^/]+$/.test(path)) {
    return jsonResponse({ fund, lp_terms: null, positions: [position] });
  }
  return jsonResponse({ funds: [fund], truncated: false });
}

const instrument = { id: 'i1', name: 'Note A', instrument_type: 'bond', currency: 'USD', params: {} };

function debtReads(path: string): Response {
  if (/\/debt\/instruments\/[^/]+$/.test(path)) {
    return jsonResponse({ instrument, credit_terms: null, valuations: [] });
  }
  return jsonResponse({ instruments: [instrument] });
}

describe('a create form refuses a second submit while the first is in flight', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts one fund for a double-clicked Create', async () => {
    const writes = mockApiWithHangingWrites(fundReads);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FundPortfolioPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'New fund' }));
    await user.type(screen.getByLabelText('Fund name'), 'Second Fund');

    const create = screen.getByRole('button', { name: 'Create' });
    await user.click(create);
    await user.click(create);

    expect(writes.filter((p) => p.endsWith('/funds'))).toHaveLength(1);
    expect(create).toBeDisabled();
  });

  it('posts one position for a double-clicked Add', async () => {
    const writes = mockApiWithHangingWrites(fundReads);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FundPortfolioPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Add position' }));
    await user.type(screen.getByLabelText('Company'), 'Beta Corp');

    const add = screen.getByRole('button', { name: 'Add' });
    await user.click(add);
    await user.click(add);

    expect(writes.filter((p) => p.endsWith('/positions'))).toHaveLength(1);
    expect(add).toBeDisabled();
  });

  it('posts one instrument for a double-clicked Create', async () => {
    const writes = mockApiWithHangingWrites(debtReads);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <DebtInstrumentsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'New instrument' }));
    await user.type(screen.getByLabelText('Name'), 'Note B');

    const create = screen.getByRole('button', { name: 'Create' });
    await user.click(create);
    await user.click(create);

    expect(writes.filter((p) => p.endsWith('/debt/instruments'))).toHaveLength(1);
    expect(create).toBeDisabled();
  });
});
