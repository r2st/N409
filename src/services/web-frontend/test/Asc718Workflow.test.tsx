import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { Asc718Tab } from '../src/pages/valuation/Asc718Tab';
import type { User, Valuation } from '../src/lib/types';

/**
 * The ASC 718 workspace end to end (feature: ASC 718 Public).
 *
 * The existing suite covers the tooltips and the RBAC gate. What it does not
 * cover is everything the tab actually *does*: saving the company-type
 * settings, building the measurement request, and rendering the four result
 * tables. Those are the paths where a silent failure costs a compensation
 * charge, so each is asserted on both the request that goes out and the answer
 * that comes back.
 *
 * The request is where most of the risk sits. `run` assembles a payload by
 * hand — filtering grants without an exercise price, attaching the
 * performance-only and market-only RSU fields conditionally, omitting blank
 * defaults rather than sending them as zero — and every one of those decisions
 * silently changes the number the engine returns.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '718',
  state: 'started',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Request failed', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface Settings {
  valuation_id: string;
  company_type: 'private' | 'public';
  ticker: string | null;
  expected_term_method: 'simplified' | 'lattice' | 'historical';
  espp_discount_pct: string | null;
  espp_lookback_months: number | null;
}

const makeSettings = (over: Partial<Settings> = {}): Settings => ({
  valuation_id: valuation.id,
  company_type: 'private',
  ticker: null,
  expected_term_method: 'simplified',
  espp_discount_pct: null,
  espp_lookback_months: null,
  ...over,
});

/** The measurement response, empty in every arm unless a test fills one in. */
const emptyResult = {
  company_type: 'private' as const,
  ticker: null,
  market: null,
  options: null,
  espp: [],
  rsu: [],
  tsr: [],
  valuation_fmv_per_share: null,
  currency: 'USD',
};

interface ServerOptions {
  settings?: Settings | null;
  result?: Record<string, unknown>;
  /** `METHOD /path-fragment` → the response to answer it with. */
  fail?: Record<string, Response | (() => Response)>;
}

function mockServer(options: ServerOptions = {}) {
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

    if (path.endsWith('/asc718/settings')) {
      if (method === 'PUT') {
        return json({
          settings: makeSettings({
            company_type: body?.company_type as Settings['company_type'],
            ticker: (body?.ticker as string | null) ?? null,
            expected_term_method: body?.expected_term_method as Settings['expected_term_method'],
          }),
        });
      }
      return json({ settings: options.settings ?? null });
    }
    if (method === 'POST' && path.endsWith('/asc718')) {
      return json({ asc718: { ...emptyResult, ...(options.result ?? {}) } });
    }
    return json({});
  });

  return { calls, fetchSpy };
}

function WithWorkspace() {
  return <Outlet context={{ valuation, reload: async () => {} }} />;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/asc718']}>
      <Routes>
        <Route element={<WithWorkspace />}>
          <Route path="/asc718" element={<Asc718Tab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The tab has finished its settings load once the company-type control is up. */
const awaitLoaded = () => screen.findByRole('combobox', { name: /^Company type/ });

/**
 * `Field` puts a tooltip trigger inside its `<label>`, so the accessible name
 * carries a trailing "?" and `getByLabelText` is ambiguous. Query by role,
 * anchored to the start of the name, and scoped to one card — "Label" and
 * "Risk-free" appear in three sections at once.
 */
const card = (heading: string): HTMLElement =>
  screen.getByRole('heading', { name: heading }).closest('div.rounded-lg') as HTMLElement;

const boxIn = (scope: HTMLElement, label: string) =>
  within(scope).getByRole('textbox', { name: new RegExp(`^${label}`) });

/** The POST that ran the measurement. */
const runCall = (calls: Call[]) => calls.find((c) => c.method === 'POST' && c.path.endsWith('/asc718'));

/** Grants on the run payload, as the page sent them. */
function grantsOf(calls: Call[]): Array<Record<string, unknown>> {
  const grants = runCall(calls)?.body?.grants;
  if (!Array.isArray(grants)) throw new Error('the run carried no grants array');
  return grants as Array<Record<string, unknown>>;
}

async function goPublic(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await awaitLoaded(), 'public');
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockUser = opsUser;
});

describe('Asc718Tab — settings', () => {
  it('restores the saved company type, ticker and term method', async () => {
    mockServer({
      settings: makeSettings({ company_type: 'public', ticker: 'ACME', expected_term_method: 'lattice' }),
    });
    renderTab();

    expect(await awaitLoaded()).toHaveValue('public');
    expect(screen.getByRole('textbox', { name: /^Ticker/ })).toHaveValue('ACME');
    expect(screen.getByRole('combobox', { name: /^Expected-term method/ })).toHaveValue('lattice');
    expect(screen.getByText(/Settings saved\. Company type: public\./)).toBeInTheDocument();
  });

  /** A valuation that has never had settings saved must still render the tab. */
  it('renders with defaults when nothing has been saved yet', async () => {
    mockServer({ settings: null });
    renderTab();

    expect(await awaitLoaded()).toHaveValue('private');
    expect(screen.queryByRole('textbox', { name: /^Ticker/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Settings saved/)).not.toBeInTheDocument();
  });

  it('renders the tab even when the settings request fails outright', async () => {
    mockServer({ fail: { 'GET /asc718/settings': problem(500, 'boom') } });
    renderTab();

    // Settings are optional; a failed load is not a failed tab.
    expect(await awaitLoaded()).toHaveValue('private');
  });

  /**
   * The ticker is uppercased and trimmed on the way out, and a private company
   * sends none at all — a stale ticker left on a company that has gone private
   * again would price its options off a market it no longer trades on.
   */
  it('normalises the ticker and sends it only for a public company', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.type(screen.getByRole('textbox', { name: /^Ticker/ }), '  acme  ');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      company_type: 'public',
      ticker: 'ACME',
      expected_term_method: 'simplified',
    });
  });

  it('clears the ticker when the company type goes back to private', async () => {
    const { calls } = mockServer({ settings: makeSettings({ company_type: 'public', ticker: 'ACME' }) });
    const user = userEvent.setup();
    renderTab();

    await user.selectOptions(await awaitLoaded(), 'private');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body?.ticker).toBeNull();
  });

  it('reports the server’s reason when the settings save is rejected', async () => {
    mockServer({ fail: { 'PUT /asc718/settings': problem(422, 'Unknown ticker ACME') } });
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Unknown ticker ACME')).toBeInTheDocument();
  });
});

describe('Asc718Tab — the measurement request', () => {
  /**
   * A grant with no exercise price cannot be measured, so it is dropped rather
   * than sent as a zero strike — which the engine would price as a share award
   * worth the full underlying.
   */
  it('drops a grant that carries no exercise price', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));
    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(grantsOf(calls)).toHaveLength(0);
  });

  it('sends a priced grant with every assumption it was given', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    const grants = card('Option grants');
    await user.type(boxIn(grants, 'Label'), '2026 pool');
    await user.type(boxIn(grants, 'Exercise price'), '12.5');
    await user.type(boxIn(grants, 'Volatility'), '0.45');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(grantsOf(calls)[0]).toMatchObject({
      label: '2026 pool',
      options_granted: 100000,
      exercise_price: 12.5,
      volatility: 0.45,
      risk_free_rate: 0.04,
      expected_term_method: 'simplified',
    });
  });

  /**
   * Blank is "use the default", not zero. Sending `0` for a volatility or an
   * underlying is the difference between the engine falling back to the 409A
   * FMV and it pricing every option at zero.
   */
  it('omits a blank default rather than sending it as zero', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    await user.type(boxIn(card('Option grants'), 'Exercise price'), '10');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    const body = runCall(calls)!.body!;
    expect(body).not.toHaveProperty('default_grant_date_fair_value');
    expect(body).not.toHaveProperty('default_volatility');
    expect(grantsOf(calls)[0]?.volatility).toBeUndefined();
  });

  it('sends the defaults once they are filled in', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    const defaults = card('Default assumptions');
    await user.type(boxIn(defaults, 'Underlying'), '20');
    await user.type(boxIn(defaults, 'Volatility'), '0.4');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(runCall(calls)!.body).toMatchObject({
      default_grant_date_fair_value: 20,
      default_volatility: 0.4,
    });
  });

  /** A value that is not a number is the same as a blank — not `NaN`. */
  it('treats an unparseable assumption as unset', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    await user.type(boxIn(card('Default assumptions'), 'Underlying'), 'twenty');
    await user.type(boxIn(card('Option grants'), 'Exercise price'), '10');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(runCall(calls)!.body).not.toHaveProperty('default_grant_date_fair_value');
  });

  it('carries the ticker on a public run', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.type(screen.getByRole('textbox', { name: /^Ticker/ }), 'acme');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(runCall(calls)!.body).toMatchObject({ company_type: 'public', ticker: 'ACME' });
  });

  it('disables the run button while the measurement is in flight', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      if ((init?.method ?? 'GET') === 'POST') {
        await held;
        return json({ asc718: emptyResult });
      }
      return json(path.endsWith('/settings') ? { settings: null } : {});
    });
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));
    expect(await screen.findByRole('button', { name: 'Computing…' })).toBeDisabled();

    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run ASC 718' })).not.toBeDisabled());
  });

  it('reports a rejected measurement and stays usable', async () => {
    mockServer({ fail: { 'POST /asc718': problem(422, 'Expected term exceeds contractual term') } });
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));
    expect(await screen.findByText('Expected term exceeds contractual term')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run ASC 718' })).not.toBeDisabled());
  });
});

describe('Asc718Tab — award sections', () => {
  it('adds and removes option grants', async () => {
    mockServer();
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();

    const grants = card('Option grants');
    expect(within(grants).getAllByRole('button', { name: 'Remove' })).toHaveLength(1);

    await user.click(within(grants).getByRole('button', { name: 'Add grant' }));
    expect(within(card('Option grants')).getAllByRole('button', { name: 'Remove' })).toHaveLength(2);

    await user.click(within(card('Option grants')).getAllByRole('button', { name: 'Remove' })[0]!);
    await user.click(within(card('Option grants')).getAllByRole('button', { name: 'Remove' })[0]!);
    expect(within(card('Option grants')).getByText('No option grants.')).toBeInTheDocument();
  });

  /**
   * ESPPs and RSUs are public-company awards. A private company must not be
   * able to add one — measuring an ESPP against a 409A FMV is not a thing ASC
   * 718 contemplates, and the engine would take the request.
   */
  it.each([
    ['ESPP (public)', 'Add ESPP', 'ESPP valuation is a public-company award. Switch company type to Public.'],
    ['RSUs (public)', 'Add RSU', 'RSU valuation is a public-company award. Switch company type to Public.'],
  ])('%s cannot be added while the company is private', async (heading, addLabel, notice) => {
    mockServer();
    renderTab();
    await awaitLoaded();

    const section = card(heading);
    expect(within(section).getByText(notice)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: addLabel })).not.toBeInTheDocument();
  });

  it('adds an ESPP offering once the company is public and sends its terms', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    expect(within(card('ESPP (public)')).getByText('No ESPP offerings.')).toBeInTheDocument();
    await user.click(within(card('ESPP (public)')).getByRole('button', { name: 'Add ESPP' }));

    const espp = card('ESPP (public)');
    await user.type(boxIn(espp, 'Label'), 'Q1 offering');
    await user.type(boxIn(espp, 'Grant-date price'), '30');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(runCall(calls)!.body?.espp).toEqual([
      {
        label: 'Q1 offering',
        shares_enrolled: 50000,
        grant_date_price: 30,
        discount_pct: 0.15,
        lookback_months: 12,
        risk_free_rate: 0.03,
      },
    ]);
  });

  it('removes an ESPP offering again', async () => {
    mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.click(within(card('ESPP (public)')).getByRole('button', { name: 'Add ESPP' }));
    await user.click(within(card('ESPP (public)')).getByRole('button', { name: 'Remove' }));
    expect(within(card('ESPP (public)')).getByText('No ESPP offerings.')).toBeInTheDocument();
  });

  /**
   * The three RSU conditions take different inputs, and the payload attaches
   * them conditionally. A performance attainment left on a market-condition
   * award would true the award up on a condition ASC 718 says is never trued
   * up — the charge stands whether or not the market condition is met.
   */
  it('sends a service RSU with no attainment or hurdle attached', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.click(within(card('RSUs (public)')).getByRole('button', { name: 'Add RSU' }));
    await user.type(boxIn(card('RSUs (public)'), 'Market price'), '25');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    expect(runCall(calls)!.body?.rsu).toEqual([
      {
        label: undefined,
        condition: 'service',
        units: 1000,
        market_price: 25,
        vesting_years: 3,
      },
    ]);
  });

  it('attaches the attainment pair only to a performance RSU', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.click(within(card('RSUs (public)')).getByRole('button', { name: 'Add RSU' }));
    await user.selectOptions(
      within(card('RSUs (public)')).getByRole('combobox', { name: /^Condition/ }),
      'performance',
    );
    // The condition switch swaps the fields on screen, which is how an analyst
    // knows the measurement changed.
    expect(boxIn(card('RSUs (public)'), 'Expected attainment')).toBeInTheDocument();
    expect(within(card('RSUs (public)')).queryByRole('textbox', { name: /^Hurdle price/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));
    await waitFor(() => expect(runCall(calls)).toBeDefined());
    const [rsu] = runCall(calls)!.body?.rsu as Array<Record<string, unknown>>;
    expect(rsu).toMatchObject({ expected_attainment: 1, attainment_volatility: 0.25 });
    expect(rsu).not.toHaveProperty('hurdle_price');
  });

  it('attaches the hurdle and risk-free only to a market RSU', async () => {
    const { calls } = mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.click(within(card('RSUs (public)')).getByRole('button', { name: 'Add RSU' }));
    await user.selectOptions(
      within(card('RSUs (public)')).getByRole('combobox', { name: /^Condition/ }),
      'market',
    );
    await user.type(boxIn(card('RSUs (public)'), 'Hurdle price'), '40');
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));

    await waitFor(() => expect(runCall(calls)).toBeDefined());
    const [rsu] = runCall(calls)!.body?.rsu as Array<Record<string, unknown>>;
    expect(rsu).toMatchObject({ condition: 'market', hurdle_price: 40, risk_free_rate: 0.03 });
    expect(rsu).not.toHaveProperty('expected_attainment');
  });

  it('removes an RSU grant again', async () => {
    mockServer();
    const user = userEvent.setup();
    renderTab();
    await goPublic(user);

    await user.click(within(card('RSUs (public)')).getByRole('button', { name: 'Add RSU' }));
    await user.click(within(card('RSUs (public)')).getByRole('button', { name: 'Remove' }));
    expect(within(card('RSUs (public)')).getByText('No RSU grants.')).toBeInTheDocument();
  });
});

describe('Asc718Tab — results', () => {
  const runWith = async (result: Record<string, unknown>) => {
    const server = mockServer({ result });
    const user = userEvent.setup();
    renderTab();
    await awaitLoaded();
    await user.click(screen.getByRole('button', { name: 'Run ASC 718' }));
    await screen.findByRole('heading', { name: 'Results' });
    return server;
  };

  it('shows nothing until a measurement has been run', async () => {
    mockServer();
    renderTab();
    await awaitLoaded();
    expect(screen.queryByRole('heading', { name: 'Results' })).not.toBeInTheDocument();
  });

  it('reports the market feed the underlying came from', async () => {
    await runWith({
      market: {
        ticker: 'ACME',
        underlying: 2500,
        volatility: 0.375,
        source: 'stooq',
        as_of: '2026-06-30',
      },
    });

    expect(screen.getByText('ACME')).toBeInTheDocument();
    expect(screen.getByText(/\$25\.00/)).toBeInTheDocument();
    expect(screen.getByText(/37\.5%/)).toBeInTheDocument();
    expect(screen.getByText(/\(stooq\)/)).toBeInTheDocument();
  });

  /**
   * A stale or partial feed is worse than none, because the number still
   * renders. The warning has to be next to it.
   */
  it('shows the feed’s own warning alongside the price', async () => {
    await runWith({
      market: {
        ticker: 'ACME',
        underlying: null,
        volatility: null,
        source: 'cache',
        as_of: null,
        warning: 'last close is 6 days old',
      },
    });

    expect(screen.getByText(/last close is 6 days old/)).toBeInTheDocument();
    // Nothing is invented for the missing figures.
    expect(screen.getByText(/underlying —/)).toBeInTheDocument();
  });

  it('tabulates the option grants and their total cost', async () => {
    await runWith({
      options: {
        totalCompensationCost: 250000,
        grants: [
          {
            label: '2026 pool',
            fairValuePerOption: 450,
            totalCompensationCost: 200000,
            expectedToVestOptions: 44000,
          },
          {
            label: null,
            fairValuePerOption: 300,
            totalCompensationCost: 50000,
            expectedToVestOptions: 16000,
          },
        ],
        expenseByYear: [],
      },
    });

    expect(screen.getByRole('heading', { name: /Options — total cost \$2,500\.00/ })).toBeInTheDocument();
    const row = screen.getByText('2026 pool').closest('tr')!;
    expect(within(row).getByText('$4.50')).toBeInTheDocument();
    expect(within(row).getByText('44,000')).toBeInTheDocument();
    // An unlabelled grant is numbered rather than left blank.
    expect(screen.getByText('Grant 2')).toBeInTheDocument();
  });

  it('breaks an ESPP into its discount, call and put components', async () => {
    await runWith({
      espp: [
        {
          label: null,
          shares_enrolled: 50000,
          fair_value_per_share: 900,
          total_fair_value: 4500000,
          components: { purchaseDiscount: 450, callComponent: 350, putComponent: 100 },
        },
      ],
    });

    const row = screen.getByText('ESPP 1').closest('tr')!;
    expect(within(row).getByText('$9.00')).toBeInTheDocument();
    expect(within(row).getByText('$4.50')).toBeInTheDocument();
    expect(within(row).getByText('$3.50')).toBeInTheDocument();
    expect(within(row).getByText('$1.00')).toBeInTheDocument();
    expect(within(row).getByText('$45,000.00')).toBeInTheDocument();
  });

  it('shows each RSU condition with the ratio that belongs to it', async () => {
    await runWith({
      rsu: [
        {
          label: 'Service grant',
          condition: 'service',
          units: 1000,
          fairValuePerUnit: 2500,
          totalFairValue: 2500000,
        },
        {
          label: 'PSU',
          condition: 'performance',
          units: 500,
          fairValuePerUnit: 2500,
          expectedPayoutRatio: 0.8,
          totalFairValue: 1000000,
        },
        {
          label: 'Market PSU',
          condition: 'market',
          units: 250,
          probabilityMet: 0.45,
        },
      ],
    });

    expect(within(screen.getByText('PSU').closest('tr')!).getByText(/performance \(80%\)/)).toBeInTheDocument();
    expect(
      within(screen.getByText('Market PSU').closest('tr')!).getByText(/market \(P=45%\)/),
    ).toBeInTheDocument();
    // An award the engine could not measure shows a dash, not a zero.
    expect(within(screen.getByText('Market PSU').closest('tr')!).getAllByText('—')).toHaveLength(2);
  });

  it('tabulates relative-TSR awards and explains what they are', async () => {
    const user = userEvent.setup();
    await runWith({
      tsr: [
        {
          label: null,
          target_units: 10000,
          fairValuePerUnit: 3200,
          expectedPayoutRatio: 1.15,
          expectedPercentile: 62,
          totalFairValue: 36800000,
        },
      ],
    });

    const row = screen.getByText('TSR 1').closest('tr')!;
    expect(within(row).getByText('10,000')).toBeInTheDocument();
    expect(within(row).getByText('$32.00')).toBeInTheDocument();
    expect(within(row).getByText('62')).toBeInTheDocument();
    expect(within(row).getByText('115%')).toBeInTheDocument();

    // Hover, not click: `InfoTooltip` opens on mouse-enter and its click
    // handler toggles, so a click arrives as open-then-closed.
    await user.hover(screen.getByRole('button', { name: 'About relative TSR' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/never trued up/);
  });

  /** The result's own currency wins over the valuation's. */
  it('formats the results in the currency the measurement came back in', async () => {
    await runWith({
      currency: 'GBP',
      options: {
        totalCompensationCost: 100000,
        grants: [
          {
            label: 'UK pool',
            fairValuePerOption: 200,
            totalCompensationCost: 100000,
            expectedToVestOptions: 500,
          },
        ],
        expenseByYear: [],
      },
    });

    expect(screen.getByRole('heading', { name: /Options — total cost £1,000\.00/ })).toBeInTheDocument();
  });
});
