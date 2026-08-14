import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  AccountingConnect,
  type AccountingProviderStatus,
} from '../src/components/valuation/AccountingConnect';

/**
 * The integrations panel's failures and its other three connection states.
 *
 * The load failure is the one that found a bug — see "a load that fails".
 */

const VAL_ID = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const connected = (over: Record<string, unknown> = {}): AccountingProviderStatus =>
  ({
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
      ...(over.connection as Record<string, unknown>),
    },
    ...over,
  }) as AccountingProviderStatus;

function mockApi(opts: { providers?: AccountingProviderStatus[]; listStatus?: number } = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (method === 'GET' && path.includes('/accounting')) {
      if (opts.listStatus && opts.listStatus !== 200) return jsonResponse({ title: 'nope' }, opts.listStatus);
      return jsonResponse({ providers: opts.providers ?? [connected()] });
    }
    if (method === 'DELETE') return jsonResponse({});
    if (path.includes('/import')) return jsonResponse({ imported: {} });
    if (path.includes('/connect')) return jsonResponse({ authorize_url: 'https://x.example/oauth' });
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return calls;
}

const renderComponent = (initialEntry = '/') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AccountingConnect valuationId={VAL_ID} />
    </MemoryRouter>,
  );

describe('AccountingConnect — edges', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * A failed load returned null, so the whole section vanished — and with it
   * the message the catch had just written. An accounting panel that is simply
   * not on the page reads as this deployment not offering the integrations,
   * which is a different claim from "the request failed".
   */
  it('stays on the page and says so when the list cannot be loaded', async () => {
    mockApi({ listStatus: 500 });
    renderComponent();

    expect(await screen.findByText('Could not load accounting connections.')).toBeInTheDocument();
    // The heading stays, so the reader knows which part of the tab is missing.
    expect(screen.getByText('Accounting integrations')).toBeInTheDocument();
  });

  it('renders nothing at all before the first response', () => {
    mockApi();
    const { container } = renderComponent();
    expect(container).toBeEmptyDOMElement();
  });

  describe('a connection in trouble', () => {
    it('marks a connection the provider has stopped honouring as an error', async () => {
      mockApi({
        providers: [connected({ connection: { status: 'error', last_error: 'token refresh rejected' } })],
      });
      renderComponent();

      expect(await screen.findByText('Error')).toBeInTheDocument();
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
      // Still connected enough to disconnect and to retry an import — the whole
      // point of showing the state rather than dropping the card.
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import financials' })).toBeInTheDocument();
    });

    it('treats a revoked connection as no connection, and offers Connect again', async () => {
      mockApi({ providers: [connected({ connection: { status: 'revoked' } })] });
      renderComponent();

      expect(await screen.findByText('Not connected')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    });

    it('names when the last import ran', async () => {
      mockApi({
        providers: [connected({ connection: { last_import_at: '2026-07-04T09:30:00Z' } })],
      });
      renderComponent();
      expect(await screen.findByText(/Last import/)).toBeInTheDocument();
    });

    it('leaves out the organisation line when the provider named none', async () => {
      mockApi({ providers: [connected({ connection: { external_org_name: null } })] });
      renderComponent();
      await screen.findByText('Xero');
      expect(screen.queryByText('Acme Ltd')).not.toBeInTheDocument();
    });
  });

  describe('the actions', () => {
    it('reports why an import was refused, in the API’s own words', async () => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const path = String(url);
        if (path.includes('/import'))
          return new Response(JSON.stringify({ title: 'No published P&L for the period' }), {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          });
        return jsonResponse({ providers: [connected()] });
      });
      renderComponent();
      await screen.findByText('Xero');

      await user.click(screen.getByRole('button', { name: 'Import financials' }));
      expect(await screen.findByText('No published P&L for the period')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Import financials' })).not.toBeDisabled(),
      );
    });

    it('falls back to its own words when an import fails without a message', async () => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/import')) throw new TypeError('Failed to fetch');
        return jsonResponse({ providers: [connected()] });
      });
      renderComponent();
      await screen.findByText('Xero');

      await user.click(screen.getByRole('button', { name: 'Import financials' }));
      expect(await screen.findByText('Import failed.')).toBeInTheDocument();
    });

    it('disconnects and re-reads the list rather than assuming it worked', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderComponent();
      await screen.findByText('Xero');

      await user.click(screen.getByRole('button', { name: 'Disconnect' }));
      await waitFor(() => {
        expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
        expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
      });
    });

    it('says so when the disconnect does not land', async () => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (init?.method === 'DELETE') throw new TypeError('Failed to fetch');
        return jsonResponse({ providers: [connected()] });
      });
      renderComponent();
      await screen.findByText('Xero');

      await user.click(screen.getByRole('button', { name: 'Disconnect' }));
      expect(await screen.findByText('Could not disconnect.')).toBeInTheDocument();
    });

    it('reports a connection that could not be started for any other reason', async () => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/connect')) throw new TypeError('Failed to fetch');
        return jsonResponse({ providers: [connected({ connection: null })] });
      });
      renderComponent();
      await screen.findByText('Xero');

      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByText('Could not start the connection.')).toBeInTheDocument();
    });
  });

  describe('the OAuth redirect it lands back on', () => {
    it.each([
      ['denied', 'Connection to xero was cancelled.'],
      ['error', 'Connecting to xero failed — please try again.'],
    ])('reports a %s outcome', async (outcome, message) => {
      mockApi();
      renderComponent(`/?accounting=${outcome}&provider=xero`);
      expect(await screen.findByText(message)).toBeInTheDocument();
    });

    it('says something legible when the callback names no provider', async () => {
      mockApi();
      renderComponent('/?accounting=connected');
      expect(
        await screen.findByText('Connected to the provider — you can import financials now.'),
      ).toBeInTheDocument();
    });

    it('says nothing at all on a plain visit', async () => {
      mockApi();
      renderComponent('/');
      await screen.findByText('Xero');
      expect(screen.queryByText(/you can import financials now/)).not.toBeInTheDocument();
    });
  });
});
