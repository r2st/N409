import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  AccountingConnect,
  type AccountingProviderStatus,
} from '../src/components/valuation/AccountingConnect';

const VAL_ID = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const providers: AccountingProviderStatus[] = [
  {
    provider: 'xero',
    label: 'Xero',
    configured: true,
    import_supported: true,
    connection: {
      status: 'connected',
      external_org_name: 'Acme Ltd',
      last_import_at: null,
      last_import_summary: null,
      last_error: null,
    },
  },
  {
    provider: 'quickbooks',
    label: 'QuickBooks',
    configured: true,
    import_supported: true,
    connection: null,
  },
  {
    provider: 'wave',
    label: 'Wave',
    configured: false,
    import_supported: false,
    connection: null,
  },
];

function mockApi(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const key = `${method} ${path.replace(/^.*\/api\/v1/, '')}`;
    for (const [pattern, responder] of Object.entries(overrides)) {
      if (key.includes(pattern)) return responder!();
    }
    if (method === 'GET' && path.includes(`/valuations/${VAL_ID}/accounting`)) {
      return jsonResponse({ providers });
    }
    throw new Error(`unexpected fetch ${key}`);
  });
}

function renderComponent(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AccountingConnect valuationId={VAL_ID} />
    </MemoryRouter>,
  );
}

describe('AccountingConnect (§23)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists all providers with their connection state', async () => {
    mockApi();
    renderComponent();

    expect(await screen.findByText('Xero')).toBeInTheDocument();
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getAllByText('Not connected')).toHaveLength(2);
    // Connected + import-supported provider offers an import action
    expect(screen.getByRole('button', { name: 'Import financials' })).toBeInTheDocument();
  });

  it('flags connect-only providers with a "coming soon" badge (P2-3)', async () => {
    mockApi();
    renderComponent();

    await screen.findByText('Wave');
    // Exactly one provider in the fixture is import-unsupported (Wave), so the
    // honesty badge must appear exactly once — not on Xero or QuickBooks.
    expect(screen.getAllByText('Connect only — import coming soon')).toHaveLength(1);
  });

  it('starts the OAuth flow via the authorize URL', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/quickbooks/connect': () =>
        jsonResponse({ authorize_url: 'https://appcenter.intuit.com/connect/oauth2?x=1' }),
    });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);

    renderComponent();
    await screen.findByText('QuickBooks');
    await user.click(screen.getAllByRole('button', { name: /Connect/ })[0]!);

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://appcenter.intuit.com/connect/oauth2?x=1');
    });
  });

  it('runs an import and reports success', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/xero/import': () =>
        jsonResponse({ imported: { revenue_cents: 100, prior_year_revenue_cents: 80 } }),
    });
    renderComponent();
    await screen.findByText('Xero');

    await user.click(screen.getByRole('button', { name: 'Import financials' }));
    expect(
      await screen.findByText(
        'Financials imported \u2014 this year\u2019s and last year\u2019s revenue were updated from the P&L.',
      ),
    ).toBeInTheDocument();
  });

  /*
   * R414 (M5). The route writes `ytd_revenue_cents` only when `revenue_cents`
   * is not null and `last_year_revenue_cents` only when
   * `prior_year_revenue_cents` is not null, so both null means the params patch
   * is empty and `patchParamsWithin` is never called. The request still answers
   * 200 — the balance sheet and the snapshot landed — and the panel said the
   * revenue params had been updated from the P&L regardless.
   */
  it('does not claim the revenue params moved when the P&L carried no total', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/xero/import': () =>
        jsonResponse({ imported: { revenue_cents: null, prior_year_revenue_cents: null } }),
    });
    renderComponent();
    await screen.findByText('Xero');

    await user.click(screen.getByRole('button', { name: 'Import financials' }));
    expect(
      await screen.findByText(
        'Financials imported, but no revenue figure came through \u2014 the P&L carried no total this ' +
          'import could read, so the revenue params are unchanged.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/revenue params were updated/)).not.toBeInTheDocument();
  });

  /*
   * `parseQuickBooksProfitAndLoss` returns `prior_year_revenue_cents: null`
   * unconditionally — the provider does not give us the comparative column — so
   * the old sentence was never true of a QuickBooks import.
   */
  it('says the prior-year figure did not come through', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/xero/import': () =>
        jsonResponse({ imported: { revenue_cents: 100, prior_year_revenue_cents: null } }),
    });
    renderComponent();
    await screen.findByText('Xero');

    await user.click(screen.getByRole('button', { name: 'Import financials' }));
    const note = await screen.findByText(/this year\u2019s revenue was updated from the P&L/);
    expect(note.textContent).toContain('last year\u2019s revenue is unchanged');
  });

  // A build served before the two figures were read must not turn an ordinary
  // import into a claim that nothing came through.
  it('reads a body that carries neither figure as an ordinary import', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/xero/import': () =>
        jsonResponse({ imported: {} }),
    });
    renderComponent();
    await screen.findByText('Xero');

    await user.click(screen.getByRole('button', { name: 'Import financials' }));
    expect(await screen.findByText(/Financials imported/)).toBeInTheDocument();
  });

  /*
   * Round 360 (M5). The server fetches the P&L and the balance sheet
   * separately; a balance sheet it could not read comes back on
   * `balance_sheet_error` with the request still a 200, because the revenue
   * params did update. This panel discarded the body, so the only thing on
   * screen was "Financials imported" — while the engagement was left with no
   * `asset.total_assets`, and the asset approach silently out of the next run.
   */
  it('says which half of the import did not come through', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/xero/import': () =>
        jsonResponse({
          imported: {
            revenue_cents: 100,
            prior_year_revenue_cents: 80,
            balance_sheet_error: 'Xero balance sheet fetch failed (500)',
          },
        }),
    });
    renderComponent();
    await screen.findByText('Xero');

    await user.click(screen.getByRole('button', { name: 'Import financials' }));

    // The import that did happen is still reported as one...
    expect(
      await screen.findByText(
        'Financials imported \u2014 this year\u2019s and last year\u2019s revenue were updated from the P&L.',
      ),
    ).toBeInTheDocument();
    // ...and the gap in it is said out loud, in the alert voice.
    const said = await screen.findByText(
      'Balance sheet not imported — Xero balance sheet fetch failed (500)',
    );
    expect(said).toBeInTheDocument();
    expect(said.closest('[role="alert"]')).not.toBeNull();
  });

  it('surfaces the OAuth redirect outcome from the query string', async () => {
    mockApi();
    renderComponent('/?accounting=connected&provider=xero');
    expect(await screen.findByText('Connected to Xero — you can import financials now.')).toBeInTheDocument();
  });

  it('explains unconfigured providers on 503', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/accounting/wave/connect': () =>
        jsonResponse(
          {
            type: 'urn:n409:problem:accounting-unavailable',
            title: 'Integration not configured',
            status: 503,
            detail: 'Wave is not configured on this deployment',
          },
          503,
        ),
    });
    renderComponent();
    await screen.findByText('Wave');

    const buttons = screen.getAllByRole('button', { name: /Connect/ });
    await user.click(buttons[buttons.length - 1]!);

    expect(
      await screen.findByText('This integration is not configured on this deployment yet.'),
    ).toBeInTheDocument();
  });
});
