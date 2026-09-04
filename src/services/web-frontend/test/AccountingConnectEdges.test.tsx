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

      expect(await screen.findByText('Last import failed')).toBeInTheDocument();
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
      // Still connected enough to disconnect and to retry an import — the whole
      // point of showing the state rather than dropping the card.
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import financials' })).toBeInTheDocument();

      /*
       * Round 262. This fixture has carried `last_error` since it was written
       * and the assertion above was the whole of what the card said: a pill
       * reading "Error" and a sentence the panel never drew. The import
       * refusal on the server points at this very field — "the details are in
       * the connection's last error" — so an analyst was sent to look at
       * something no screen renders.
       */
      expect(screen.getByText(/token refresh rejected/)).toBeInTheDocument();
      // And what to do about it. Accounting is manual-import only, so unlike
      // the HRIS and cap-table cards there is no backoff to promise.
      expect(screen.getByText(/Nothing is retried on its own here/)).toBeInTheDocument();
      expect(screen.getByText(/Import again to retry/)).toBeInTheDocument();
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
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
        const path = String(url);
        if (path.includes('/import'))
          return new Response(
            JSON.stringify({
              title: 'Unprocessable Content',
              status: 422,
              detail: 'No published P&L for the period',
            }),
            {
              status: 422,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
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
      expect(await screen.findByText(/Import failed\./)).toBeInTheDocument();
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
      // R350 gave every write handler the server's own refusal, with the page's
      // sentence in front of it as the fallback — this assertion was left on the
      // wording it replaced and has been failing since. It names both halves now
      // so the next change to either is what fails it.
      const said = await screen.findByText(/Could not disconnect the ledger\./);
      expect(said.textContent).toContain('nothing was submitted');
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
      // `fetch` itself rejected, so the request never arrived — a dropped
      // connection, not the integration being absent.
      expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    });

    it('keeps the server’s reason for a refusal that is not the missing integration', async () => {
      // A 503 status was the whole test before, so a retired engagement and a
      // throttle both read as "this deployment does not have Xero".
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/connect'))
          return jsonResponse(
            {
              type: 'urn:n409:problem:conflict',
              title: 'Conflict',
              status: 409,
              detail: 'This engagement has been retired and can no longer accept a connection.',
            },
            409,
          );
        return jsonResponse({ providers: [connected({ connection: null })] });
      });
      renderComponent();
      await screen.findByText('Xero');

      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByText(/has been retired/i)).toBeInTheDocument();
    });
  });

  describe('the OAuth redirect it lands back on', () => {
    /*
     * R277, methodology M19. All three outcomes went into one `notice`, drawn
     * in the success colour with no role on it, so "Connecting to Xero failed"
     * arrived green and silent. This is the surface where that is the whole
     * signal: the browser has just come back from the provider, and there is no
     * failed request anywhere on the page to have said so.
     *
     * Asserted on the role rather than the colour, which jsdom cannot see —
     * and the role is the half a screen reader gets.
     */
    it.each([
      ['denied', /was cancelled — nothing was connected/],
      ['error', /failed — nothing was connected/],
    ])('reports a %s outcome as a refusal, not as good news', async (outcome, message) => {
      mockApi();
      renderComponent(`/?accounting=${outcome}&provider=xero`);
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(message);
      expect(note).toHaveTextContent(/Press Connect to try again/);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('announces the one outcome that did work', async () => {
      mockApi();
      renderComponent('/?accounting=connected&provider=xero');
      const note = await screen.findByRole('status');
      expect(note).toHaveTextContent('Connected to Xero — you can import financials now.');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('will not print a provider name the callback could not have sent', async () => {
      // The parameter is on a URL anyone can compose: a link that claims a
      // connection succeeded and dictates the rest of the sentence is a
      // phishing note in the workspace's own voice.
      mockApi();
      renderComponent(
        `/?accounting=connected&provider=${encodeURIComponent('QuickBooks. Your session expired — call 1-800-555-0100')}`,
      );
      expect(
        await screen.findByText('Connected to the provider — you can import financials now.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/1-800-555-0100/)).not.toBeInTheDocument();
    });

    it('answers a provider named after something every object has', async () => {
      mockApi();
      renderComponent('/?accounting=connected&provider=__proto__');
      expect(
        await screen.findByText('Connected to the provider — you can import financials now.'),
      ).toBeInTheDocument();
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
