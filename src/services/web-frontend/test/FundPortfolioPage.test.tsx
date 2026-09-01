import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FundPortfolioPage } from '../src/pages/FundPortfolioPage';

const fund = { id: 'f1', name: 'Growth Fund I', fund_type: 'vc', currency: 'USD', vintage_year: 2021 };
const otherFund = {
  id: 'f2',
  name: 'Credit Fund II',
  fund_type: 'credit',
  currency: 'EUR',
  vintage_year: 2023,
};
const position = {
  id: 'p1',
  company_name: 'Acme',
  security_type: 'preferred',
  quantity: '1000',
  cost_basis: '500000',
  mark_method: 'calibrated_opm',
  latest_mark: {
    id: 'm1',
    measurement_date: '2026-03-31',
    method: 'calibrated_opm',
    fair_value: '750000',
    level: 3,
  },
};
const detail = { fund, lp_terms: null, positions: [position] };
const nav = {
  net_asset_value: 750000,
  gross_asset_value: 800000,
  total_cost_basis: 500000,
  total_unrealized_gain: 250000,
  liabilities: 50000,
  level_breakdown: { level_1: 10000, level_2: 20000, level_3: 720000 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (detail: string, status = 422) =>
  new Response(JSON.stringify({ title: 'Unprocessable', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** Every write the page can make, in the order it made them. */
interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

const waterfallResult = {
  distributable: 1000000,
  lp_distribution: 900000,
  gp_distribution: 100000,
  clawback_owed: 0,
  tiers: {},
};

interface Overrides {
  funds?: unknown[];
  detail?: unknown;
  marks?: unknown[];
  /** Return a Response to answer a write yourself; undefined falls through. */
  onWrite?: (path: string, body: Record<string, unknown>) => Response | undefined;
}

function mockApi(over: Overrides = {}) {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      sent.push({ path, method, body });
      const answer = over.onWrite?.(path, body);
      if (answer) return answer;
      if (path.endsWith('/funds')) return jsonResponse({ fund });
      if (path.endsWith('/waterfall')) return jsonResponse({ waterfall: waterfallResult });
      return jsonResponse({});
    }
    if (path.includes('/positions/') && path.endsWith('/marks')) {
      return jsonResponse({ marks: over.marks ?? [] });
    }
    if (path.endsWith('/nav')) return jsonResponse({ nav });
    if (/\/funds\/[^/]+$/.test(path)) return jsonResponse(over.detail ?? detail);
    return jsonResponse({ funds: over.funds ?? [fund] });
  });
  return sent;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FundPortfolioPage />
    </MemoryRouter>,
  );
}

describe('FundPortfolioPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a contextual HelpIcon that opens the fund-holdings article', async () => {
    mockApi();
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
    mockApi();
    renderPage();
    // WaterfallCard renders once the fund detail loads.
    expect(await screen.findByRole('button', { name: 'About the LP waterfall' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Carry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Pref return' })).toBeInTheDocument();
  });

  it('explains the fair-value level on the mark method when adding a position', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'About Carry' });

    await user.click(screen.getByRole('button', { name: 'Add position' }));
    const tip = screen.getByRole('button', { name: 'About Default mark method' });
    await user.hover(tip);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Level 1/);
  });

  it('explains the calibration date on the mark form', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    // Expand the position to reveal the record-mark form.
    const row = await screen.findByRole('button', { name: /Acme/ });
    await user.click(row);
    await waitFor(() => expect(screen.getByRole('button', { name: 'About Date' })).toBeInTheDocument());
  });

  /*
   * NAV and the hierarchy disclosure. The three levels are the point of the
   * whole surface — an auditor reads how much of the fund is marked to a model
   * before anything else — so each has to carry its own figure rather than the
   * table rendering with three copies of the total.
   */
  it('rolls the positions into NAV and discloses the ASC 820 hierarchy', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('$750,000')).toBeInTheDocument();
    expect(screen.getByText('$800,000')).toBeInTheDocument();
    expect(screen.getByText('$500,000')).toBeInTheDocument();
    expect(screen.getByText('$250,000')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('$10,000')).toBeInTheDocument();
    expect(within(table).getByText('$20,000')).toBeInTheDocument();
    expect(within(table).getByText('$720,000')).toBeInTheDocument();
  });

  /** A fund with nothing in it has no NAV to state, and must not invent one. */
  it('skips NAV entirely for a fund with no positions', async () => {
    mockApi({ detail: { fund, lp_terms: null, positions: [] } });
    renderPage();

    expect(
      await screen.findByText('No positions. Add a holding to mark it to fair value.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Net asset value')).not.toBeInTheDocument();
    expect(screen.queryByText('ASC 820 fair-value hierarchy')).not.toBeInTheDocument();
  });

  it('invites the first fund when the operator has none', async () => {
    mockApi({ funds: [] });
    renderPage();
    expect(await screen.findByText('No funds yet')).toBeInTheDocument();
    expect(screen.getByText(/Create a fund to start marking/)).toBeInTheDocument();
  });

  it('creates a fund, upper-cases its currency and selects it', async () => {
    const created = { ...otherFund, id: 'f9', name: 'Seed Fund III' };
    const sent = mockApi({
      onWrite: (path) => (path.endsWith('/funds') ? jsonResponse({ fund: created }) : undefined),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Growth Fund I/ });

    await user.click(screen.getByRole('button', { name: 'New fund' }));
    await user.type(screen.getByLabelText('Fund name'), 'Seed Fund III');
    await user.selectOptions(screen.getByLabelText('Type'), 'growth');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'gbp');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      name: 'Seed Fund III',
      fund_type: 'growth',
      currency: 'GBP',
      vintage_year: 2024,
    });
    // The form closes on success, so the toggle reads "New fund" again.
    await waitFor(() => expect(screen.queryByLabelText('Fund name')).not.toBeInTheDocument());
  });

  /** A blank vintage is "unknown", not year zero. */
  it('sends a blank vintage as null', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Growth Fund I/ });

    await user.click(screen.getByRole('button', { name: 'New fund' }));
    await user.type(screen.getByLabelText('Fund name'), 'Vintageless');
    await user.clear(screen.getByLabelText('Vintage'));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.vintage_year).toBeNull();
  });

  it('keeps the create form open, with its draft, when the fund is rejected', async () => {
    mockApi({
      onWrite: (path) =>
        path.endsWith('/funds') ? problem('A fund named Seed Fund III already exists.') : undefined,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Growth Fund I/ });

    await user.click(screen.getByRole('button', { name: 'New fund' }));
    await user.type(screen.getByLabelText('Fund name'), 'Seed Fund III');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('A fund named Seed Fund III already exists.')).toBeInTheDocument();
    expect(screen.getByLabelText('Fund name')).toHaveValue('Seed Fund III');
  });

  it('abandons the create form on Cancel', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Growth Fund I/ });

    await user.click(screen.getByRole('button', { name: 'New fund' }));
    expect(screen.getByLabelText('Fund name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Fund name')).not.toBeInTheDocument();
  });

  it('surfaces a failed fund list rather than an empty page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('Ops access required.', 403));
    renderPage();
    expect(await screen.findByText('Ops access required.')).toBeInTheDocument();
  });

  it('falls back to a plain message when the fund list fails without a problem body', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    renderPage();
    expect(await screen.findByText(/Could not load the fund list\./)).toBeInTheDocument();
  });

  it('switches funds, and remounts the detail so nothing carries over', async () => {
    mockApi({ funds: [fund, otherFund] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Positions');

    const second = screen.getByRole('button', { name: /Credit Fund II/ });
    expect(second).toHaveTextContent('CREDIT');
    await user.click(second);
    // The detail is keyed by fund id, so it refetches rather than showing f1's.
    await waitFor(() => expect(screen.getByText('Positions')).toBeInTheDocument());
  });

  it('adds a position, sending quantity and cost basis as numbers', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Positions');

    await user.click(screen.getByRole('button', { name: 'Add position' }));
    await user.type(screen.getByLabelText('Company'), 'Globex');
    await user.selectOptions(screen.getByLabelText('Security'), 'safe');
    // A tooltipped Field puts a <button> inside the <label>, and a button is a
    // labelable element — so the label matches the trigger as well as the input.
    await user.selectOptions(screen.getByLabelText('Default mark method', { selector: 'select' }), 'market');
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '250');
    await user.clear(screen.getByLabelText('Cost basis'));
    await user.type(screen.getByLabelText('Cost basis'), '125000');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toContain('/funds/f1/positions');
    expect(sent[0]!.body).toEqual({
      company_name: 'Globex',
      security_type: 'safe',
      quantity: 250,
      cost_basis: 125000,
      mark_method: 'market',
    });
  });

  it('keeps the position form open, with its draft, when the write is rejected', async () => {
    mockApi({
      onWrite: (path) =>
        path.endsWith('/positions') ? problem('quantity must be greater than zero') : undefined,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Positions');

    await user.click(screen.getByRole('button', { name: 'Add position' }));
    await user.type(screen.getByLabelText('Company'), 'Globex');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('quantity must be greater than zero')).toBeInTheDocument();
    expect(screen.getByLabelText('Company')).toHaveValue('Globex');
  });

  it('states each position’s latest mark and its fair-value level', async () => {
    mockApi();
    renderPage();
    const row = await screen.findByRole('button', { name: /Acme/ });
    expect(row).toHaveTextContent('$750,000 · L3');
    expect(row).toHaveTextContent('preferred');
  });

  /** Never marked means there is no fair value to show — cost is what is known. */
  it('falls back to cost basis on a position that has never been marked', async () => {
    mockApi({
      detail: { fund, lp_terms: null, positions: [{ ...position, latest_mark: null }] },
    });
    renderPage();
    const row = await screen.findByRole('button', { name: /Acme/ });
    expect(row).toHaveTextContent('cost $500,000');
  });

  it('loads the mark history once, on first expand', async () => {
    mockApi({
      marks: [
        {
          id: 'm1',
          measurement_date: '2026-03-31',
          method: 'calibrated_opm',
          fair_value: '750000',
          level: 3,
        },
        {
          id: 'm0',
          measurement_date: '2025-12-31',
          method: 'last_round',
          fair_value: '600000',
          level: 2,
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    const row = await screen.findByRole('button', { name: /Acme/ });
    await user.click(row);
    expect(await screen.findByText('2025-12-31')).toBeInTheDocument();
    expect(screen.getByText('L2')).toBeInTheDocument();
    expect(screen.getByText('$600,000')).toBeInTheDocument();

    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await user.click(row); // collapse
    await user.click(row); // re-expand — history is already in hand
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });

  it('says so when a position has no marks yet', async () => {
    mockApi({ marks: [] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    expect(await screen.findByText('No marks yet.')).toBeInTheDocument();
  });

  /*
   * The mark form sends a different body per method, and sending the wrong one
   * is how a Level 3 model value ends up recorded as a quoted price. Each
   * branch gets its own case.
   */
  it('records a market mark as quantity × quoted price', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    await user.type(await screen.findByLabelText('Quoted price'), '12.5');
    await user.click(screen.getByRole('button', { name: 'Record mark' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toContain('/funds/f1/positions/p1/marks');
    expect(sent[0]!.body).toEqual({
      measurement_date: '2026-03-31',
      method: 'market',
      quantity: 1000,
      quoted_price: 12.5,
    });
  });

  it('records a last-round mark as quantity × round price per share', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    await user.selectOptions(await screen.findByLabelText('Method'), 'last_round');
    await user.type(screen.getByLabelText('Round price/sh'), '9');
    await user.click(screen.getByRole('button', { name: 'Record mark' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      measurement_date: '2026-03-31',
      method: 'last_round',
      quantity: 1000,
      round_price_per_share: 9,
    });
  });

  it('records a calibrated OPM mark as a model value, with no per-share price', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    await user.selectOptions(await screen.findByLabelText('Method'), 'calibrated_opm');
    await user.type(screen.getByLabelText('Model value'), '820000');
    await user.click(screen.getByRole('button', { name: 'Record mark' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      measurement_date: '2026-03-31',
      method: 'calibrated_opm',
      model_value: 820000,
    });
    expect(sent[0]!.body).not.toHaveProperty('quantity');
  });

  /** Cost carries no figure of its own — the position's basis is the mark. */
  /**
   * R30 — every money box on this page is plain text read with `Number(...)`,
   * so "1,200" became NaN and reached the API as null, and a blank quoted
   * price posted a fair value of zero. Neither said anything at the box.
   */
  it('refuses a market mark with no quoted price rather than marking it at zero', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    await user.click(await screen.findByRole('button', { name: 'Record mark' }));

    expect(await screen.findByText('Quoted price is required.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('refuses a quantity that is not a number, at the box', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add position' }));
    await user.type(await screen.findByLabelText('Company'), 'Beta Ltd');
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '1,200');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Quantity must be a number.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('refuses a vintage outside the years a fund can have, but allows none', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New fund' }));
    await user.type(await screen.findByLabelText('Fund name'), 'Fund IV');
    await user.clear(screen.getByLabelText('Vintage'));
    await user.type(screen.getByLabelText('Vintage'), '3024');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Vintage must be at most 2100.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('records a cost mark with neither a price nor a model value', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    await user.selectOptions(await screen.findByLabelText('Method'), 'cost');
    expect(screen.queryByLabelText('Quoted price')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model value')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record mark' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ measurement_date: '2026-03-31', method: 'cost' });
  });

  it('reports a rejected mark against the position that was marked', async () => {
    mockApi({
      onWrite: (path) =>
        path.endsWith('/marks') ? problem('measurement_date is before the fund vintage') : undefined,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Acme/ }));
    // The default method is Market, and a market mark now needs its price
    // before the request is made at all — the subject here is what happens to
    // the server's objection, not what happens without one.
    await user.type(await screen.findByLabelText('Quoted price'), '4.25');
    await user.click(await screen.findByRole('button', { name: 'Record mark' }));
    expect(await screen.findByText('measurement_date is before the fund vintage')).toBeInTheDocument();
  });

  /*
   * LP terms. The defaults are the market-standard 8 / 20 with catch-up, and
   * the card has to send what is on screen — a saved carry of 0.2 that reaches
   * the server as 20 is a hundredfold error in the GP's favour.
   */
  it('saves LP terms as numbers, from the stated defaults', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.clear(screen.getByLabelText('Committed'));
    await user.type(screen.getByLabelText('Committed'), '50000000');
    await user.clear(screen.getByLabelText('Contributed'));
    await user.type(screen.getByLabelText('Contributed'), '30000000');
    await user.click(screen.getByRole('button', { name: 'Save LP terms' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.path).toContain('/funds/f1/lp-terms');
    expect(sent[0]!.body).toEqual({
      committed_capital: 50000000,
      contributed_capital: 30000000,
      preferred_return_rate: 0.08,
      carry_pct: 0.2,
      gp_catch_up: true,
      management_fee_pct: 0.02,
      management_fees_paid: 0,
      gp_distributions_to_date: 0,
    });
  });

  /**
   * The save writes the whole `lp_terms` row, so the card has to carry the
   * whole row.
   *
   * It carried five of the eight columns. The route's body schema defaults the
   * other three and the repo upserts all of them, so saving a changed carry
   * also reset the management fee to 2%, and the fees paid and GP
   * distributions to zero — figures the waterfall nets off the GP's share and
   * the NAV exhibit prints. Nothing else writes them, so the reset was
   * permanent and invisible.
   */
  it('carries the LP terms it does not change through a save', async () => {
    const sent = mockApi({
      detail: {
        fund,
        positions: [position],
        lp_terms: {
          committed_capital: '100000000',
          contributed_capital: '75000000',
          preferred_return_rate: '0.06',
          carry_pct: '0.25',
          gp_catch_up: false,
          management_fee_pct: '0.015',
          management_fees_paid: '4200000',
          gp_distributions_to_date: '9000000',
        },
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.click(screen.getByRole('button', { name: 'Save LP terms' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({
      management_fee_pct: 0.015,
      management_fees_paid: 4200000,
      gp_distributions_to_date: 9000000,
    });
  });

  it('lets an operator edit the fee and distribution terms', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.clear(screen.getByLabelText('Fees paid', { selector: 'input' }));
    await user.type(screen.getByLabelText('Fees paid', { selector: 'input' }), '1250000');
    await user.clear(screen.getByLabelText('GP distributions', { selector: 'input' }));
    await user.type(screen.getByLabelText('GP distributions', { selector: 'input' }), '3000000');
    await user.click(screen.getByRole('button', { name: 'Save LP terms' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({
      management_fees_paid: 1250000,
      gp_distributions_to_date: 3000000,
    });
  });

  it('seeds the terms from the fund’s stored LP agreement when it has one', async () => {
    mockApi({
      detail: {
        fund,
        positions: [position],
        lp_terms: {
          committed_capital: '100000000',
          contributed_capital: '75000000',
          preferred_return_rate: '0.06',
          carry_pct: '0.25',
          gp_catch_up: false,
        },
      },
    });
    renderPage();

    expect(await screen.findByLabelText('Committed')).toHaveValue('100000000');
    expect(screen.getByLabelText('Pref return', { selector: 'input' })).toHaveValue('0.06');
    expect(screen.getByLabelText('Carry', { selector: 'input' })).toHaveValue('0.25');
    expect(screen.getByRole('checkbox', { name: /GP catch-up/ })).not.toBeChecked();
  });

  it('sends the GP catch-up as the operator left it', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.click(screen.getByRole('checkbox', { name: /GP catch-up/ }));
    await user.click(screen.getByRole('button', { name: 'Save LP terms' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.gp_catch_up).toBe(false);
  });

  it('reports a rejected LP-terms save', async () => {
    mockApi({
      onWrite: (path) =>
        path.endsWith('/lp-terms') ? problem('contributed capital exceeds committed') : undefined,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.click(screen.getByRole('button', { name: 'Save LP terms' }));
    expect(await screen.findByText('contributed capital exceeds committed')).toBeInTheDocument();
  });

  it('runs the waterfall and splits the proceeds between LPs and the GP', async () => {
    const sent = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.clear(screen.getByLabelText('Distributable'));
    await user.type(screen.getByLabelText('Distributable'), '1000000');
    await user.clear(screen.getByLabelText('Years'));
    await user.type(screen.getByLabelText('Years'), '5');
    await user.click(screen.getByRole('button', { name: 'Run waterfall' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ distributable: 1000000, years: 5 });
    expect(await screen.findByText('$900,000')).toBeInTheDocument();
    expect(screen.getByText('$100,000')).toBeInTheDocument();
    expect(screen.getByText('To LPs')).toBeInTheDocument();
    expect(screen.getByText('Clawback owed')).toBeInTheDocument();
  });

  it('reports a rejected waterfall run without clearing an earlier result', async () => {
    mockApi({
      onWrite: (path) => (path.endsWith('/waterfall') ? problem('LP terms must be saved first') : undefined),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('LP waterfall calculator');

    await user.click(screen.getByRole('button', { name: 'Run waterfall' }));
    expect(await screen.findByText('LP terms must be saved first')).toBeInTheDocument();
    expect(screen.queryByText('To LPs')).not.toBeInTheDocument();
  });

  it('surfaces a failed fund detail without blanking the fund picker', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (/\/funds\/[^/]+$/.test(path)) return problem('Fund not found.', 404);
      return jsonResponse({ funds: [fund] });
    });
    renderPage();

    expect(await screen.findByText('Fund not found.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Growth Fund I/ })).toBeInTheDocument();
  });

  it('renders each fund’s own currency', async () => {
    mockApi({
      funds: [otherFund],
      detail: { fund: otherFund, lp_terms: null, positions: [position] },
    });
    renderPage();
    // EUR, not the USD of the first fund in the list.
    expect(await screen.findByText('€750,000')).toBeInTheDocument();
  });

  /**
   * Recording a mark and running the waterfall both write and then reload, and
   * neither used to render anything in between. On this page that silence is
   * expensive: a duplicate mark is a second valuation of the same position on
   * the same measurement date, which is exactly the fact an auditor reads off
   * this screen.
   */
  describe('while a write is in flight', () => {
    /** Holds every write open until `release()`, so the in-flight frame exists. */
    function gate() {
      let open!: () => void;
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      const sent = mockApi({
        // The mock awaits whatever `onWrite` returns, so a pending promise here
        // parks the request instead of answering it.
        onWrite: () => held.then(() => jsonResponse({ waterfall: waterfallResult })) as unknown as Response,
      });
      return { sent, release: () => open() };
    }

    it('says a mark is being recorded and will not record it twice', async () => {
      const { sent, release } = gate();
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /Acme/ }));
      await user.type(await screen.findByLabelText('Quoted price'), '12.5');
      await user.click(screen.getByRole('button', { name: 'Record mark' }));

      const recording = await screen.findByRole('button', { name: 'Recording…' });
      expect(recording).toBeDisabled();
      await user.click(recording);
      expect(sent).toHaveLength(1);

      release();
      await screen.findByRole('button', { name: 'Record mark' });
    });

    it('says the waterfall is running, and blocks the terms save under it', async () => {
      const { sent, release } = gate();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('LP waterfall calculator');

      await user.click(screen.getByRole('button', { name: 'Run waterfall' }));
      expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled();
      // The two controls share the card and the same fund, so saving terms
      // mid-run would change the inputs of the calculation being displayed.
      expect(screen.getByRole('button', { name: 'Save LP terms' })).toBeDisabled();
      expect(sent).toHaveLength(1);

      release();
      await screen.findByRole('button', { name: 'Run waterfall' });
    });

    it('says LP terms are saving, and blocks the run under it', async () => {
      const { release } = gate();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('LP waterfall calculator');

      await user.click(screen.getByRole('button', { name: 'Save LP terms' }));
      expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Run waterfall' })).toBeDisabled();

      release();
      await screen.findByRole('button', { name: 'Save LP terms' });
    });
  });
});
