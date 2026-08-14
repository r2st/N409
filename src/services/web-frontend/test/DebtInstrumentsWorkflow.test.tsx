import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DebtInstrumentsPage } from '../src/pages/DebtInstrumentsPage';

/**
 * The Debt Instruments workspace end to end (feature: Debt Valuation Engine).
 *
 * The existing suite covers the tooltips — the things that explain a yield to
 * somebody who does not price bonds for a living. What it does not cover is
 * everything the page actually *does*: creating an instrument, editing its
 * parameters, valuing it, walking a yield curve, and saving credit terms. Those
 * are the paths where a silent failure costs a number, so each one is asserted
 * on both the request that goes out and the answer that comes back.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Request failed', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Instrument {
  id: string;
  name: string;
  instrument_type: string;
  currency: string;
  params: Record<string, unknown>;
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface ServerOptions {
  instruments?: Instrument[];
  creditTerms?: Record<string, unknown> | null;
  valuations?: Array<Record<string, unknown>>;
  /** Result for POST /value. A function sees the overrides the page sent. */
  result?: Record<string, unknown> | ((overrides: Record<string, unknown>) => Record<string, unknown>);
  /** `METHOD /path-fragment` → the problem response to answer it with. */
  fail?: Record<string, Response | (() => Response)>;
}

function makeInstrument(over: Partial<Instrument> = {}): Instrument {
  return { id: 'i1', name: 'Note A', instrument_type: 'bond', currency: 'USD', params: {}, ...over };
}

/**
 * A stand-in debt service that records every request.
 *
 * Routing is on method + path so a test can fail one verb of one endpoint —
 * which is the only way to tell "the save failed" apart from "the valuation
 * failed" when the page runs them back to back.
 */
function mockServer(options: ServerOptions = {}) {
  const instruments = options.instruments ?? [makeInstrument()];
  const calls: Call[] = [];

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input).replace('/api/v1', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });

    for (const [key, response] of Object.entries(options.fail ?? {})) {
      const [failMethod, fragment] = key.split(' ');
      if (method === failMethod && path.includes(fragment!)) {
        return typeof response === 'function' ? response() : response.clone();
      }
    }

    if (method === 'POST' && path.endsWith('/value')) {
      const overrides = (body?.overrides ?? {}) as Record<string, unknown>;
      const result =
        typeof options.result === 'function'
          ? options.result(overrides)
          : (options.result ?? { fair_value: 964.54 });
      return json({ result });
    }
    if (method === 'POST' && path === '/debt/instruments') {
      const created = makeInstrument({
        id: 'i-new',
        name: String(body?.name ?? ''),
        instrument_type: String(body?.instrument_type ?? 'bond'),
        currency: String(body?.currency ?? 'USD'),
        params: (body?.params ?? {}) as Record<string, unknown>,
      });
      instruments.push(created);
      return json({ instrument: created });
    }
    if (method === 'PUT') return json({ ok: true });
    if (/\/debt\/instruments\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      const found = instruments.find((i) => i.id === id) ?? instruments[0]!;
      return json({
        instrument: found,
        credit_terms: options.creditTerms ?? null,
        valuations: options.valuations ?? [],
      });
    }
    return json({ instruments });
  });

  return { calls, fetchSpy, instruments };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DebtInstrumentsPage />
    </MemoryRouter>,
  );
}

/**
 * `Field` wraps its control in a `<label>`, and a field with a tooltip puts the
 * tooltip's `<button>` inside that label too — so `getByLabelText` is ambiguous
 * and can hand back the button. Query by role instead, anchored to the start of
 * the accessible name (the trailing "?" of the tooltip trigger is part of it).
 */
const textbox = (label: string) =>
  screen.getByRole('textbox', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
const combo = (label: string) =>
  screen.getByRole('combobox', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });

/** The detail pane has rendered once its parameter card is on screen. */
const awaitDetail = (heading: RegExp) => screen.findByRole('heading', { name: heading });

/**
 * Read a nested object off a recorded request body.
 *
 * Casting the body to `Record<string, unknown>` and indexing it asserts a shape
 * the request may not have: a test that meant to check the `params` the page
 * sent would read `undefined` off a body that carried none and compare it to
 * `undefined`, passing while the page sent nothing at all. Narrowing instead
 * fails loudly, and names the call that was missing the key.
 */
function bodyObject(call: Call | undefined, key: string): Record<string, unknown> {
  const value = call?.body?.[key];
  if (typeof value !== 'object' || value === null) {
    const where = call ? `${call.method} ${call.path}` : 'a call that was never made';
    throw new Error(`expected ${where} to carry an object at "${key}", got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** A number the page sent under `overrides`, or a failure naming what it sent instead. */
function numericOverride(call: Call, key: string): number {
  const value = bodyObject(call, 'overrides')[key];
  if (typeof value !== 'number') {
    throw new Error(
      `expected ${call.method} ${call.path} to override "${key}" with a number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

describe('DebtInstrumentsPage — list and creation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers an empty state rather than a blank page when nothing is priced yet', async () => {
    mockServer({ instruments: [] });
    renderPage();
    expect(await screen.findByText('No instruments yet')).toBeInTheDocument();
    expect(screen.getByText(/Create a debt instrument to value it/)).toBeInTheDocument();
  });

  it('surfaces a failed load instead of showing an empty portfolio', async () => {
    mockServer({ instruments: [], fail: { 'GET /debt/instruments': problem(503, 'Engine unavailable') } });
    renderPage();
    expect(await screen.findByText('Engine unavailable')).toBeInTheDocument();
    // The distinction that matters: "we could not ask" must not read as
    // "you have none", which is what an unguarded empty state would say.
    expect(screen.queryByText('No instruments yet')).not.toBeInTheDocument();
  });

  it('selects the first instrument on arrival so the page is never half-loaded', async () => {
    const { calls } = mockServer({
      instruments: [makeInstrument(), makeInstrument({ id: 'i2', name: 'Loan B' })],
    });
    renderPage();
    await awaitDetail(/Bond parameters/);
    expect(calls.some((c) => c.method === 'GET' && c.path === '/debt/instruments/i1')).toBe(true);
  });

  it('switches the detail pane when another instrument is picked', async () => {
    mockServer({
      instruments: [
        makeInstrument(),
        makeInstrument({ id: 'i2', name: 'Loan B', instrument_type: 'term_loan' }),
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: /Loan B/ }));
    expect(await awaitDetail(/Term loan parameters/)).toBeInTheDocument();
  });

  it('creates an instrument seeded with its type defaults, then selects it', async () => {
    const { calls } = mockServer({ instruments: [] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('No instruments yet');

    await user.click(screen.getByRole('button', { name: 'New instrument' }));
    await user.type(textbox('Name'), 'Series A SAFE');
    await user.selectOptions(combo('Type'), 'safe');
    const currency = textbox('Currency');
    await user.clear(currency);
    await user.type(currency, 'eur');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const post = calls.find((c) => c.method === 'POST' && c.path === '/debt/instruments');
    expect(post?.body).toMatchObject({
      name: 'Series A SAFE',
      instrument_type: 'safe',
      // Lower-cased entry is normalised — ISO 4217 codes are upper-case and the
      // engine keys its formatting off them.
      currency: 'EUR',
    });
    // A new SAFE arrives priceable rather than blank: the per-type defaults are
    // sent with the create, not left for the user to discover.
    expect(post?.body?.params).toEqual({
      investment: 100000,
      valuation_cap: 5000000,
      discount: 0.2,
      next_round_pre_money: 20000000,
      next_round_shares: 10000000,
    });
    expect(await awaitDetail(/SAFE parameters/)).toBeInTheDocument();
  });

  it('sends booleans as booleans, not as the string "false"', async () => {
    const { calls } = mockServer({ instruments: [] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('No instruments yet');

    await user.click(screen.getByRole('button', { name: 'New instrument' }));
    await user.type(textbox('Name'), 'Amortizing loan');
    await user.selectOptions(combo('Type'), 'term_loan');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const post = calls.find((c) => c.method === 'POST' && c.path === '/debt/instruments');
    // `"false"` is truthy in Python and in JS. A term loan defaults to
    // amortizing and a bond does not, so the wrong type here silently reprices
    // the instrument on a different schedule.
    expect(bodyObject(post, 'params').amortizing).toBe(true);
  });

  it('keeps the form open and says why when the create is rejected', async () => {
    mockServer({ instruments: [], fail: { 'POST /debt/instruments': problem(422, 'Name already in use') } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('No instruments yet');

    await user.click(screen.getByRole('button', { name: 'New instrument' }));
    await user.type(textbox('Name'), 'Note A');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Name already in use')).toBeInTheDocument();
    // The typed name survives, so the fix is an edit rather than a retype.
    expect(textbox('Name')).toHaveValue('Note A');
  });

  it('closes the create form again on cancel', async () => {
    mockServer({ instruments: [] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('No instruments yet');

    await user.click(screen.getByRole('button', { name: 'New instrument' }));
    expect(textbox('Name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});

describe('DebtInstrumentsPage — valuing an instrument', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('seeds the parameter form from stored params and falls back to defaults', async () => {
    mockServer({ instruments: [makeInstrument({ params: { face: 5000, coupon_rate: 0.08 } })] });
    renderPage();
    await awaitDetail(/Bond parameters/);

    expect(textbox('Face')).toHaveValue('5000');
    expect(textbox('Coupon rate')).toHaveValue('0.08');
    // Unstored fields are not left blank — a partially-saved instrument still
    // prices, using the same defaults the create form uses.
    expect(textbox('Maturity (y)')).toHaveValue('5');
    expect(combo('Amortizing')).toHaveValue('false');
  });

  it('saves the edited parameters before valuing, and shows the result', async () => {
    const { calls } = mockServer({
      result: {
        fair_value: 964.54,
        dirty_price: 972.1,
        clean_price: 964.54,
        accrued_interest: 7.56,
        modified_duration: 4.2731,
        convexity: 22.41,
      },
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    const yieldField = textbox('Market yield');
    await user.clear(yieldField);
    await user.type(yieldField, '0.065');
    await user.click(screen.getByRole('button', { name: 'Value instrument' }));

    await screen.findByRole('heading', { name: 'Valuation result' });

    // The edit is persisted first — otherwise the engine prices the stored
    // parameters and the number on screen does not belong to the form above it.
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/debt/instruments/i1');
    expect(bodyObject(put, 'params').market_yield).toBe(0.065);
    expect(calls.findIndex((c) => c.method === 'PUT')).toBeLessThan(
      calls.findIndex((c) => c.path.endsWith('/value')),
    );

    expect(screen.getByText('Modified duration').nextSibling).toHaveTextContent('4.273');
    expect(screen.getByText('Convexity').nextSibling).toHaveTextContent('22.41');
    expect(screen.getByText('Accrued interest')).toBeInTheDocument();
    expect(screen.getByText(/Illustrative valuation. Not investment advice/)).toBeInTheDocument();
  });

  it('renders the cash-flow schedule the engine returns', async () => {
    mockServer({
      result: {
        fair_value: 1000,
        schedule: [
          { period: 1, t_years: 0.5, interest: 25, principal: 0, amount: 25, balance: 1000 },
          { period: 2, t_years: 1, interest: 25, principal: 1000, amount: 1025, balance: 0 },
        ],
      },
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);
    await user.click(screen.getByRole('button', { name: 'Value instrument' }));

    await screen.findByText('Cash-flow schedule');
    const rows = screen.getAllByRole('row');
    const final = rows.find((r) => within(r).queryByText('1,025.00') || within(r).queryByText('$1,025.00'));
    expect(final).toBeDefined();
    expect(within(final!).getByText('2')).toBeInTheDocument();
  });

  it('reports a failed valuation rather than leaving the button spinning', async () => {
    mockServer({ fail: { 'POST /debt/instruments/i1/value': problem(502, 'Debt engine timed out') } });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: 'Value instrument' }));
    expect(await screen.findByText('Debt engine timed out')).toBeInTheDocument();
    // `busy` is cleared in a finally, so the instrument stays priceable.
    expect(screen.getByRole('button', { name: 'Value instrument' })).toBeEnabled();
  });

  it('reports a failed parameter save without going on to value stale numbers', async () => {
    const { calls } = mockServer({
      fail: { 'PUT /debt/instruments/i1': problem(409, 'Instrument is locked') },
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: 'Value instrument' }));
    expect(await screen.findByText('Instrument is locked')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/value'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Valuation result' })).not.toBeInTheDocument();
  });

  it('surfaces a detail load failure', async () => {
    mockServer({ fail: { 'GET /debt/instruments/i1': problem(404, 'Instrument not found') } });
    renderPage();
    expect(await screen.findByText('Instrument not found')).toBeInTheDocument();
  });

  it('lists previous valuations, and dashes the ones that never produced a number', async () => {
    mockServer({
      valuations: [
        { id: 'v1', valuation_date: '2026-07-01', fair_value: '964.54', result: {} },
        { id: 'v2', valuation_date: '2026-06-01', fair_value: null, result: {} },
      ],
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Valuation history' });

    expect(screen.getByText('2026-07-01')).toBeInTheDocument();
    const failed = screen.getByText('2026-06-01').closest('tr')!;
    expect(within(failed).getByText('—')).toBeInTheDocument();
  });
});

describe('DebtInstrumentsPage — sensitivity', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('walks the market yield in five steps and tabulates the answers', async () => {
    const { calls } = mockServer({
      instruments: [makeInstrument({ params: { market_yield: 0.06 } })],
      result: (overrides) => ({ fair_value: 1000 - (overrides.market_yield as number) * 5000 }),
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: 'Yield sensitivity' }));
    await screen.findByRole('heading', { name: 'Sensitivity' });

    const shifted = calls
      .filter((c) => c.path.endsWith('/value'))
      .map((c) => numericOverride(c, 'market_yield'));
    expect(shifted.map((n) => Number(n.toFixed(4)))).toEqual([0.04, 0.05, 0.06, 0.07, 0.08]);

    const table = screen.getByRole('heading', { name: 'Sensitivity' }).parentElement!;
    expect(within(table).getByText('-2 bps×100')).toBeInTheDocument();
    expect(within(table).getByText('+2 bps×100')).toBeInTheDocument();
    // The unshifted row is the base case and is emphasised as such.
    const base = within(table).getByText('0 bps×100').closest('tr')!;
    expect(base.className).toContain('font-semibold');
  });

  it('never asks the engine for a negative yield', async () => {
    const { calls } = mockServer({ instruments: [makeInstrument({ params: { market_yield: 0.005 } })] });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: 'Yield sensitivity' }));
    await screen.findByRole('heading', { name: 'Sensitivity' });

    const shifted = calls
      .filter((c) => c.path.endsWith('/value'))
      .map((c) => numericOverride(c, 'market_yield'));
    expect(Math.min(...shifted)).toBe(0);
  });

  it('shifts the credit spread on a convertible, and says so on the button', async () => {
    const { calls } = mockServer({
      instruments: [makeInstrument({ instrument_type: 'convertible', params: { credit_spread: 0.02 } })],
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Convertible note parameters/);

    await user.click(screen.getByRole('button', { name: 'Spread sensitivity' }));
    await screen.findByRole('heading', { name: 'Sensitivity' });
    // A convertible has no `market_yield` field at all — shifting one would
    // have produced five identical rows and looked like a flat curve.
    const overrides = calls.filter((c) => c.path.endsWith('/value')).map((c) => c.body?.overrides);
    expect(overrides.every((o) => 'credit_spread' in (o as object))).toBe(true);
  });

  it('shifts the discount on a SAFE', async () => {
    const { calls } = mockServer({
      instruments: [makeInstrument({ instrument_type: 'safe', params: { discount: 0.2 } })],
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/SAFE parameters/);

    await user.click(screen.getByRole('button', { name: 'Discount sensitivity' }));
    await screen.findByRole('heading', { name: 'Sensitivity' });
    const overrides = calls.filter((c) => c.path.endsWith('/value')).map((c) => c.body?.overrides);
    expect(overrides.every((o) => 'discount' in (o as object))).toBe(true);
  });

  it('falls back to the dirty price when the engine reports no fair value', async () => {
    mockServer({ result: { dirty_price: 987.65 } });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: 'Yield sensitivity' }));
    const table = (await screen.findByRole('heading', { name: 'Sensitivity' })).parentElement!;
    expect(within(table).getAllByText(/987\.65/)).toHaveLength(5);
  });

  it('reports a failed sensitivity run', async () => {
    mockServer({ fail: { 'POST /debt/instruments/i1/value': problem(500, 'Tree build failed') } });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Bond parameters/);

    await user.click(screen.getByRole('button', { name: 'Yield sensitivity' }));
    expect(await screen.findByText('Tree build failed')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sensitivity' })).not.toBeInTheDocument();
  });
});

describe('DebtInstrumentsPage — per-type results', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('decomposes a convertible into its debt and option halves', async () => {
    mockServer({
      instruments: [makeInstrument({ instrument_type: 'convertible' })],
      result: { fair_value: 1120.4, straight_debt_value: 890.1, option_value: 230.3, parity: 800 },
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Convertible note parameters/);
    await user.click(screen.getByRole('button', { name: 'Value instrument' }));

    await screen.findByRole('heading', { name: 'Valuation result' });
    expect(screen.getByText('Straight-debt value')).toBeInTheDocument();
    expect(screen.getByText('Option value')).toBeInTheDocument();
    expect(screen.getByText('Conversion parity')).toBeInTheDocument();
    // The method is named on the artefact, because a convertible priced by a
    // binomial tree and one priced by TF are different numbers.
    expect(screen.getByText(/Tsiveriotis-Fernandes decomposition/)).toBeInTheDocument();
  });

  it('shows how a SAFE converts, and by which of its two terms', async () => {
    mockServer({
      instruments: [makeInstrument({ instrument_type: 'safe' })],
      result: {
        conversion_price: 0.5,
        shares_received: 200000,
        ownership_pct: 0.0196,
        converted_via: 'cap',
        moic: 1.63,
      },
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/SAFE parameters/);
    await user.click(screen.getByRole('button', { name: 'Value instrument' }));

    await screen.findByRole('heading', { name: 'Valuation result' });
    expect(screen.getByText('Shares received').nextSibling).toHaveTextContent('200,000');
    expect(screen.getByText('Ownership').nextSibling).toHaveTextContent('1.96%');
    // Cap or discount — which one won is the whole question a founder asks.
    expect(screen.getByText('Converts via').nextSibling).toHaveTextContent('cap');
    expect(screen.getByText('MOIC').nextSibling).toHaveTextContent('1.63×');
  });

  it('reports the all-in yield and spread on a credit-spread bond', async () => {
    mockServer({
      instruments: [makeInstrument({ instrument_type: 'credit_spread' })],
      result: { fair_value: 940.2, all_in_yield: 0.0685, credit_spread: 0.0185 },
    });
    const user = userEvent.setup();
    renderPage();
    await awaitDetail(/Credit-spread bond parameters/);
    await user.click(screen.getByRole('button', { name: 'Value instrument' }));

    await screen.findByRole('heading', { name: 'Valuation result' });
    expect(screen.getByText('All-in yield').nextSibling).toHaveTextContent('6.85%');
    expect(screen.getByText('Credit spread').nextSibling).toHaveTextContent('1.85%');
  });
});

describe('DebtInstrumentsPage — credit terms', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers credit terms only on the instrument type that prices from them', async () => {
    mockServer({ instruments: [makeInstrument({ instrument_type: 'bond' })] });
    renderPage();
    await awaitDetail(/Bond parameters/);
    expect(screen.queryByRole('heading', { name: 'Credit terms' })).not.toBeInTheDocument();
  });

  it('seeds the card from stored terms and saves an explicit spread', async () => {
    const { calls } = mockServer({
      instruments: [makeInstrument({ instrument_type: 'credit_spread' })],
      creditTerms: {
        rating: 'BB',
        benchmark_yield: '0.042',
        spread: '0.031',
        seniority: 'subordinated',
        secured: true,
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Credit terms' });

    expect(textbox('Rating')).toHaveValue('BB');
    expect(combo('Seniority')).toHaveValue('subordinated');
    expect(screen.getByRole('checkbox', { name: /Secured/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Save credit terms' }));
    const put = calls.find((c) => c.path.endsWith('/credit-terms'));
    expect(put?.body).toEqual({
      rating: 'BB',
      benchmark_yield: 0.042,
      spread: 0.031,
      seniority: 'subordinated',
      secured: true,
    });
  });

  it('sends a blank spread as null so the engine infers it from the rating', async () => {
    const { calls } = mockServer({ instruments: [makeInstrument({ instrument_type: 'credit_spread' })] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Credit terms' });

    // Defaults, with `spread` deliberately left empty.
    await user.click(screen.getByRole('button', { name: 'Save credit terms' }));
    const put = calls.find((c) => c.path.endsWith('/credit-terms'));
    // `Number('')` is 0, and a zero spread is a different instrument from one
    // whose spread the engine is being asked to derive.
    expect(put?.body?.spread).toBeNull();
    expect(put?.body?.rating).toBe('BBB');
  });

  it('sends a cleared rating as null rather than an empty string', async () => {
    const { calls } = mockServer({ instruments: [makeInstrument({ instrument_type: 'credit_spread' })] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Credit terms' });

    await user.clear(textbox('Rating'));
    await user.clear(textbox('Benchmark yield'));
    await user.click(screen.getByRole('button', { name: 'Save credit terms' }));

    const put = calls.find((c) => c.path.endsWith('/credit-terms'));
    expect(put?.body?.rating).toBeNull();
    expect(put?.body?.benchmark_yield).toBeNull();
  });

  it('toggles secured and records the change', async () => {
    const { calls } = mockServer({ instruments: [makeInstrument({ instrument_type: 'credit_spread' })] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Credit terms' });

    await user.click(screen.getByRole('checkbox', { name: /Secured/ }));
    await user.selectOptions(combo('Seniority'), 'mezzanine');
    await user.click(screen.getByRole('button', { name: 'Save credit terms' }));

    const put = calls.find((c) => c.path.endsWith('/credit-terms'));
    expect(put?.body).toMatchObject({ secured: true, seniority: 'mezzanine' });
  });

  it('says why a credit-terms save failed', async () => {
    mockServer({
      instruments: [makeInstrument({ instrument_type: 'credit_spread' })],
      fail: { 'PUT /debt/instruments/i1/credit-terms': problem(422, 'Unknown rating scale') },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Credit terms' });

    await user.click(screen.getByRole('button', { name: 'Save credit terms' }));
    expect(await screen.findByText('Unknown rating scale')).toBeInTheDocument();
  });
});
